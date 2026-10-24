-- confirm_result and ranking.  Run with `npx supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

insert into auth.users (id, is_anonymous)
select ('00000000-0000-0000-0000-00000000000' || l)::uuid, true from unnest(array['a', 'b', 'c', 'd', 'e']) l;
insert into public.profiles (id, display_name)
select ('00000000-0000-0000-0000-00000000000' || l)::uuid, upper(l) from unnest(array['a', 'b', 'c', 'd', 'e']) l;

create function pg_temp.id(p_letter text) returns uuid language sql as $$
  select ('00000000-0000-0000-0000-00000000000' || p_letter)::uuid;
$$;
create function pg_temp.login(p_letter text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(p_letter), 'role', 'authenticated')::text, true);
$$;
create function pg_temp.room(p_name text) returns uuid language sql as $$
  select id from public.rooms where name = p_name;
$$;
-- { letter: points } as finish_match and confirm_result take them.
create function pg_temp.scores(p_scores jsonb) returns jsonb language sql as $$
  select jsonb_object_agg(pg_temp.id(key), value) from jsonb_each(p_scores);
$$;
-- Every statement here shares one transaction, so now() never moves and
-- each match would look instant.  This moves its start back instead.
create function pg_temp.backdate(p_room uuid) returns void language sql security definer as $$
  update public.rooms set started_at = started_at - interval '10 minutes' where id = p_room;
$$;
-- A room hosted by the first letter, joined by the rest, and started.
create function pg_temp.started(p_name text, p_letters text[]) returns uuid language plpgsql as $$
declare
  v_room uuid;
  v_letter text;
begin
  perform pg_temp.login(p_letters[1]);
  v_room := public.create_room(p_name, 8);
  foreach v_letter in array p_letters[2:] loop
    perform pg_temp.login(v_letter);
    perform public.join_room(v_room);
  end loop;
  perform pg_temp.login(p_letters[1]);
  perform public.set_room_status(v_room, 'playing');
  perform pg_temp.backdate(v_room);
  return v_room;
end;
$$;
create function pg_temp.finish(p_name text, p_scores jsonb) returns void language plpgsql as $$
begin
  perform pg_temp.login(substr(p_name, 1, 1));
  perform public.finish_match(pg_temp.room(p_name), pg_temp.scores(p_scores));
end;
$$;
create function pg_temp.confirm(p_letter text, p_name text, p_scores jsonb) returns void language plpgsql as $$
begin
  perform pg_temp.login(p_letter);
  perform public.confirm_result(pg_temp.room(p_name), pg_temp.scores(p_scores));
end;
$$;
create function pg_temp.ranked(p_name text) returns boolean language sql as $$
  select ranked from public.match_results where room_id = pg_temp.room(p_name);
$$;
grant execute on all functions in schema pg_temp to authenticated, anon;

set local role authenticated;

-- Who may confirm ---------------------------------------------------------------
-- Room names start with the host's letter (see pg_temp.finish).
select pg_temp.login('a');
select public.create_room('a waiting', 2);
select pg_temp.login('b');
select public.join_room(pg_temp.room('a waiting'));
select throws_ok(
  $$ select pg_temp.confirm('b', 'a waiting', '{"a": 1, "b": 0}') $$,
  'P0001', 'That match hasn''t started.', 'there is nothing to confirm before the match starts');

select pg_temp.started('a duel', array['a', 'b']);
select throws_ok(
  $$ select pg_temp.confirm('a', 'a duel', '{"a": 3, "b": 1}') $$,
  '42501', 'The host records the result; guests confirm it.', 'the host cannot confirm their own result');
select throws_ok(
  $$ select pg_temp.confirm('c', 'a duel', '{"a": 3, "b": 1}') $$,
  '42501', 'Only players in the match can confirm its result.', 'outsiders cannot confirm');
select throws_ok(
  $$ select pg_temp.confirm('b', 'a duel', '[3, 1]') $$,
  '22023', null, 'scores must be an object');

-- Two players: the guest has to agree ------------------------------------------------
select pg_temp.finish('a duel', '{"a": 3, "b": 1}');
select is(pg_temp.ranked('a duel'), false, 'a result nobody confirmed is unranked');
select is(
  (select count(*)::int from public.leaderboard where player_id = pg_temp.id('a')), 0,
  'unranked results stay off the leaderboard');
select is(
  (select count(*)::int from public.match_players where room_name = 'a duel'), 2,
  'unranked results still show in history');

select pg_temp.confirm('b', 'a duel', '{"a": 3, "b": 1}');
select is(pg_temp.ranked('a duel'), true, 'the guest agreeing ranks it');
select is(
  (select confirmed_by from public.match_results where room_id = pg_temp.room('a duel')),
  array[pg_temp.id('b')], 'the result records who confirmed');
select is(
  (select matches from public.leaderboard where player_id = pg_temp.id('a')), 1,
  'ranked results count on the leaderboard');

-- A guest can confirm before the host records it ---------------------------------------
select pg_temp.started('c early', array['c', 'd']);
select pg_temp.confirm('d', 'c early', '{"c": 2, "d": 4}');
select pg_temp.finish('c early', '{"c": 2, "d": 4}');
select is(pg_temp.ranked('c early'), true, 'a confirmation that came first still counts');

-- Disagreeing ----------------------------------------------------------------------
select pg_temp.started('a forged', array['a', 'b']);
select pg_temp.finish('a forged', '{"a": 9, "b": 0}');
select pg_temp.confirm('b', 'a forged', '{"a": 2, "b": 5}');
select is(pg_temp.ranked('a forged'), false, 'a guest who saw different scores leaves it unranked');
select pg_temp.confirm('b', 'a forged', '{"a": 9, "b": 0}');
select is(pg_temp.ranked('a forged'), false, 'a player''s first report stands');

-- Majorities ---------------------------------------------------------------------------
select pg_temp.started('a four', array['a', 'b', 'c', 'd']);
select pg_temp.finish('a four', '{"a": 3, "b": 2, "c": 1, "d": 0}');
select pg_temp.confirm('b', 'a four', '{"a": 3, "b": 2, "c": 1, "d": 0}');
select is(pg_temp.ranked('a four'), false, 'with four players, the host and one guest are only half');
select pg_temp.confirm('c', 'a four', '{"a": 3, "b": 2, "c": 1, "d": 0}');
select is(pg_temp.ranked('a four'), true, 'the host and two guests are a majority');

select pg_temp.started('a three', array['a', 'b', 'e']);
select pg_temp.finish('a three', '{"a": 1, "b": 1, "e": 1}');
select pg_temp.confirm('e', 'a three', '{"a": 1, "b": 1, "e": 1}');
select is(pg_temp.ranked('a three'), true, 'with three players, the host and one guest are enough');

-- Internals stay internal --------------------------------------------------------------
select throws_ok(
  $$ select * from public.result_confirmations $$,
  '42501', null, 'players cannot read others'' reports');
select throws_ok(
  $$ select public.refresh_ranking(pg_temp.room('a forged')) $$,
  '42501', null, 'clients cannot call refresh_ranking');

reset role;
set local role anon;
select throws_ok(
  $$ select public.confirm_result('00000000-0000-0000-0000-000000000000', '{}') $$,
  '42501', null, 'signed-out callers cannot confirm');

select * from finish();
rollback;
