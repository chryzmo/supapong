-- Private room channel policies on realtime.messages.  Run with
-- `npx supabase test db`.
--
-- Realtime decides channel access by trying an insert (may send) and a select
-- (may receive) on realtime.messages with realtime.topic() set to the channel,
-- then rolling back.  These tests do the same.
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

-- A hosts, B is seated, C is signed in but not in the room.
insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-00000000000a', true),
  ('00000000-0000-0000-0000-00000000000b', true),
  ('00000000-0000-0000-0000-00000000000c', true);
insert into public.profiles (id, display_name) values
  ('00000000-0000-0000-0000-00000000000a', 'A'),
  ('00000000-0000-0000-0000-00000000000b', 'B'),
  ('00000000-0000-0000-0000-00000000000c', 'C');

create function pg_temp.login(p_uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.room() returns uuid language sql as $$
  select id from public.rooms where name = 'Realtime room';
$$;
-- Acts as `p_uid` joining channel `p_topic`.
create function pg_temp.join(p_uid uuid, p_topic text) returns void language sql as $$
  select pg_temp.login(p_uid);
  select set_config('realtime.topic', p_topic, true);
$$;
create function pg_temp.can_send(p_extension text) returns boolean language plpgsql as $$
begin
  insert into realtime.messages (topic, extension, event, payload)
  values (realtime.topic(), p_extension, 'test', '{}');
  return true;
exception when insufficient_privilege then
  return false;
end;
$$;
create function pg_temp.can_receive(p_extension text) returns boolean language sql as $$
  select exists (
    select 1 from realtime.messages where topic = realtime.topic() and extension = p_extension
  );
$$;
grant execute on all functions in schema pg_temp to authenticated;

select pg_temp.login('00000000-0000-0000-0000-00000000000a');
set local role authenticated;
select public.create_room('Realtime room', 4);
select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select public.join_room(pg_temp.room());
reset role;

-- One message of each kind on each topic, for the receive checks to find.
insert into realtime.messages (topic, extension, event, payload)
select 'room:' || pg_temp.room() || suffix, extension, 'seed', '{}'::jsonb
from (values (''), (':input')) as topics (suffix), (values ('broadcast'), ('presence')) as kinds (extension)
union all
select 'lobby', 'broadcast', 'seed', '{}'::jsonb;

set local role authenticated;

-- room:{id} --------------------------------------------------------------------
select pg_temp.join('00000000-0000-0000-0000-00000000000a', 'room:' || pg_temp.room());
select ok(pg_temp.can_receive('broadcast'), 'the host receives room broadcasts');
select ok(pg_temp.can_receive('presence'), 'the host receives presence');
select ok(pg_temp.can_send('broadcast'), 'the host can broadcast to the room');
select ok(pg_temp.can_send('presence'), 'the host can track presence');

select pg_temp.join('00000000-0000-0000-0000-00000000000b', 'room:' || pg_temp.room());
select ok(pg_temp.can_receive('broadcast'), 'a seated guest receives room broadcasts');
select ok(pg_temp.can_receive('presence'), 'a seated guest receives presence');
select ok(pg_temp.can_send('presence'), 'a seated guest can track presence');
select ok(not pg_temp.can_send('broadcast'), 'a seated guest cannot broadcast to the room');

select pg_temp.join('00000000-0000-0000-0000-00000000000c', 'room:' || pg_temp.room());
select ok(not pg_temp.can_receive('broadcast'), 'an outsider receives no room broadcasts');
select ok(not pg_temp.can_receive('presence'), 'an outsider receives no presence');
select ok(not pg_temp.can_send('broadcast'), 'an outsider cannot broadcast to the room');
select ok(not pg_temp.can_send('presence'), 'an outsider cannot track presence');

-- room:{id}:input --------------------------------------------------------------
select pg_temp.join('00000000-0000-0000-0000-00000000000a', 'room:' || pg_temp.room() || ':input');
select ok(pg_temp.can_receive('broadcast'), 'the host receives inputs');

select pg_temp.join('00000000-0000-0000-0000-00000000000b', 'room:' || pg_temp.room() || ':input');
select ok(pg_temp.can_send('broadcast'), 'a seated guest can send inputs');
select ok(pg_temp.can_receive('broadcast'), 'a seated guest can join the input channel');

select pg_temp.join('00000000-0000-0000-0000-00000000000c', 'room:' || pg_temp.room() || ':input');
select ok(not pg_temp.can_send('broadcast'), 'an outsider cannot send inputs');
select ok(not pg_temp.can_receive('broadcast'), 'an outsider does not receive inputs');

-- lobby ------------------------------------------------------------------------
select pg_temp.join('00000000-0000-0000-0000-00000000000c', 'lobby');
select ok(pg_temp.can_receive('broadcast'), 'any signed-in player can join the lobby');
select ok(not pg_temp.can_send('broadcast'), 'nobody can broadcast to the lobby');

-- Leaving ----------------------------------------------------------------------
select pg_temp.login('00000000-0000-0000-0000-00000000000b');
delete from public.room_players where room_id = pg_temp.room() and player_id = auth.uid();
select pg_temp.join('00000000-0000-0000-0000-00000000000b', 'room:' || pg_temp.room());
select ok(not pg_temp.can_receive('broadcast'), 'a player who left cannot rejoin the channel');

select * from finish();
rollback;
