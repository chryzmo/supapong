-- One input topic per player: room:{id}:input:{player_id}.
--
-- A Broadcast message doesn't carry its sender, so on the shared
-- room:{id}:input topic an input's `seat` was the sender's word: a seated
-- player could move anyone's paddle, or claim saves in their name.  With a
-- topic per player, only that player may send on it, so the host knows whose
-- input arrived from which topic it came on, and ignores the seat inside.
--
-- Who may join a player's topic: that player (to send; Realtime only lets a
-- client join a channel it may read) and the room's host (to receive).
-- Other guests can't, so inputs aren't visible to them either.
--
-- The shared topic goes: nothing may join or send on it.  A tab still on the
-- previous frontend can't send inputs until it reloads.

drop policy "seated players can send inputs" on realtime.messages;
drop policy "seated players can join the input channel" on realtime.messages;

create policy "players can send on their own input topic"
  on realtime.messages for insert
  to authenticated
  with check (
    extension = 'broadcast'
    and exists (
      select 1 from public.room_players rp
      where rp.player_id = (select auth.uid())
        and 'room:' || rp.room_id || ':input:' || rp.player_id = (select realtime.topic())
    )
  );

create policy "players and their host can join a player's input topic"
  on realtime.messages for select
  to authenticated
  using (
    extension = 'broadcast'
    and exists (
      select 1 from public.room_players rp
      join public.rooms r on r.id = rp.room_id
      where 'room:' || rp.room_id || ':input:' || rp.player_id = (select realtime.topic())
        and (rp.player_id = (select auth.uid()) or r.host_id = (select auth.uid()))
    )
  );
