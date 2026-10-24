-- finish_match: validation and transitions.  Run with `npx supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-00000000000a', true),
  ('00000000-0000-0000-0000-00000000000b', true);
insert into public.profiles (id, display_name) values
  ('00000000-0000-0000-0000-00000000000a', 'A'),
  ('00000000-0000-0000-0000-00000000000b', 'B');

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
select is((select status from public.rooms where id = pg_temp.room()), 'playing', 'rejected results leave the match running');

-- Recording ----------------------------------------------------------------------
select isnt(public.finish_match(pg_temp.room(), pg_temp.scores(10, 4)), null, 'finish_match returns the result id');
select is(
  (select scores from public.match_results where room_id = pg_temp.room()),
  pg_temp.scores(10, 4), 'the result stores the scores');
select is((select status from public.rooms where id = pg_temp.room()), 'finished', 'the room is finished');
select throws_ok(
  $$ select public.finish_match(pg_temp.room(), pg_temp.scores(0, 0)) $$,
  'P0001', 'That match isn''t running.', 'a match is recorded only once');

select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select is(
  (select scores from public.match_results where room_id = pg_temp.room()),
  pg_temp.scores(10, 4), 'other players can read the result');

reset role;
set local role anon;
select throws_ok(
  $$ select public.finish_match('00000000-0000-0000-0000-000000000000', '{}') $$,
  '42501', null, 'signed-out callers cannot call finish_match');

select * from finish();
rollback;
