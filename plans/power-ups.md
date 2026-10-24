# Power-ups and modifiers

Status: decided, ready to start with phase 1.  See [Decisions](#decisions).

## Goal

Things that happen mid-match and change how a rally plays.  They should add choices ("go for the pickup, or stay home?") and comebacks, without turning the match into luck.

## Decisions

| Question | Decision |
|---|---|
| How players get them | **Pickups** on the board, collected by whoever last touched the ball |
| Activation | **Automatic**, the moment it's collected |
| First set | **Wide paddle, Shield, Multiball** |
| On or off | **A room option, on by default** |
| Multiball goals | **Every ball that goes in counts** toward the goal limit |

## Constraints from the current design

- **Deterministic physics.**  Guests replay the physics between snapshots with the host's seed (`SnapshotBuffer.replay`), the host rewinds for save claims (`claimSave`), and the anti-cheat plan's Edge Function would replay goal clips.  So all power-up state lives in `GameState`, and every spawn or roll uses the seeded PRNG, never `Math.random` or the clock.
- **Pure `physics.ts`.**  Effects are state plus rules inside `step()`, unit tested like the rest.
- **Small snapshots.**  A snapshot is under 300 bytes at 8 players, sent 20 times a second.  Power-up state is a few numbers.
- **Inputs stay as they are.**  Automatic activation needs no new key, touch button or input field.
- **One ball, everywhere.**  `ball`, `lastTouch`, `respawnTicks` and `rally` are single values on `GameState`.  The interpolation, the replay, save detection, bots, the renderer and the snapshot format all assume one ball.  Multiball is in the first set, so that refactor comes first (phase 1).

## Pickups

- **Spawning:** with power-ups on, a token appears on whichever of these comes first:
  - **a volley:** a ball's 6th consecutive hit, and every 6th after that (12, 18, …), counted per ball (`rally`);
  - **the timer:** 8–12 s (seeded) of play with no token on the board.  It only counts down while a ball is in play and the board is empty, so the gap is measured from when the last token was collected or faded.

  At most one token is on the board at a time.  A volley that lands while a token is already out doesn't queue a second one.  Any spawn, by either trigger, rolls a fresh 8–12 s for the timer, so a timed token can't follow a volley token straight away.  The token sits at a seeded random spot between radius 0.25 and 0.65, away from the center where the ball launches and clear of the paddles.  The kind is also rolled: Wide paddle 40%, Shield 35%, Multiball 25%, to be tuned in the sandbox.
- **Collecting:** a ball that passes within its radius plus the token's (0.06) collects it for that ball's last toucher.  A ball nobody has touched yet doesn't collect it: the token stays.  So you earn a pickup by aiming at it.
- **Fading:** an uncollected token fades after 10 s.
- **State:** `pickup: { kind, x, y, ticksLeft } | null`, plus the timer's countdown to the next spawn.  The volley trigger needs nothing extra: it reads each ball's `rally` as the hit happens.

## The first three

### Wide paddle

- **Effect:** the collector's paddle is 1.6× wider for 8 s.  A second pickup while it's active resets the timer rather than stacking.
- **Gate travel:** the paddle stays inside the gate, so a wider paddle has less room to travel.  At 1.6× a paddle covers about 35% of its gate, against 22% normally.
- **Where width is used:** `paddleReach`, the paddle collision, `movePaddle`'s travel, `detectSave`, `claimSave`'s replay and the renderer all take the paddle's width from the gate's state instead of the config.  Both the guest's save detection and the host's check need the same width, and since it's in the state they get it.
- **State:** `wideTicks` per gate.

### Shield

- **Effect:** a glowing arc over the collector's gate.  The next ball that would go into that gate bounces off it like a wall instead, and the shield breaks.  The shield lasts until it's used, or 15 s.
- **Scoring:** a shielded goal isn't a goal: no point, no count toward the limit.
- **Save claims:** a ball bouncing off a shield isn't a goal, so there's nothing to claim.  The pending-goal logic doesn't change.
- **State:** `shieldTicks` per gate (0 for none).

### Multiball

- **Effect:** the ball that collected it splits into three where it is.  The two new ones head ±20° off its heading, at its speed, with the same last toucher.  If there are already 3 balls on the board, the token gives a Wide paddle instead.
- **Goals:** every ball that goes in is a goal: it scores for its own last toucher by the usual rules, flashes the gate, and counts toward the goal limit.  The match ends as soon as the limit is reached, even with balls still in play.
- **Respawn:** the next ball launches only once the last one is gone.  While other balls are still in play, a goal just removes that ball.
- **Rally:** `rally` (speed-ups, the HUD) is per ball.
- **Bots:** a bot chases the ball that reaches its paddle line soonest, among those heading its way.

## Phases

### Phase 1: one ball becomes many (no behavior change)

Done.  `GameState.balls`, per-ball `lastTouch` and `rally`, a `ball` index on `hit` and `goal` events and on save claims, snapshots with `balls` (still reading protocol 1's single `ball`), and `PROTOCOL_VERSION = 2` in `start`.

This is a refactor with no new behavior: every existing test should pass unchanged, apart from how a test builds its state.

- **`GameState`:** `ball`, `lastTouch` and `rally` become `balls: { x, y, vx, vy, lastTouch, rally }[]`.  `respawnTicks` stays global: it means "no balls; launching soon".
- **`step()`:** loops over the balls.  Events gain a `ball` index where it matters (`hit`, `goal`).
- **Snapshot:** `ball: [x, y, vx, vy]` becomes `balls: [x, y, vx, vy, touch, rally][]`.  The parser still accepts the old single-ball shape from an old host, which matters during a deploy.
- **The rest:**
  - `interpolate()` blends ball by ball, by index, and treats a change in ball count as a teleport.
  - `SnapshotBuffer` needs no change beyond the types.
  - `detectSave` checks each ball, and a save claim names its ball: `save: { tick, paddle, ball? }`.  A missing `ball` means 0, so old guests still work.
  - `botInput` picks the ball to chase.
  - The renderer draws and tints each ball.
- **Protocol version:** `start` carries `protocol: 2`.  A client that gets a version newer than its own shows "This match needs a newer version.  Reload to join." instead of drawing a broken board.  Missing means 1.

About a day.

### Phase 2: the sandbox prototype

Done: pickups, the three effects and the sandbox controls.  Tests are in `src/game/powerups.test.ts`.  In a 30-minute game of four Normal bots, about 4.4 tokens appear a minute and about 1.9 are collected.  Most shields run out before a ball comes for them.  Next: tune by playing.

- **Config:** `powerUps: boolean` in `PhysicsConfig`, with pickups and the three effects inside `step()`, all seeded.
- **Drawing:**
  - the token, as a small icon in a ring that fades as it expires;
  - a wide paddle in its normal color, with a brighter edge while the effect lasts;
  - the shield as an arc in the owner's color across the gate;
  - each extra ball tinted by its last toucher, like the main one.
- **Sandbox:** a "Power-ups" checkbox, on by default, plus sliders for the spawn interval, the volley length (6) and the durations, which "Copy config" includes.
- **Tests:**
  - pickups spawn the same way from the same seed;
  - a 6th hit spawns a token, a 6th hit with one already out doesn't, and either kind of spawn restarts the timer;
  - only a touched ball collects;
  - a wide paddle saves a ball a normal one would miss;
  - a shield stops one goal, then breaks;
  - multiball makes three balls, each goal counts, the match ends at the limit mid-multiball, and the respawn waits for the last ball;
  - the replay of a power-up match matches the host's.

About a day, plus time spent playing to tune it.

### Phase 3: online, as a room option

Done: migration `20261025020000_power_ups.sql`, the lobby option and label, the snapshot fields, wide paddles in prediction, saves and the host's checks, Hard bots aiming for tokens, and the looser minimum match length.  Two things differ from the plan below:
- `start` carries the oldest protocol that can play the match (3 with power-ups, 2 without), so old tabs only have to reload for power-up matches.
- Guests' replays take only paddles from snapshots, keeping the effects the physics works out.

- **Migration** (additive):
  - `rooms.power_ups boolean not null default true`;
  - `create_room(name, max_players, goal_limit = 10, power_ups = true)`;
  - `lobby_rooms` gains `power_ups`;
  - GRANTs as usual.
- **Version mismatches:** the physics config for a match comes from the **`start` event** (`powerUps`), not from the room row.  A host still on the old frontend sends a `start` without it, which parses as off, so guests and host agree.  The default only applies to new rooms.
- **Lobby:** a "Power-ups" checkbox in Create room, on by default.  The room list shows it, as "⚡" or "Classic", next to the goal count.
- **Snapshot:** `pickup` as `[kind, x, y, ticksLeft]` or null, plus `wide[]` and `shield[]` per gate.  That's about 40 more bytes at 8 players, under the 300-byte budget with one ball and about 400 with three.  The test that checks the snapshot size grows a multiball case.
- **`finish_match`'s duration check:** it assumes about 1 s per point, which multiball breaks.  With `power_ups`, use 3 s plus 0.3 s per point instead.  It's still enough to stop an instant result.
- **The leaderboard:** one leaderboard for both modes.  If power-ups turn out swingy, add `power_ups` to `match_players` and a filter on the stats screen later.
- **Bots:** Hard bots go for a token when the ball isn't heading their way.  Easy and Normal ignore tokens.
- **Netcode tests:**
  - a guest's replay matches the host's with every effect active;
  - a save claim with a wide paddle stands;
  - a claim on the second ball of a multiball names that ball and stands.
- **Integration:** a power-ups room starts, the flag reaches guests, and a result is recorded.

About a day.

### Later

- **Tune from real play:** in bot games most shields expire unused, and fewer than half the tokens get collected.  Try longer shields or bigger tokens in the sandbox.
- **Separate standings:** if power-ups swing results, record the mode on `match_results` and let the leaderboard filter by it.
- **More power-ups:** Magnet (catch and hold, release when you stop moving or after 1 s), Fast ball, Curve, Shrink others.
- **Anti-cheat Phase 1.5:** goal clips start from a full `GameState`, so they include the power-up state without any extra work.

## Rollout

- **Phase 1** ships on its own.  Players see nothing new, but the format changes, so the `protocol` version and the old-shape parsing have to be in it.
- **Phase 2** is sandbox-only, so the online game is unchanged.
- **Phase 3:** the migration (CI applies it first) is additive, and the old frontend ignores the new column and argument.  Rooms created by old tabs during the deploy default to on, but their hosts play without power-ups and send no `powerUps` flag, so nothing breaks.
