-- Feedback: who may send it, and how much.  Run with `npx supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

-- A and B have names; C signed in but never picked one.
insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-00000000000a', true),
  ('00000000-0000-0000-0000-00000000000b', true),
  ('00000000-0000-0000-0000-00000000000c', true);
insert into public.profiles (id, display_name) values
  ('00000000-0000-0000-0000-00000000000a', 'A'),
  ('00000000-0000-0000-0000-00000000000b', 'B');

create function pg_temp.login(p_uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.send(p_title text) returns void language sql as $$
  insert into public.feedback (kind, title, body) values ('bug', p_title, 'It broke.');
$$;
grant execute on all functions in schema pg_temp to authenticated, anon;

select pg_temp.login('00000000-0000-0000-0000-00000000000a');
set local role authenticated;

select lives_ok($$ select pg_temp.send('First one') $$, 'a player with a name can send feedback');
select is((select player_id from public.feedback where title = 'First one'), '00000000-0000-0000-0000-00000000000a'::uuid, 'it is theirs');
select throws_ok(
  $$ insert into public.feedback (player_id, kind, title, body) values ('00000000-0000-0000-0000-00000000000b', 'bug', 'Not me', 'x') $$,
  '42501', null, 'nobody can send feedback as someone else');
select throws_ok(
  $$ insert into public.feedback (kind, title, body, issue_number) values ('bug', 'Sneaky', 'x', 1) $$,
  '42501', null, 'the issue columns are the function''s to fill in');
select throws_ok(
  $$ insert into public.feedback (kind, title, body) values ('complaint', 'Hmm', 'x') $$,
  '23514', null, 'only bugs and feature requests');
select throws_ok(
  $$ update public.feedback set issue_url = 'https://example.com' $$,
  '42501', null, 'players cannot change feedback');

-- A day's worth -----------------------------------------------------------------------
select pg_temp.send('Second');
select pg_temp.send('Third');
select pg_temp.send('Fourth');
select pg_temp.send('Fifth');
select throws_ok(
  $$ select pg_temp.send('Sixth') $$,
  'P0001', 'That''s plenty of feedback for one day.  Thank you!  Try again tomorrow.', 'five a day each');

select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select lives_ok($$ select pg_temp.send('From B') $$, 'the limit is per player');
select is((select count(*)::int from public.feedback), 1, 'players see only their own feedback');

select pg_temp.login('00000000-0000-0000-0000-00000000000c');
select throws_ok($$ select pg_temp.send('No name') $$, '23503', null, 'a player without a name cannot send feedback');

reset role;
delete from auth.users where id = '00000000-0000-0000-0000-00000000000b';
select is((select count(*)::int from public.feedback where title = 'From B' and player_id is null), 1, 'feedback outlives its player');

set local role anon;
select throws_ok($$ select * from public.feedback $$, '42501', null, 'signed-out callers cannot read feedback');

select * from finish();
rollback;
