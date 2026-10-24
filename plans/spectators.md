# Spectators

Status: ready to start.

## Goal

The lobby lists matches in progress with a **Watch** button.  A spectator sees the live board unrotated, with names and scores, and then the results screen.  They have no paddle, no input and no seat.

## Do Edge Functions help?

Mostly no.  The work is permissions and data, which Postgres and Realtime already handle:

- **Snapshots** already reach anyone on `room:{id}`.  A spectator only needs the right to read that channel, which is an RLS policy on `realtime.messages`.  An Edge Function can't relay 20 Hz broadcasts any better than Realtime does.
- **Capping spectators per room** can't be done in a channel policy, because it can't count who's connected.  But a `spectators` table with an RPC that refuses the N+1th row, plus a policy that checks the row exists, does it in Postgres.
- **The lineup** for someone arriving mid-match is the one real gap (see below).  Phase 2 of the [anti-cheat plan](anti-cheat.md) has an Edge Function store it in a `matches` row.  If that ships first, spectators read the lineup from there for free.  Otherwise the host rebroadcasts it, which needs no function at all.

So Edge Functions are only a side benefit here, through the anti-cheat work.  They aren't a reason to build spectating one way or another.

## Design

1. **Migration:**
   - A read policy on `realtime.messages` for `room:{id}`: any authenticated user may receive broadcasts on a room whose status is `playing`.  There's no presence and no broadcast permission, and nothing on `room:{id}:input`.  The host-only broadcast policy stays.
   - Show live rooms: either a `live_rooms` view, or a `status` column on `lobby_rooms` with the filter widened.  Both are additive.
   - GRANTs for anything new.
2. **The lineup for late arrivals:** `start` is a one-time event, so someone who joins mid-match never gets the names, colors or goal limit.  The host rebroadcasts a small `lineup` event (the same payload as `start`) every 5 seconds, alongside snapshots.  It's under 1 KB, and adds 0.2 messages a second per viewer.
3. **Presence:** spectators don't track it.  The policy wouldn't let them anyway.  The host builds the roster from Presence, so a spectator showing up there would look like a player.
4. **Lobby:** a "Live now" section with the room name, the players, the score once known, and Watch.
5. **Match screen:**
   - A spectator mode: `myGate = -1`, which the renderer and touch code already handle.
   - No `ClientGame` input, no save claims.
   - A "Watching" label, and a Leave button that drops the channel without touching seats.
6. **Results:** spectators show the same results screen when `end` arrives.
7. **Host gone:** spectators who joined late never saw the host in Presence, so they also leave after a few seconds without snapshots.

## Costs

Realtime counts messages per recipient, so each spectator adds about 20 messages a second (the snapshot rate), the same as a player.  For a prototype, leave it uncapped, or add a soft cap in the client (say 10), and use the `spectators` table if it's ever abused.

## Tests

- **pgTAP:**
  - An unseated user can receive on `room:{id}` while it's playing.
  - They can't while it's waiting or finished.
  - They can't send, track Presence, or join the input topic.
- **Integration:** a third, unseated player watches a running match.  They receive snapshots and the lineup, can't send, and see the results.

## Effort

About half a day.
