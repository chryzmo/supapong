-- match_players and leaderboard: places, wins, names that outlive their
-- profile.  Run with `npx supabase test db`.
--
-- Other test runs may have left results behind, so every check filters on
-- this file's players.
begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-00000000000a', true),
  ('00000000-0000-0000-0000-00000000000b', true),
  ('00000000-0000-0000-0000-00000000000c', true);
insert into public.profiles (id, display_name) values
  ('00000000-0000-0000-0000-00000000000a', 'Ada'),
  ('00000000-0000-0000-0000-00000000000b', 'Bob'),
  ('00000000-0000-0000-0000-00000000000c', 'Cy');

create function pg_temp.login(p_uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.id(p_letter text) returns uuid language sql as $$
  select ('00000000-0000-0000-0000-00000000000' || p_letter)::uuid;
$$;
-- Every statement here shares one transaction, so now() never moves and
-- each match would look instant.  This moves its start back instead.
create function pg_temp.backdate(p_room uuid) returns void language sql security definer as $$
  update public.rooms set started_at = started_at - interval '10 minutes' where id = p_room;
$$;
-- Plays a match through the real RPCs: the first player (by id) hosts, the
-- rest join, and the host records p_scores ({ letter: points }).
create function pg_temp.play(p_room text, p_scores jsonb) returns uuid language plpgsql as $$
declare
  v_letters text[] := array(select k from jsonb_object_keys(p_scores) k order by k);
  v_room uuid;
  v_letter text;
begin
  perform pg_temp.login(pg_temp.id(v_letters[1]));
  v_room := public.create_room(p_room, 8);
  foreach v_letter in array v_letters[2:] loop
    perform pg_temp.login(pg_temp.id(v_letter));
    perform public.join_room(v_room);
  end loop;
  perform pg_temp.login(pg_temp.id(v_letters[1]));
  perform public.set_room_status(v_room, 'playing');
  perform pg_temp.backdate(v_room);
  return public.finish_match(v_room, (
    select jsonb_object_agg(pg_temp.id(key), value) from jsonb_each(p_scores)
  ));
end;
$$;
-- One player's row in one match, as "place won score", e.g. "1 t 5".
create function pg_temp.row(p_result uuid, p_letter text) returns text language sql as $$
  select concat_ws(' ', place, won, score) from public.match_players
  where result_id = p_result and player_id = pg_temp.id(p_letter);
$$;
grant execute on all functions in schema pg_temp to authenticated, anon;

set local role authenticated;

create temp table played (name text primary key, id uuid) on commit drop;
insert into played values
  ('tie for first', pg_temp.play('First match', '{"a": 4, "b": 4, "c": 2}')),
  ('all tied', pg_temp.play('Second match', '{"a": 0, "b": 0}')),
  ('b wins', pg_temp.play('Third match', '{"a": 1, "b": 9}'));
create function pg_temp.result(p_name text) returns uuid language sql as $$
  select id from played where name = p_name;
$$;
grant execute on function pg_temp.result(text) to authenticated, anon;

-- The record ---------------------------------------------------------------------
select is(
  (select room_name from public.match_results where id = pg_temp.result('tie for first')),
  'First match', 'finish_match records the room name');
select is(
  (select names from public.match_results where id = pg_temp.result('tie for first')),
  jsonb_build_object(pg_temp.id('a'), 'Ada', pg_temp.id('b'), 'Bob', pg_temp.id('c'), 'Cy'),
  'finish_match records every player''s name');

-- match_players ------------------------------------------------------------------
select is(pg_temp.row(pg_temp.result('tie for first'), 'a'), '1 t 4', 'a shared first place is a win');
select is(pg_temp.row(pg_temp.result('tie for first'), 'b'), '1 t 4', 'both players sharing first win');
select is(pg_temp.row(pg_temp.result('tie for first'), 'c'), '3 f 2', 'places skip after a tie (1, 1, 3)');
select is(pg_temp.row(pg_temp.result('all tied'), 'a'), '1 f 0', 'nobody wins when everyone ties');
select is(
  (select player_count from public.match_players where result_id = pg_temp.result('tie for first') limit 1),
  3, 'each row knows how many played');

-- leaderboard --------------------------------------------------------------------
select is(
  (select concat_ws(' ', display_name, matches, wins, points) from public.leaderboard where player_id = pg_temp.id('b')),
  'Bob 3 2 13', 'the leaderboard counts matches, wins and points');
select is(
  (select concat_ws(' ', display_name, matches, wins, points) from public.leaderboard where player_id = pg_temp.id('a')),
  'Ada 3 1 5', 'Ada has one win');
select ok(
  (select rank from public.leaderboard where player_id = pg_temp.id('b'))
    < (select rank from public.leaderboard where player_id = pg_temp.id('a')),
  'more wins rank higher');
select ok(
  (select rank from public.leaderboard where player_id = pg_temp.id('a'))
    < (select rank from public.leaderboard where player_id = pg_temp.id('c')),
  'with equal wins, more points rank higher');

-- Renames and cleanup ------------------------------------------------------------
select pg_temp.login(pg_temp.id('a'));
update public.profiles set display_name = 'Ada L' where id = pg_temp.id('a');
select is(
  (select display_name from public.match_players where result_id = pg_temp.result('tie for first') and player_id = pg_temp.id('a')),
  'Ada', 'history shows the name a player had in that match');
select is(
  (select display_name from public.leaderboard where player_id = pg_temp.id('a')),
  'Ada L', 'the leaderboard shows the current name');

reset role;
delete from auth.users where id = pg_temp.id('c');
set local role authenticated;
select is(
  (select display_name from public.leaderboard where player_id = pg_temp.id('c')),
  'Cy', 'a deleted player keeps their last name on the leaderboard');

reset role;
set local role anon;
select throws_ok($$ select * from public.leaderboard $$, '42501', null, 'signed-out callers cannot read the leaderboard');

select * from finish();
rollback;
