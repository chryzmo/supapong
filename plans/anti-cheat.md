# Anti-cheat with Edge Functions

Status: draft, for discussion.  "Anti-cheat or server-authoritative physics" is a non-goal in CLAUDE.md today, so we'd update that if we go ahead.

## What a cheater can do today

The host's browser runs the match, and the database believes what the host tells it.  Since the leaderboard went in, that matters: a cheater can climb it.

| # | Who | Cheat | How hard |
|---|---|---|---|
| 1 | Host | Calls `finish_match` with any scores it likes.  The RPC only checks that the scores are 2–8 player ids mapped to whole, non-negative numbers. | One call from the console |
| 2 | Host | Gives points to player ids that weren't in the room (any profile), or to more points than the goal limit allows. | Same call |
| 3 | Host | Fakes the match itself: broadcasts states where its gate never concedes, or a guest's paddle misses. | A modified client |
| 4 | Anyone | Farms wins against their own second account: two tabs, two anonymous accounts, one room. | Easy, and legitimate-looking |
| 5 | Guest | Teleports their paddle.  The host adopts the guest's reported position, kept inside the gate, with no check on how far it moved since the last input. | A modified client |
| 6 | Guest | Sends false save claims.  These are limited: the paddle must be within 0.4 s of travel of the host's copy, and the replay must hit. | A modified client, small gain |
| 7 | Anyone | Plays with a bot of their own (an aimbot).  No design can stop this from the outside, only make it statistically visible. | A modified client |

Cheats 1, 2 and 4 are the cheap ones, and they're the ones that matter for the leaderboard.

## What Edge Functions can and can't do here

An Edge Function is a short-lived request handler: a request comes in, it runs a few seconds of TypeScript (Deno), and it returns a response.  At the time of writing, a function gets a few seconds of CPU time per request and a couple of minutes of wall-clock time.  Check the current limits before building on them.

- **Can't: run the match.**  Server-authoritative physics means a process ticking at 60 Hz for the whole match, receiving inputs and broadcasting states.  A 2-minute match plus countdowns is close to the wall-clock limit.  Holding a Realtime connection open from inside a request handler isn't what functions are for.  The function would also run in whichever region it's in, so it would add latency for everyone instead of only for guests.  That job needs a long-running game server (Fly.io, a Durable Object, a VM), which breaks the "no custom backend server" goal.  It's out of scope here.
- **Can: check the match afterwards.**  `physics.ts` is pure and deterministic.  Given the seed, the config and every input, the match replays to the same result.  An Edge Function can import the same file and replay a 2-minute match in a few milliseconds of CPU.  So the host still runs the match live, but the score is only official once a server has replayed it.
- **Can: be the trusted clock and dice.**  A function can issue the match's seed and record when the match really started, so the host can't pick a favorable seed or claim a match that never ran.

The pattern is **trust, then verify**: the live match stays exactly as it is today, with no added latency, and the result is checked by replaying it.

## Plan, in phases

Each phase is useful on its own.  Phase 0 doesn't need Edge Functions at all, and gets most of the value.

### Phase 0.5: inputs come from who they say (no Edge Functions)

Done: migration `20261025010000_player_input_topics.sql`.  This one wasn't in the table above, but it was a real hole: on the shared `room:{id}:input` topic, an input's `seat` was the sender's word, so any seated player could move another's paddle or claim saves in their name.  Each player now sends on their own `room:{id}:input:{player_id}`, which only they can send on and only they and the host can join.  The host takes the seat from the topic.  The shared topic's policies are dropped.

### Phase 0: tighten what the database accepts (no Edge Functions)

Done: migration `20261024200000_result_checks.sql`, and `ADOPT_BURST_SECONDS` in `host.ts`.  It also closed a hole the table above missed: a host could insert a room that was already `playing`, never seat anyone, and record any result for it.  The insert policy now requires a waiting, unstarted room.

Closes cheats 2 and 5, and makes 1 harder.

