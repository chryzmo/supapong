# Arena Pong (Supabase prototype)

Multiplayer Pong on a circular board.  Each player defends a goal gate on the rim.  When the ball enters your gate, the last player to touch the ball scores a point.  This is a prototype meant to showcase Supabase, so it uses the smallest design that works and saves the rest for later.

## Goals

- Playable end to end: sign in, see a lobby, create or join a room, play a match, see results.
- TypeScript everywhere.  No custom backend server.  Supabase is the backend.
- The code and README should explain *why* each Supabase primitive was chosen.

## Non-goals (for now)

- Board shapes other than a circle
- Real accounts (email, OAuth)
- Dynamic gate resizing while a match is running
- Free-roaming paddles
- Anti-cheat or server-authoritative physics
- Host migration

## Stack

- **Frontend:** Vite + TypeScript (strict), plain Canvas 2D.  No game framework or UI framework.
- **Backend:** Supabase (Auth, Postgres + RLS, Realtime Broadcast and Presence).
- **Client library:** `@supabase/supabase-js` v2.
- **Local dev:** Supabase CLI (`npx supabase start`).  It needs a Docker-compatible runtime.  On Fedora, Podman works if you enable the socket (`systemctl --user enable --now podman.socket`) and set `DOCKER_HOST`.

## Architecture

### Auth

- Use Supabase **anonymous sign-in**.  The player picks a display name, which is stored in `profiles`.
- There is no email or password.  We can convert anonymous users to real accounts later.
- Sign-in is protected by a Cloudflare Turnstile CAPTCHA (`src/captcha.ts`), which Supabase Auth verifies.  The widget only shows for a new sign-in, and only when Cloudflare wants an interaction.  The local stack uses Cloudflare's always-pass test keys, so dev runs the same path.

### Data model (Postgres)

```sql
profiles (
  id uuid primary key references auth.users,
  display_name text not null check (length(display_name) between 1 and 24)
)

rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  host_id uuid not null references profiles,
  max_players int not null check (max_players between 2 and 8),
  goal_limit int not null default 10 check (goal_limit between 1 and 50),  -- goals in total that end the match
  status text not null default 'waiting' check (status in ('waiting','playing','finished')),
  created_at timestamptz default now()
)

room_players (
  room_id uuid references rooms on delete cascade,
  player_id uuid references profiles,
  seat int not null,          -- gate index, assigned on join
  joined_at timestamptz default now(),
  primary key (room_id, player_id),
  unique (room_id, seat)
)

match_results (
  id uuid primary key default gen_random_uuid(),
  room_id uuid unique references rooms on delete set null,  -- results outlive their room
  scores jsonb not null,      -- { player_id: points }
  room_name text,             -- copied at finish, so history outlives the room
  names jsonb not null,       -- { player_id: display_name }, copied at finish
  finished_at timestamptz default now()
)
```

- Put a view or RPC called `lobby_rooms` on top of these.  It returns rooms where `status = 'waiting'` along with `player_count` and `max_players`, so the lobby can show "x/y".
- Two views (`security_invoker`) serve stats.  `match_players` has one row per player per match: `place` (rank, ties shared) and `won` (first place, shared counts, in a match where not everyone tied).  `leaderboard` totals it per player: `matches`, `wins`, `points`, `rank` (by wins, then points).  Names come from the result, so they survive cleanup, and the leaderboard prefers the player's current name.
- Joining happens through a `join_room(room_id)` RPC (`security definer`).  It checks capacity and status, assigns the lowest free seat, and does it all in one transaction so two players can't take the same seat.

### RLS

