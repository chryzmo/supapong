-- finish_match: validation and transitions.  Run with `npx supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-00000000000a', true),
  ('00000000-0000-0000-0000-00000000000b', true),
  ('00000000-0000-0000-0000-00000000000c', true);
insert into public.profiles (id, display_name) values
  ('00000000-0000-0000-0000-00000000000a', 'A'),
  ('00000000-0000-0000-0000-00000000000b', 'B'),
  ('00000000-0000-0000-0000-00000000000c', 'C');

create function pg_temp.login(p_uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.room() returns uuid language sql as $$
  select id from public.rooms where name = 'Results room';
$$;
-- Scores for A and B, as finish_match expects them.
create function pg_temp.scores(a int, b int) returns jsonb language sql as $$
  select jsonb_build_object('00000000-0000-0000-0000-00000000000a', a, '00000000-0000-0000-0000-00000000000b', b);
$$;
-- Every statement here shares one transaction, so now() never moves and
-- each match would look instant.  This moves its start back instead.
create function pg_temp.backdate(p_room uuid) returns void language sql security definer as $$
  update public.rooms set started_at = started_at - interval '10 minutes' where id = p_room;
$$;
grant execute on all functions in schema pg_temp to authenticated, anon;

select pg_temp.login('00000000-0000-0000-0000-00000000000a');
set local role authenticated;
select public.create_room('Results room', 2);

select throws_ok(
  $$ select public.finish_match(pg_temp.room(), pg_temp.scores(1, 2)) $$,
  'P0001', 'That match isn''t running.', 'a waiting room has no match to finish');

select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select public.join_room(pg_temp.room());
select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select public.set_room_status(pg_temp.room(), 'playing');
select is((select started_at from public.rooms where id = pg_temp.room()), now(), 'starting the match records when');
select is(
  (select starting_players from public.rooms where id = pg_temp.room()),
  array['00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b']::uuid[],
  'starting the match records who was seated');

-- Malformed scores -------------------------------------------------------------
select throws_ok($$ select public.finish_match(pg_temp.room(), '[1, 2]') $$, '22023', null, 'scores must be an object');
select throws_ok(
  $$ select public.finish_match(pg_temp.room(), '{"00000000-0000-0000-0000-00000000000a": 1}') $$,
  '22023', null, 'scores need at least two players');
select throws_ok($$ select public.finish_match(pg_temp.room(), pg_temp.scores(-1, 2)) $$, '22023', null, 'scores cannot be negative');
select throws_ok(
  $$ select public.finish_match(pg_temp.room(), jsonb_build_object('00000000-0000-0000-0000-00000000000a', 1.5, '00000000-0000-0000-0000-00000000000b', 0)) $$,
  '22023', null, 'scores must be whole numbers');
select throws_ok(
  $$ select public.finish_match(pg_temp.room(), '{"00000000-0000-0000-0000-00000000000a": "3", "00000000-0000-0000-0000-00000000000b": 0}') $$,
  '22023', null, 'scores must be numbers');
select throws_ok(
  $$ select public.finish_match(pg_temp.room(), '{"alice": 3, "00000000-0000-0000-0000-00000000000b": 0}') $$,
  '22023', null, 'score keys must be player ids');

-- Implausible scores ---------------------------------------------------------
select throws_ok(
  $$ select public.finish_match(pg_temp.room(), pg_temp.scores(1, 1)) $$,
  '22023', 'That result came in sooner than the match could have lasted.', 'a match takes at least the countdown');
select pg_temp.backdate(pg_temp.room());
select throws_ok(
  $$ select public.finish_match(pg_temp.room(), jsonb_build_object('00000000-0000-0000-0000-00000000000a', 2, '00000000-0000-0000-0000-00000000000c', 1)) $$,
  '22023', 'Scores can only go to players who were in the match.', 'points only go to players in the match');
select throws_ok(
  $$ select public.finish_match(pg_temp.room(), pg_temp.scores(8, 3)) $$,
  '22023', 'The scores add up to more than the match''s 10 goals.', 'points cannot add up to more than the goal limit');
select is((select status from public.rooms where id = pg_temp.room()), 'playing', 'rejected results leave the match running');

-- Rooms only start through set_room_status -------------------------------------
select throws_ok(
  $$ insert into public.rooms (name, host_id, max_players, status) values ('Shortcut', '00000000-0000-0000-0000-00000000000a', 2, 'playing') $$,
  '42501', null, 'a room cannot be created already playing');
select throws_ok(
  $$ insert into public.rooms (name, host_id, max_players, started_at) values ('Backdated', '00000000-0000-0000-0000-00000000000a', 2, now() - interval '1 hour') $$,
  '42501', null, 'a room cannot be created with a start time');
select throws_ok(
  $$ insert into public.rooms (name, host_id, max_players, starting_players) values ('Stacked', '00000000-0000-0000-0000-00000000000a', 2, array['00000000-0000-0000-0000-00000000000c']::uuid[]) $$,
  '42501', null, 'a room cannot be created with its players');

-- Recording ----------------------------------------------------------------------
select isnt(public.finish_match(pg_temp.room(), pg_temp.scores(7, 3)), null, 'finish_match returns the result id');
select is(
  (select scores from public.match_results where room_id = pg_temp.room()),
  pg_temp.scores(7, 3), 'the result stores the scores');
select is((select status from public.rooms where id = pg_temp.room()), 'finished', 'the room is finished');
select throws_ok(
  $$ select public.finish_match(pg_temp.room(), pg_temp.scores(0, 0)) $$,
  'P0001', 'That match isn''t running.', 'a match is recorded only once');

select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select is(
  (select scores from public.match_results where room_id = pg_temp.room()),
  pg_temp.scores(7, 3), 'other players can read the result');

reset role;
set local role anon;
select throws_ok(
  $$ select public.finish_match('00000000-0000-0000-0000-000000000000', '{}') $$,
  '42501', null, 'signed-out callers cannot call finish_match');

select * from finish();
rollback;