- **Players:** `finish_match` refuses scores for anyone who isn't seated in the room.  Bots never reach the scores: `scoresByPlayer` drops them already.  Keep a `match_players` snapshot at start (see Phase 2) so a player who left mid-match still counts.
- **Totals:** points in total ≤ `goal_limit`.  Points come from goals, and some goals score for nobody.
- **Duration:** `finish_match` refuses a result sooner than plausible after `set_room_status('playing')`.  That means recording `started_at` on the room, and requiring at least `goal_limit × (respawn delay + launch time)`, or just the countdown plus a few seconds.
- **Paddle speed:** the host caps how far it moves a guest's adopted paddle at what `paddleSpeed` allows since that guest's last input, plus some slack for network jitter.  That's a client change in `HostGame.applyInput`, with a unit test.

### Phase 1: guests confirm the result (no Edge Functions)

Done: migration `20261025000000_result_confirmations.sql`.  Confirmations live in their own table keyed by room, because a guest's report can arrive before the host's result.  Whichever comes second settles `ranked`.  Results from before this migration were kept as ranked.

Closes cheat 1 for matches with an honest guest.

- At `end`, each guest's client calls `confirm_result(result_id, scores)` with the scores it saw.  It already has them, in its own copy of the official snapshots.
- `match_results` gets `confirmations` (who agreed) and a `ranked` boolean.  A result is ranked once more than half the humans, counting the host, agree.  The `leaderboard` view counts only ranked results.  History still shows everything, with an "unconfirmed" tag.
- **Weakness:** this doesn't stop cheat 4, where both accounts belong to the cheater.  A host faking the live match (3) also fools the guests' screens.  Phase 2 is for those.

### Phase 1.5: the server checks every goal (Edge Functions, the showcase version)

A smaller version of Phase 2 that still needs an Edge Function for a real reason.  The check has to run the game's own TypeScript physics, and Postgres can't run that without a port to SQL.  It closes cheat 1 (forged scores) even when no guest confirms, and most of cheat 3 (forged goals).

- **Recording:** for each official goal, the host keeps a goal clip with:
  - the full state 60 ticks (1 s) before the goal;
  - the inputs and accepted saves in that second;
  - the goal tick, gate and scorer.

  At 10 goals that's about 10 small objects, a few KB in all.  `HostGame` already keeps a 15-tick history for save claims, so this extends it.
- **`start-match` function:** the server picks the seed and records the lineup, the config and `started_at` in a `matches` row.  The host can no longer pick a lucky seed.  Spectators can read the lineup from the same row.
- **`finish-match` function:** the host sends its scores and the goal clips.  The function:
  1. replays each clip with `physics.ts` and checks the goal happens at that tick, in that gate, with that last toucher;
  2. checks the clips' scorers add up to the reported scores;
  3. checks the goal count fits the goal limit and the match length fits `started_at`;
  4. writes `match_results` with the service role, `verified` or `unverified` with a reason.
- **Limits:** it doesn't prove that what happened between goals was honest.  A host could still forge a clip with a believable ball path into a guest's gate while the guest's paddle sat elsewhere.  The guests' logs in Phase 2 are what catch that.  But forging clips takes real work, compared with one console call today.
- **Background work:** the function can reply to the host at once and do the replay after responding (`EdgeRuntime.waitUntil`).  Clients learn the outcome through Postgres Changes on `match_results`, which is a nice second showcase of Realtime.
- **Effort:** about a day.  Phase 2 then builds on it rather than replacing it.

### Phase 2: the server deals and replays (Edge Functions)

Closes cheat 3, and limits 4 and 6.

1. **`start-match` function.**  Replaces the host's `set_room_status('playing')` call.
   - **Checks:** that the caller is the host and the lineup matches the seats.
   - **Creates:** a random seed, plus a `matches` row with the seed, the lineup (seats, players, bots and their skill), the goal limit, the physics config and `started_at`.
   - **Returns** the seed.  The host uses it for `createGame` and puts it in the `start` event, so guests know it too.  Guests can check the `matches` row against the `start` event.
