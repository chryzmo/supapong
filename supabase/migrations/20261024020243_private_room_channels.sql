-- Private room channels (Realtime Authorization).
--
-- Room channels used to be public: anyone signed in could see a room id in
-- the lobby, join `room:{id}` and broadcast a fake `closed`, `state` or `end`.
-- Private channels are checked against RLS policies on realtime.messages.
-- Realtime evaluates them once, when a client joins, by trying a select (may
-- receive) and an insert (may send) for the topic, then rolling back.
--
-- Policies can tell broadcast from presence, but not one broadcast event from
-- another.  So the traffic is split by who may send it:
--
--   room:{id}         host broadcasts (state, events); everyone seated
--                     receives them and tracks presence
--   room:{id}:input   seated players send inputs; only the host acts on them
--
-- Everyone seated can also read the input topic, because Realtime only lets
-- a client join a channel it may read.  Seeing other players' inputs reveals
-- nothing the paddles don't.
--
-- Access is decided at join time and cached for the connection, so a player
-- whose seat is removed keeps receiving until their socket rejoins.  That's
-- fine here: the host stops simulating them and they're told to leave.

-- room:{id} ---------------------------------------------------------------------

create policy "seated players can receive room messages"
  on realtime.messages for select
  to authenticated
  using (
    extension in ('broadcast', 'presence')
    and exists (
      select 1 from public.room_players rp
      where rp.player_id = (select auth.uid())
        and 'room:' || rp.room_id = (select realtime.topic())
    )
  );

create policy "seated players can track presence"
  on realtime.messages for insert
  to authenticated
  with check (
    extension = 'presence'
    and exists (
      select 1 from public.room_players rp
      where rp.player_id = (select auth.uid())
        and 'room:' || rp.room_id = (select realtime.topic())
    )
  );

create policy "the host can broadcast to the room"
  on realtime.messages for insert
  to authenticated
  with check (
    extension = 'broadcast'
    and exists (
      select 1 from public.rooms r
      where r.host_id = (select auth.uid())
        and 'room:' || r.id = (select realtime.topic())
    )
  );

-- room:{id}:input ---------------------------------------------------------------

create policy "seated players can send inputs"
  on realtime.messages for insert
  to authenticated
  with check (
    extension = 'broadcast'
    and exists (
      select 1 from public.room_players rp
      where rp.player_id = (select auth.uid())
        and 'room:' || rp.room_id || ':input' = (select realtime.topic())
    )
  );

create policy "seated players can join the input channel"
  on realtime.messages for select
  to authenticated
  using (
    extension = 'broadcast'
    and exists (
      select 1 from public.room_players rp
      where rp.player_id = (select auth.uid())
        and 'room:' || rp.room_id || ':input' = (select realtime.topic())
    )
  );

-- lobby -------------------------------------------------------------------------
-- The lobby channel only carries Postgres Changes, whose rows are filtered by
-- the tables' own RLS.  It goes private too, so the project can turn off
-- public channels entirely.  Read only: nobody broadcasts to the lobby.

create policy "signed-in players can join the lobby"
  on realtime.messages for select
  to authenticated
  using ((select realtime.topic()) = 'lobby');
