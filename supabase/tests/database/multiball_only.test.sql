-- The multiball-only game type.  Run with `npx supabase test db`.
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
create function pg_temp.mode(p_name text) returns text language sql as $$
  select concat_ws(' ', power_ups, multiball_only) from public.rooms where name = p_name;
$$;
grant execute on all functions in schema pg_temp to authenticated, anon;

select pg_temp.login('00000000-0000-0000-0000-00000000000a');
set local role authenticated;

-- create_room ------------------------------------------------------------------
select public.create_room('Plain', 2);
select is(pg_temp.mode('Plain'), 't f', 'a new room has every power-up');
select public.create_room('Multi', 2, 10, true, 120, true);
select is(pg_temp.mode('Multi'), 't t', 'create_room can make a multiball-only room');
select is(
  (select multiball_only from public.lobby_rooms where name = 'Multi'), true, 'the lobby shows it');
select lives_ok(
  $$ select public.create_room(p_name => 'Old call', p_max_players => 2, p_goal_limit => 10, p_power_ups => false, p_match_seconds => 300) $$,
  'the previous frontend''s call, without the flag, still works');
select is(pg_temp.mode('Old call'), 'f f', 'and leaves the flag off');
select hasnt_function('public', 'create_room', array['text', 'integer', 'integer', 'boolean', 'integer'], 'the old five-argument create_room is gone');

-- set_match_settings ----------------------------------------------------------------
select public.set_match_settings((select id from public.rooms where name = 'Plain'), 10, 120, true, true);
select is(pg_temp.mode('Plain'), 't t', 'the host can switch to multiball only');
select public.set_match_settings(p_room_id => (select id from public.rooms where name = 'Plain'), p_goal_limit => 10, p_match_seconds => 120, p_power_ups => true);
select is(pg_temp.mode('Plain'), 't f', 'the previous frontend''s call, without the flag, switches it back off');
select hasnt_function('public', 'set_match_settings', array['uuid', 'integer', 'integer', 'boolean'], 'the old four-argument set_match_settings is gone');

select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select public.join_room((select id from public.rooms where name = 'Multi'));
select throws_ok(
  $$ select public.set_match_settings((select id from public.rooms where name = 'Multi'), 10, 120, true, false) $$,
  '42501', 'Only the host can change the match settings.', 'guests cannot change it');

select * from finish();
rollback;