2. **Recording.**  During the match the host keeps a compact log:
   - every input change it acted on: `{ tick, gate, dir, paddle? }`, which is the same as the network inputs, plus bot inputs (or just the bot skill, since bots are deterministic given the state);
   - every save claim it accepted;
   - a checkpoint of the full state every second (60 ticks).

   That's a few hundred entries and a few KB of JSON, compressed.
3. **`finish-match` function.**  Replaces the host's `finish_match` RPC call.  The host sends the log.
   - The function replays each checkpoint-to-checkpoint segment with `physics.ts` from the shared source.
   - It checks that the state it arrives at matches the next checkpoint, within a small tolerance, and that every goal in the log happened in the replay.
   - It writes `match_results` with the service role, marked `verified`, or `unverified` with a reason.
4. **Guests' logs.**  At `end`, each guest also sends the function the inputs it sent and the save claims it made.  The function checks that the host's log for that guest's gate matches what the guest says it sent, allowing for clamping and network timing.  A host that invents a guest's misses is caught here.
5. **The leaderboard** counts only verified results.

**Why checkpoints and not one full replay:** the physics is deterministic on the same JavaScript engine, but `Math.sin`, `Math.cos` and `Math.atan2` aren't guaranteed to give identical bits across engines.  A Safari host and a V8 (Deno) verifier can drift apart, and Pong bounces amplify small differences.  Replaying 1-second segments from the host's own checkpoints keeps engine drift tiny.  A forged goal still can't pass, because the ball has to actually go in within a segment.

**Cheat 4 (farming):** no technique can prove two accounts aren't one person.  But `finish-match` can apply ranking rules:
- a minimum account age;
- at most one ranked win a day against the same opponent;
- unranked if every guest's input log looks idle.

The function can also see request IPs, so it could leave a match unranked when all players come from one IP.  That has privacy trade-offs, and it fails on shared networks.  Probably skip it.

### Not covered

- **Aimbots (cheat 7):** any client can automate its own paddle.  The replay logs would let us flag superhuman reaction times later, but that's research, not this plan.
- **Live fairness:** a host can still lag guests on purpose, or show a guest the ball late.  Verification checks the result, not how the match felt.

## Where the shared physics code lives

The Edge Function has to replay with exactly the code the browsers ran.  Options:

- Deno imports `src/game/physics.ts` directly (it's dependency-free TypeScript), with an import path the function bundler accepts.  This needs testing.
- A build step copies `physics.ts` into `supabase/functions/_shared/`, and a test fails if the copies differ.

Either way the function is deployed in the same CI run as the frontend.  A config or physics change has to be versioned: the `matches` row records the config, and a `PHYSICS_VERSION` in the log lets the verifier refuse logs from a newer client than itself.

## Tests

- **Unit:** the replay verifier as a pure module.
  - An honest log from a simulated match verifies.
  - Changing one input, inserting a goal, or editing a checkpoint fails it.
  - Small float noise in checkpoints passes.
- **pgTAP:** the Phase 0 checks, Phase 1's ranking rule, and that only the service role writes `verified`.
- **Integration:** a full match through `start-match` and `finish-match` against the locally served functions, with a guest that confirms and a host that lies.

## Rollout

Every phase is additive and has to work with the frontend that's already deployed:
- Phase 0's checks apply to new results only.
- Phase 1 adds columns, and a view change that existing clients don't notice.
- Phase 2 keeps the old RPC working until the new frontend has been out for a while.  Its results simply stay unranked.  After that the RPC can be dropped in a later migration.

## Effort

- **Phase 0:** a couple of hours.
- **Phase 1:** a couple of hours.
- **Phase 1.5:** about a day.
- **Phase 2:** two or three days on top of 1.5.  Most of that is the recording format, the verifier and its tests, plus sharing the physics code with Deno.

**Recommendation:** do Phases 0 and 1 soon, since they're cheap and close the one-console-call cheats.  For an Edge Functions showcase, Phase 1.5 is the one to build: the function does something only a server can (run the real physics under trusted control), and it's a day of work.  Do Phase 2 only if the leaderboard gets real competition.