- `profiles`: anyone authenticated can read.  You can only insert or update your own row.
- `rooms`: anyone authenticated can read.  Insert requires `host_id = auth.uid()`.  The host can delete their room (closing it).  There is no update policy, because RLS can't limit an update to one column.  Status changes go through the `set_room_status(room_id, status)` RPC, which checks the caller is the host and the transition moves forward.
- `room_players`: anyone authenticated can read.  You can delete your own row (leaving), and the room's host can delete any row in their room (removing a disconnected player).  Inserts go only through `join_room`, or `create_room(name, max_players, goal_limit = 10)`, which creates the room and seats the host in one transaction.
- `match_results`: anyone authenticated can read.  No direct inserts: results are written only by the `finish_match(room_id, scores)` RPC (`security definer`), which checks the caller is the host and the room is `playing`, validates the scores, inserts the result (with the room name and players' names from `profiles`) and sets the room to `finished`, all in one transaction.

### Realtime

- Every channel is **private** (Realtime Authorization: RLS policies on `realtime.messages`, checked at join).  The project refuses public channels.
- **Lobby:** subscribe to Postgres Changes on `rooms` and `room_players`, and refetch `lobby_rooms` whenever one fires.  This is simple and the traffic is low.  Any signed-in player can read the `lobby` channel; nobody can broadcast on it.
- **Room channels** `room:{id}` and `room:{id}:input`.  Only seated players can join either.  Policies can't tell broadcast events apart, so traffic is split by sender: only the host may broadcast on `room:{id}`, and inputs go on `room:{id}:input`.
  - **Presence** tracks who is actually connected, keyed by player id, with payload `{ playerId, displayName, seat }`.  When a player has been missing from Presence for a grace period (8 s, so a reload doesn't cost the seat), the host deletes their `room_players` row and broadcasts `removed`.  The host also polls the room's seats every few seconds to catch seats whose player never connected.  If the host is missing for the grace period, the other players leave.
  - **Broadcast `input`** (client → all, on `room:{id}:input`): `{ seat, dir: -1 | 0 | 1 }`.  Send it only when the value changes.  Only the host acts on it.
  - **Broadcast `state`** (host → all, 20 Hz, every 3rd tick): `{ tick, ball: [x, y, vx, vy], paddles[], active[], scores[], goals, touch, respawn, rally }` (`touch` is the last gate to hit the ball, or -1), arrays in gate order, numbers rounded to 4 decimals (under 260 bytes at 8 players).
  - **Broadcast `event`** (host → all): `start` (carries the gate order, `gates: { seat, playerId, displayName, bot? }[]`, and the room's `goalLimit`), `closed` (the host left), `removed` (a player lost their seat), `goal` (`{ gate, scorer? }`, for the flash; `scorer` is left out when nobody got the point) and `end` (`{ scores }`).

### Cleanup

- A `pg_cron` job runs `public.cleanup()` every 15 minutes.  It deletes rooms older than 2 hours (seats cascade, results keep `room_id = null`), anonymous users with no session activity for 7 days, and `cron.job_run_details` older than 7 days.  Only the database owner can call it.

### Host-authoritative simulation

- The room creator's browser runs physics at a fixed 60 Hz and broadcasts snapshots.  Its timer runs in a Web Worker, because browsers throttle page timers in background tabs and a hidden host tab would otherwise freeze the match.  If it falls more than 15 ticks behind, it skips ahead.
- The other clients render 100 ms in the past, interpolating between buffered snapshots.  They only predict their own paddle locally: it moves the moment a key is pressed, and eases toward the host's position once the player stops.
- If the host disconnects, the match ends.  There is no migration in this version.
- **Bots:** in the waiting room the host can add bots, up to 8 gates in total whatever the room's size (so at most 6, since a match needs 2 players), and pick their skill: Easy, Normal or Hard (`BOT_LEVELS` in `bot.ts`, 0.3 / 0.6 / 0.9).  Bots take the lowest seats no player holds (`lineup()` in `room/lineup.ts`), and only exist in the match: they hold no `room_players` row.  The host's loop drives them with `botInput` every tick and ignores network input for their seats.  A match still needs 2 connected players.  Bots score and show on the results screen, but `scoresByPlayer` leaves them out, so stats hold humans only.
- Keep payloads small and rates modest, since Realtime has per-project message quotas.

## Game rules and physics

- The board is a unit circle (radius 1).  All coordinates are normalized and scaled at render time.
- **Gates:** with N seated players at match start, gate *i* is centered at angle `2πi/N`.  Each gate's width is a fixed fraction of its sector, 80% by default (`gateFraction`).  The rim outside the gates is wall.
- If a player leaves mid-match, their gate turns into wall.  Gates are not resized.
- **Paddles:** each paddle is an arc at radius 0.92.  It is centered at angle φ and can only slide within its own gate's angular span.  Input changes φ at a fixed angular speed.
- **Ball:**
  - If it crosses the paddle radius within a paddle's arc, reflect its radial velocity component.  Add tangential "english" based on how far from the paddle's center it hit.
  - If it reaches the rim inside a gate, it's a goal.  The last paddle to touch the ball since the launch gets +1 (`goalScorer` in `physics.ts`).  Nobody scores if no paddle touched it, if it was the conceding player's own touch, or if that player has left.  The goal counts toward the goal limit either way.  The ball respawns at the center after a short delay and launches toward a random point inside a random active gate (a ball's width from its edges), so every launch reaches a paddle before it can touch a wall.
  - If it reaches the rim on a wall, it reflects, turned by a small random angle (`wallJitter`, ±0.09 rad by default) from the game's seeded PRNG.  A plain reflection keeps a ball that passes through the center on the same diameter forever, and with an even number of gates every wall faces another wall, so a launch into a wall could bounce out of everyone's reach for good.
  - It launches at 0.85 radii/s and speeds up 8% after each paddle hit, up to 3.
- A match opens with a 3-second countdown before the first launch.
- The match ends at a fixed time limit (2 minutes) or once a total number of goals has been scored, whoever scored them: a 9-1 match is over at a limit of 10.  It counts goals, not points, because some goals score for nobody.  The room creator picks the limit (5, 10, 15, 20 or 25; default 10).  The host calls `finish_match`, which writes `match_results` and sets the room's `status = 'finished'`.  Everyone sees a results screen: players ranked by score, ties sharing a place (1, 1, 3).

## Frontend

- Screens are plain functions that build DOM elements and return `{ el, dispose }`.  `main.ts` switches between them.  Text goes through `textContent`, never `innerHTML`.
- One stylesheet (`src/style.css`).  Dark theme, with the Supabase green as the accent.
- **Board view:** each player sees the board rotated so their own gate is at the bottom.  Then everyone defends "down", and Left/Right on the keyboard move the paddle left/right on screen.  In world terms, +1 is counterclockwise, which is screen-right at the bottom.  Spectators and the sandbox without a seat get no rotation.
- **Look:** each seat has a fixed color (`SEAT_COLORS` in `render.ts`) for its paddle, gate line and label.  The rim between gates and any abandoned gate are drawn as gray wall.  The ball takes the color of the last paddle to touch it, the player who'd score, and is white before anyone has.  A gate flashes when it concedes, and the scorer's paddle glows.  Names (cut to 10 characters) and scores sit outside the rim, upright.
- **Controls:** ← → or A D.  In the sandbox, Space pauses and R restarts.  On a mobile browser (`isMobileBrowser` in `touch.ts`: Client Hints, then the user agent including iPads posing as Macs, then a touch-only primary pointer), two hold-to-move buttons, ◀ and ▶, sit under the board, or either side of it on a phone held sideways.  They hold pseudo-keys in the same `PaddleInput` as the keyboard.  Spectators get none.  `?touch=1` or `?touch=0` forces them on or off.
- **Leaderboard:** the lobby's Leaderboard button opens the top 10 players (plus your own row if you're further down) and the 10 latest matches, with an All / Mine toggle.
- **Practice:** the sandbox is at `/#sandbox` (no sign-in needed) and behind the lobby's Practice button.  Its "Copy config" button copies the tuned physics settings as JSON for pasting into `DEFAULT_CONFIG`.

## Project layout

```
src/
  main.ts            app entry, screen routing
  supabase.ts        client init (env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)
  auth.ts            anonymous sign-in, profile upsert
  captcha.ts         Turnstile widget, loaded from Cloudflare on demand
  lobby/             lobby screen, room list, create room
  stats/             leaderboard and match history screen
  room/              channel wiring: presence, broadcast send/receive
  game/
    physics.ts       pure functions, no DOM or network; unit tested
    bot.ts           computer paddles (sandbox); pure
    interpolate.ts   blend two states for drawing; pure
    loop.ts          fixed 60 Hz tick + per-frame draw
    input.ts         keyboard (and touch buttons) -> paddle direction
    touch.ts         mobile browser check, on-screen paddle buttons
    sandbox.ts       single-player practice screen with tuning sliders
    snapshot.ts      state <-> `state` message, client snapshot buffer
    host.ts          fixed-step loop, input aggregation, snapshot broadcast
    client.ts        snapshot buffer, interpolation, local paddle prediction
    render.ts        Canvas 2D drawing
  types.ts           shared message and state types
supabase/
  migrations/        schema, RLS, RPCs
  seed.sql
```

## Conventions

- TypeScript `strict`.  No `any`.  Message payloads are typed in `types.ts` and validated at the boundary.
- `physics.ts` is pure and deterministic given its inputs.  Unit test it with Vitest.
- Tests come in three layers:
  - **Unit** (`src/**/*.test.ts`): pure code only.  Don't import `src/supabase.ts` from them.
  - **Database** (`supabase/tests/database/*.test.sql`, pgTAP): RLS, constraints, RPC errors and transitions.
  - **Integration** (`tests/integration/`): real app modules against the local stack, acting as different players via `actAs()`.  Test players get locally signed JWTs instead of anonymous sign-in, to stay under the auth rate limit.
- New behavior gets a test in the lowest layer that can catch it.  `npm run check` must pass before committing.
- All schema changes go in migrations, never ad hoc through the dashboard.
- A migration must work with the frontend that's already deployed, because CI applies it before the new frontend goes out.  Adding things is fine.  To rename or drop something, first ship code that stops using it.
- Keep dependencies minimal.  Ask before adding one.
- Write small commits with clear messages.

## Milestones

1. **Scaffold:** Vite + TypeScript, Supabase local stack, anonymous sign-in, display name.
2. **Lobby:** schema, RLS, `join_room` RPC, live room list with x/y counts, create and join.
3. **Room:** Presence roster, a host "Start" button, a waiting room view.
4. **Local physics:** a single-player sandbox on the circular board to tune feel.  No network yet.
5. **Networked play:** host loop, input and state broadcasts, client interpolation.
6. **Match end:** scoring, results screen, `match_results` written by the host.
7. **README write-up:** architecture diagram, why each Supabase primitive was chosen, known limitations, and what changes at scale.

## Commands

```
npm install                # also enables the pre-commit hook (core.hooksPath = .githooks)
npx supabase start
npx supabase db reset      # apply migrations + seed
npm run dev
npm test                   # unit tests (no network)
npm run test:db            # pgTAP tests in supabase/tests
npm run test:integration   # app code against the local stack
npm run check              # everything above plus typecheck; the pre-commit hook runs this
npm run gen:types          # regenerate src/database.types.ts after a schema change
```

The `Makefile` wraps these, plus deploy targets (`make` lists them).  CI (`.github/workflows/ci.yml`) runs `npm run check` on every push and PR.  On `main`, when it passes, a `migrate` job applies new migrations to the hosted database (`make db-push`), and then a `deploy` job deploys to Cloudflare Pages.  If a migration fails, nothing is deployed.  Deploys read hosted values from `.env.production.local`, and `make build-prod` refuses a build that still points at the local stack.
