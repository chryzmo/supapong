-- Power-ups as a room option.  Run with `npx supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-00000000000a', true),
  ('00000000-0000-0000-0000-00000000000b', true);
insert into public.profiles (id, display_name) values
  ('00000000-0000-0000-0000-00000000000a', 'A'),
  ('00000000-0000-0000-0000-00000000000b', 'B');

create function pg_temp.login(p_uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.room(p_name text) returns uuid language sql as $$
  select id from public.rooms where name = p_name;
$$;
-- Every statement here shares one transaction, so now() never moves.  This
-- puts a room's start `p_seconds` before it.
create function pg_temp.started_ago(p_room uuid, p_seconds numeric) returns void language sql security definer as $$
  update public.rooms set started_at = now() - make_interval(secs => p_seconds) where id = p_room;
$$;
-- A started two-player room (A hosts, B joins), named p_name.
create function pg_temp.started(p_name text, p_power_ups boolean) returns uuid language plpgsql as $$
declare
  v_room uuid;
begin
  perform pg_temp.login('00000000-0000-0000-0000-00000000000a');
  v_room := public.create_room(p_name, 2, 10, p_power_ups);
  perform pg_temp.login('00000000-0000-0000-0000-00000000000b');
  perform public.join_room(v_room);
  perform pg_temp.login('00000000-0000-0000-0000-00000000000a');
  perform public.set_room_status(v_room, 'playing');
  return v_room;
end;
$$;
grant execute on all functions in schema pg_temp to authenticated;

select pg_temp.login('00000000-0000-0000-0000-00000000000a');
set local role authenticated;

-- create_room ------------------------------------------------------------------
select public.create_room('Default', 2);
select is((select power_ups from public.rooms where name = 'Default'), true, 'rooms have power-ups by default');
select public.create_room('Classic', 2, 10, false);
select is((select power_ups from public.rooms where name = 'Classic'), false, 'the creator can turn power-ups off');
select lives_ok(
  $$ select public.create_room(p_name => 'Old call', p_max_players => 2, p_goal_limit => 15) $$,
  'the previous frontend''s call, without the new argument, still works');
select is((select power_ups from public.lobby_rooms where id = pg_temp.room('Classic')), false, 'the lobby shows whether a room has power-ups');
select hasnt_function('public', 'create_room', array['text', 'integer', 'integer'], 'the old three-argument create_room is gone, so calls aren''t ambiguous');

-- finish_match's minimum length ------------------------------------------------------
-- 10 points: a classic match needs 3 + 10 s, one with power-ups 3 + 3 s.
create function pg_temp.ten() returns jsonb language sql as $$
  select '{"00000000-0000-0000-0000-00000000000a": 6, "00000000-0000-0000-0000-00000000000b": 4}'::jsonb;
$$;
grant execute on function pg_temp.ten() to authenticated;

select pg_temp.started('Quick', true);
select pg_temp.started_ago(pg_temp.room('Quick'), 5);
select throws_ok(
  $$ select public.finish_match(pg_temp.room('Quick'), pg_temp.ten()) $$,
  '22023', 'That result came in sooner than the match could have lasted.', 'even with power-ups, a match takes some time');
select pg_temp.started_ago(pg_temp.room('Quick'), 7);
select lives_ok(
  $$ select public.finish_match(pg_temp.room('Quick'), pg_temp.ten()) $$,
  'with power-ups, multiball goals can come 0.3 s a point');

select pg_temp.started('Slow', false);
select pg_temp.started_ago(pg_temp.room('Slow'), 7);
select throws_ok(
  $$ select public.finish_match(pg_temp.room('Slow'), pg_temp.ten()) $$,
  '22023', 'That result came in sooner than the match could have lasted.', 'a classic match still needs a second a point');
select pg_temp.started_ago(pg_temp.room('Slow'), 14);
select lives_ok(
  $$ select public.finish_match(pg_temp.room('Slow'), pg_temp.ten()) $$,
  'a classic match recorded after a second a point');

reset role;
set local role anon;
select throws_ok(
  $$ select public.create_room('Anon', 2, 10, true) $$,
  '42501', null, 'signed-out callers cannot create rooms');

select * from finish();
rollback;
