-- Lobby schema, RLS and RPC tests.  Run with `npx supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(46);

-- Five players: A hosts, B-E join.
insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-00000000000a', true),
  ('00000000-0000-0000-0000-00000000000b', true),
  ('00000000-0000-0000-0000-00000000000c', true),
  ('00000000-0000-0000-0000-00000000000d', true),
  ('00000000-0000-0000-0000-00000000000e', true);
insert into public.profiles (id, display_name) values
  ('00000000-0000-0000-0000-00000000000a', 'A'),
  ('00000000-0000-0000-0000-00000000000b', 'B'),
  ('00000000-0000-0000-0000-00000000000c', 'C'),
  ('00000000-0000-0000-0000-00000000000d', 'D'),
  ('00000000-0000-0000-0000-00000000000e', 'E');

-- Act as a signed-in player: set the JWT claims auth.uid() reads, then drop
-- to the authenticated role so RLS applies.
create function pg_temp.login(p_uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.room() returns uuid language sql as $$
  select id from public.rooms where name = 'Test room';
$$;
grant execute on all functions in schema pg_temp to authenticated, anon;

-- create_room ------------------------------------------------------------------
select pg_temp.login('00000000-0000-0000-0000-00000000000a');
set local role authenticated;

select lives_ok($$ select public.create_room('  Test room  ', 3) $$, 'host can create a room');
select is((select name from public.rooms where id = pg_temp.room()), 'Test room', 'room name is trimmed');
select is(
  (select seat from public.room_players where room_id = pg_temp.room() and player_id = auth.uid()),
  0, 'host is seated at seat 0');
select throws_ok(
  $$ insert into public.rooms (name, host_id, max_players) values ('Spoof', '00000000-0000-0000-0000-00000000000b', 2) $$,
  '42501', null, 'cannot create a room hosted by someone else');

-- join_room --------------------------------------------------------------------
select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select is(public.join_room(pg_temp.room()), 1, 'second player gets seat 1');
select is(public.join_room(pg_temp.room()), 1, 'joining again returns the same seat');
select throws_ok(
  $$ insert into public.room_players (room_id, player_id, seat) values (pg_temp.room(), auth.uid(), 5) $$,
  '42501', null, 'cannot insert a seat directly');

select pg_temp.login('00000000-0000-0000-0000-00000000000c');
select is(public.join_room(pg_temp.room()), 2, 'third player gets seat 2');

select results_eq(
  $$ select player_count, max_players from public.lobby_rooms where id = pg_temp.room() $$,
  $$ values (3, 3) $$, 'lobby_rooms shows 3/3');

select pg_temp.login('00000000-0000-0000-0000-00000000000d');
select throws_ok($$ select public.join_room(pg_temp.room()) $$, 'P0001', 'That room is full.', 'cannot join a full room');

-- Leaving and removing ---------------------------------------------------------
select pg_temp.login('00000000-0000-0000-0000-00000000000b');
delete from public.room_players where player_id = '00000000-0000-0000-0000-00000000000c';
select is(
  (select count(*)::int from public.room_players where player_id = '00000000-0000-0000-0000-00000000000c'),
  1, 'a player cannot remove someone else');
delete from public.room_players where room_id = pg_temp.room() and player_id = auth.uid();
select is(
  (select count(*)::int from public.room_players where player_id = auth.uid()),
  0, 'a player can leave');

select pg_temp.login('00000000-0000-0000-0000-00000000000d');
select is(public.join_room(pg_temp.room()), 1, 'the lowest free seat is reused');

select pg_temp.login('00000000-0000-0000-0000-00000000000a');
delete from public.room_players where player_id = '00000000-0000-0000-0000-00000000000c';
select is(
  (select count(*)::int from public.room_players where player_id = '00000000-0000-0000-0000-00000000000c'),
  0, 'the host can remove a player');

-- set_room_status --------------------------------------------------------------
select pg_temp.login('00000000-0000-0000-0000-00000000000d');
select throws_ok(
  $$ update public.rooms set status = 'finished' where id = pg_temp.room() $$,
  '42501', null, 'rooms cannot be updated directly');
select throws_ok(
  $$ select public.set_room_status(pg_temp.room(), 'playing') $$,
  '42501', null, 'only the host can change status');

select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select lives_ok($$ select public.set_room_status(pg_temp.room(), 'playing') $$, 'host can start the match');
select throws_ok(
  $$ select public.set_room_status(pg_temp.room(), 'waiting') $$,
  'P0001', null, 'status cannot move backwards');
select is((select count(*)::int from public.lobby_rooms where id = pg_temp.room()), 0, 'playing rooms leave the lobby');

select pg_temp.login('00000000-0000-0000-0000-00000000000e');
select throws_ok(
  $$ select public.join_room(pg_temp.room()) $$,
  'P0001', 'That match has already started.', 'cannot join a match in progress');

-- match_results ----------------------------------------------------------------
-- 'Test room' is playing with A (host) in seat 0 and D in seat 1.
select pg_temp.login('00000000-0000-0000-0000-00000000000d');
select throws_ok(
  $$ select public.finish_match(pg_temp.room(), '{"00000000-0000-0000-0000-00000000000a": 0, "00000000-0000-0000-0000-00000000000d": 9}') $$,
  '42501', null, 'only the host can record the result');

select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select throws_ok(
  $$ insert into public.match_results (room_id, scores) values (pg_temp.room(), '{}') $$,
  '42501', null, 'results cannot be inserted directly, even by the host');
select lives_ok(
  $$ select public.finish_match(pg_temp.room(), '{"00000000-0000-0000-0000-00000000000a": 3, "00000000-0000-0000-0000-00000000000d": 1}') $$,
  'the host records the result');
select is((select status from public.rooms where id = pg_temp.room()), 'finished', 'recording the result finishes the room');

-- Deleting the room clears its seats but keeps its result ------------------------
create temp table deleted_room as select pg_temp.room() as id;
grant select on deleted_room to authenticated;
delete from public.rooms where id = pg_temp.room();
select is(
  (select count(*)::int from public.room_players where room_id = (select id from deleted_room)),
  0, 'deleting a room removes its seats');
select is(
  (select count(*)::int from public.match_results where room_id is null and scores ? '00000000-0000-0000-0000-00000000000d'),
  1, 'deleting a room keeps its result');

-- Room constraints ---------------------------------------------------------------
select throws_ok($$ select public.create_room('Solo', 1) $$, '23514', null, 'rooms need at least 2 players');
select throws_ok($$ select public.create_room('Crowd', 9) $$, '23514', null, 'rooms allow at most 8 players');
select throws_ok($$ select public.create_room('   ', 4) $$, '23514', null, 'room names cannot be blank');
select throws_ok($$ select public.create_room(repeat('x', 33), 4) $$, '23514', null, 'room names are at most 32 characters');
select lives_ok($$ select public.create_room(repeat('x', 32), 4) $$, '32-character room names are allowed');

-- Missing rooms ------------------------------------------------------------------
select throws_ok(
  $$ select public.join_room('00000000-0000-0000-0000-000000000000') $$,
  'P0002', 'That room no longer exists.', 'joining a missing room says so');
select throws_ok(
  $$ select public.set_room_status('00000000-0000-0000-0000-000000000000', 'playing') $$,
  'P0002', 'That room no longer exists.', 'changing a missing room says so');

-- More status transitions --------------------------------------------------------
select public.create_room('Second room', 4);
create function pg_temp.second() returns uuid language sql as $$
  select id from public.rooms where name = 'Second room';
$$;
grant execute on function pg_temp.second() to authenticated, anon;

select lives_ok($$ select public.set_room_status(pg_temp.second(), 'finished') $$, 'host can finish a room without starting it');
select throws_ok(
  $$ select public.set_room_status(pg_temp.second(), 'playing') $$,
  'P0001', null, 'finished rooms cannot restart');
select is((select count(*)::int from public.lobby_rooms where id = pg_temp.second()), 0, 'finished rooms leave the lobby');

reset role;
insert into public.match_results (room_id, scores) values (pg_temp.second(), '{"a": 3}');
set local role authenticated;

select pg_temp.login('00000000-0000-0000-0000-00000000000b');
delete from public.rooms where id = pg_temp.second();
select is((select count(*)::int from public.rooms where id = pg_temp.second()), 1, 'only the host can delete a room');
select is(
  (select scores from public.match_results where room_id = pg_temp.second()),
  '{"a": 3}'::jsonb, 'anyone signed in can read match results');

-- Stale rooms --------------------------------------------------------------------
reset role;
insert into public.rooms (name, host_id, max_players, created_at)
values ('Stale room', '00000000-0000-0000-0000-00000000000a', 4, now() - interval '2 hours');
set local role authenticated;
select is((select count(*)::int from public.lobby_rooms where name = 'Stale room'), 0, 'rooms older than an hour are hidden from the lobby');
select is((select count(*)::int from public.lobby_rooms where name = repeat('x', 32)), 1, 'recent waiting rooms are listed');

-- A token without a user id -------------------------------------------------------
select set_config('request.jwt.claims', '{"role": "authenticated"}', true);
select throws_ok(
  $$ select public.join_room(pg_temp.second()) $$,
  '28000', 'Not signed in.', 'join_room requires a user id');

-- Signed-out callers -------------------------------------------------------------
reset role;
set local role anon;
select throws_ok(
  $$ select public.join_room('00000000-0000-0000-0000-000000000000') $$,
  '42501', null, 'signed-out callers cannot call join_room');
select throws_ok(
  $$ select public.create_room('Nope', 2) $$,
  '42501', null, 'signed-out callers cannot call create_room');
select throws_ok(
  $$ select public.set_room_status('00000000-0000-0000-0000-000000000000', 'playing') $$,
  '42501', null, 'signed-out callers cannot call set_room_status');
select throws_ok('select count(*) from public.rooms', '42501', null, 'signed-out callers cannot read rooms');
select throws_ok('select count(*) from public.lobby_rooms', '42501', null, 'signed-out callers cannot read the lobby');

select * from finish();
rollback;
