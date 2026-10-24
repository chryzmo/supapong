-- Scheduled cleanup.  Run with `npx supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

-- Users: A fresh, B old but with a recent session, C old and idle,
-- D old, idle and not anonymous.
insert into auth.users (id, is_anonymous, created_at) values
  ('00000000-0000-0000-0000-00000000000a', true, now()),
  ('00000000-0000-0000-0000-00000000000b', true, now() - interval '30 days'),
  ('00000000-0000-0000-0000-00000000000c', true, now() - interval '30 days'),
  ('00000000-0000-0000-0000-00000000000d', false, now() - interval '30 days');
insert into auth.sessions (id, user_id, created_at, refreshed_at) values
  (gen_random_uuid(), '00000000-0000-0000-0000-00000000000b', now() - interval '30 days', now() - interval '1 hour'),
  (gen_random_uuid(), '00000000-0000-0000-0000-00000000000c', now() - interval '30 days', now() - interval '8 days');
insert into public.profiles (id, display_name) values
  ('00000000-0000-0000-0000-00000000000a', 'A'),
  ('00000000-0000-0000-0000-00000000000b', 'B'),
  ('00000000-0000-0000-0000-00000000000c', 'C'),
  ('00000000-0000-0000-0000-00000000000d', 'D');

-- Rooms: a fresh one, an old waiting one, and an old finished one with a result.
insert into public.rooms (id, name, host_id, max_players, status, created_at) values
  ('10000000-0000-0000-0000-000000000001', 'Fresh', '00000000-0000-0000-0000-00000000000a', 2, 'waiting', now()),
  ('10000000-0000-0000-0000-000000000002', 'Stale', '00000000-0000-0000-0000-00000000000a', 2, 'waiting', now() - interval '3 hours'),
  ('10000000-0000-0000-0000-000000000003', 'Done', '00000000-0000-0000-0000-00000000000b', 2, 'finished', now() - interval '3 hours');
insert into public.room_players (room_id, player_id, seat) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 0),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 0),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000b', 1);
insert into public.match_results (id, room_id, scores) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', '{"00000000-0000-0000-0000-00000000000b": 3}');

select is(
  public.cleanup(),
  '{"rooms": 2, "users": 1, "job_runs": 0}'::jsonb,
  'cleanup reports what it deleted');

select is(
  array(select name from public.rooms order by name),
  array['Fresh'],
  'rooms older than 2 hours are deleted, whatever their status');
select is(
  (select count(*)::int from public.room_players where room_id = '10000000-0000-0000-0000-000000000002'),
  0, 'seats go with their room');
select ok(
  exists (select 1 from public.match_results where id = '20000000-0000-0000-0000-000000000001' and room_id is null),
  'match results outlive their room');

select ok(exists (select 1 from auth.users where id = '00000000-0000-0000-0000-00000000000a'), 'new anonymous users stay');
select ok(exists (select 1 from auth.users where id = '00000000-0000-0000-0000-00000000000b'), 'anonymous users with a recent session stay');
select ok(not exists (select 1 from auth.users where id = '00000000-0000-0000-0000-00000000000c'), 'idle anonymous users are deleted');
select ok(not exists (select 1 from public.profiles where id = '00000000-0000-0000-0000-00000000000c'), 'their profile goes with them');
select ok(exists (select 1 from auth.users where id = '00000000-0000-0000-0000-00000000000d'), 'non-anonymous users are never deleted');

select is(public.cleanup(), '{"rooms": 0, "users": 0, "job_runs": 0}'::jsonb, 'a second run finds nothing');

select is(
  (select schedule from cron.job where jobname = 'cleanup'),
  '*/15 * * * *', 'cleanup runs every 15 minutes');

select function_privs_are('public', 'cleanup', array[]::text[], 'authenticated', array[]::text[],
  'signed-in players cannot run cleanup');
select function_privs_are('public', 'cleanup', array[]::text[], 'anon', array[]::text[],
  'signed-out callers cannot run cleanup');

select * from finish();
rollback;
