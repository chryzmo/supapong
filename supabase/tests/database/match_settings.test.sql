-- Match length and goal limit, set by the host.  Run with `npx supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

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
  select id from public.rooms where name = 'Settings room';
$$;
create function pg_temp.settings() returns text language sql as $$
  select concat_ws(' ', coalesce(goal_limit::text, 'none'), coalesce(match_seconds::text, 'none')) from public.rooms where id = pg_temp.room();
$$;
-- Every statement here shares one transaction, so now() never moves.
create function pg_temp.backdate(p_room uuid) returns void language sql security definer as $$
  update public.rooms set started_at = started_at - interval '1 hour' where id = p_room;
$$;
grant execute on all functions in schema pg_temp to authenticated, anon;

select pg_temp.login('00000000-0000-0000-0000-00000000000a');
set local role authenticated;
select public.create_room('Settings room', 2);
select is(pg_temp.settings(), '10 120', 'a new room plays to 10 goals or 2 minutes');

-- The host changes them ---------------------------------------------------------
select public.set_match_settings(pg_temp.room(), 15, 600, true);
select is(pg_temp.settings(), '15 600', 'the host can set the goal limit and length');
select public.set_match_settings(pg_temp.room(), null, 300, true);
select is(pg_temp.settings(), 'none 300', 'no goal limit, on time only');
select public.set_match_settings(pg_temp.room(), 20, null, true);
select is(pg_temp.settings(), '20 none', 'no time limit, on goals only');
select public.set_match_settings(pg_temp.room(), 20, null, false);
select is((select power_ups from public.rooms where id = pg_temp.room()), false, 'the host can turn power-ups off');
select is(
  (select concat_ws(' ', goal_limit, coalesce(match_seconds::text, 'none')) from public.lobby_rooms where id = pg_temp.room()),
  '20 none', 'the lobby shows them');

select throws_ok(
  $$ select public.set_match_settings(pg_temp.room(), null, null, true) $$,
  '23514', null, 'something has to end the match');
select throws_ok(
  $$ select public.set_match_settings(pg_temp.room(), 10, 90, true) $$,
  '23514', null, 'lengths are 2, 5 or 10 minutes');
select throws_ok(
  $$ select public.set_match_settings(pg_temp.room(), 51, 120, true) $$,
  '23514', null, 'at most 50 goals');
select throws_ok(
  $$ select public.set_match_settings('00000000-0000-0000-0000-000000000000', 10, 120, true) $$,
  'P0002', 'That room no longer exists.', 'the room has to exist');

select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select public.join_room(pg_temp.room());
select throws_ok(
  $$ select public.set_match_settings(pg_temp.room(), 5, 120, true) $$,
  '42501', 'Only the host can change the match settings.', 'guests cannot change them');

-- Not once it's started -------------------------------------------------------------
select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select public.set_match_settings(pg_temp.room(), null, 600, true);
select public.set_room_status(pg_temp.room(), 'playing');
select throws_ok(
  $$ select public.set_match_settings(pg_temp.room(), 5, 120, true) $$,
  'P0001', 'The match has already started.', 'they are fixed once the match starts');

-- With no goal limit, finish_match takes any number of points ---------------------------------
select pg_temp.backdate(pg_temp.room());
select lives_ok(
  $$ select public.finish_match(pg_temp.room(), '{"00000000-0000-0000-0000-00000000000a": 40, "00000000-0000-0000-0000-00000000000b": 35}') $$,
  'a match with no goal limit can score past 50');

-- create_room ------------------------------------------------------------------
select public.create_room('Long one', 2, 10, true, 600);
select is((select match_seconds from public.rooms where name = 'Long one'), 600, 'create_room can set the length too');
select lives_ok(
  $$ select public.create_room(p_name => 'Old call', p_max_players => 2, p_goal_limit => 10, p_power_ups => false) $$,
  'the previous frontend''s call, without a length, still works');
select hasnt_function('public', 'create_room', array['text', 'integer', 'integer', 'boolean'], 'the old four-argument create_room is gone');

reset role;
set local role anon;
select throws_ok(
  $$ select public.set_match_settings('00000000-0000-0000-0000-000000000000', 10, 120, true) $$,
  '42501', null, 'signed-out callers cannot change settings');

select * from finish();
rollback;
