-- Explicit table grants.
--
-- Supabase projects created since May 2026 no longer grant anon and
-- authenticated access to new tables in public, so the Data API can't see a
-- table until it gets a GRANT.  The local stack still applies the old
-- defaults, which is why sign-in worked locally and failed on the hosted
-- project with "permission denied for table profiles".
--
-- Grants decide which operations a role may attempt at all; RLS then decides
-- which rows.  So each table gets exactly the operations it has policies for,
-- and only for signed-in players.  Everything else goes through RPCs.

revoke all on public.profiles, public.rooms, public.room_players,
  public.match_results, public.lobby_rooms from anon, authenticated;

grant select, insert, update on public.profiles to authenticated;
grant select, insert, delete on public.rooms to authenticated;
grant select, delete on public.room_players to authenticated;
grant select on public.match_results to authenticated;
grant select on public.lobby_rooms to authenticated;

-- Match the hosted default locally, so a future table without grants fails
-- here first instead of after a deploy.
alter default privileges in schema public
  revoke all on tables from anon, authenticated;
