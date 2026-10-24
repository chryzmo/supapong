-- profiles RLS and constraints.  Run with `npx supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-00000000000a', true),
  ('00000000-0000-0000-0000-00000000000b', true);

create function pg_temp.login(p_uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
$$;
grant execute on all functions in schema pg_temp to authenticated, anon;

select pg_temp.login('00000000-0000-0000-0000-00000000000a');
set local role authenticated;

select lives_ok(
  $$ insert into public.profiles (id, display_name) values ('00000000-0000-0000-0000-00000000000a', 'Ada') $$,
  'a player can create their own profile');
select throws_ok(
  $$ insert into public.profiles (id, display_name) values ('00000000-0000-0000-0000-00000000000b', 'Spoof') $$,
  '42501', null, 'a player cannot create a profile for someone else');

update public.profiles set display_name = 'Ada L' where id = '00000000-0000-0000-0000-00000000000a';
select is((select display_name from public.profiles where id = auth.uid()), 'Ada L', 'a player can rename themselves');

select throws_ok(
  $$ update public.profiles set display_name = '' where id = auth.uid() $$,
  '23514', null, 'empty names are rejected');
select throws_ok(
  $$ update public.profiles set display_name = repeat('x', 25) where id = auth.uid() $$,
  '23514', null, 'names over 24 characters are rejected');
select lives_ok(
  $$ update public.profiles set display_name = repeat('x', 24) where id = auth.uid() $$,
  '24-character names are allowed');
select throws_ok(
  $$ update public.profiles set id = '00000000-0000-0000-0000-00000000000b' where id = auth.uid() $$,
  '42501', null, 'a player cannot move their profile to another id');

select pg_temp.login('00000000-0000-0000-0000-00000000000b');
insert into public.profiles (id, display_name) values ('00000000-0000-0000-0000-00000000000b', 'Bob');
update public.profiles set display_name = 'Hacked' where id = '00000000-0000-0000-0000-00000000000a';
select is(
  (select display_name from public.profiles where id = '00000000-0000-0000-0000-00000000000a'),
  repeat('x', 24), 'a player cannot rename someone else');
select is(
  (select count(*)::int from public.profiles where id in ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b')),
  2, 'players can read other players'' profiles');

reset role;
set local role anon;
select throws_ok('select count(*) from public.profiles', '42501', null, 'signed-out callers cannot read profiles');

select * from finish();
rollback;
