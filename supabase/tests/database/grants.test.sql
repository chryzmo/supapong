-- Table grants.  Hosted projects don't grant new tables to anon or
-- authenticated, so these must come from migrations.  Run with
-- `npx supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

select table_privs_are('public', 'profiles', 'authenticated', array['SELECT', 'INSERT', 'UPDATE']);
select table_privs_are('public', 'rooms', 'authenticated', array['SELECT', 'INSERT', 'DELETE']);
select table_privs_are('public', 'room_players', 'authenticated', array['SELECT', 'DELETE']);
select table_privs_are('public', 'match_results', 'authenticated', array['SELECT']);
select table_privs_are('public', 'lobby_rooms', 'authenticated', array['SELECT']);

select table_privs_are('public', 'profiles', 'anon', array[]::text[]);
select table_privs_are('public', 'rooms', 'anon', array[]::text[]);
select table_privs_are('public', 'room_players', 'anon', array[]::text[]);
select table_privs_are('public', 'match_results', 'anon', array[]::text[]);
select table_privs_are('public', 'lobby_rooms', 'anon', array[]::text[]);

select * from finish();
rollback;
