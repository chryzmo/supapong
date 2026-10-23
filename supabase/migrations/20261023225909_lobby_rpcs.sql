-- Lobby view, room RPCs, and Realtime publication.

-- lobby_rooms ----------------------------------------------------------------
-- Why a view?  The lobby needs "x/y players" per room.  A view does the join
-- and count in one round trip, and the client queries it like a table.
--
-- security_invoker makes the view run with the caller's permissions, so the
-- RLS policies on rooms, room_players and profiles still apply.  Without it, a
-- view runs as its owner and silently bypasses RLS.
--
-- Rooms older than an hour are hidden.  That covers a host who closed the tab
-- without leaving.  Presence-based cleanup comes with the room screen.

create view public.lobby_rooms
with (security_invoker = true) as
select
  r.id,
  r.name,
  r.host_id,
  p.display_name as host_name,
  r.max_players,
  count(rp.player_id)::int as player_count,
  r.created_at
from public.rooms r
join public.profiles p on p.id = r.host_id
left join public.room_players rp on rp.room_id = r.id
where r.status = 'waiting'
  and r.created_at > now() - interval '1 hour'
group by r.id, p.display_name;

-- join_room ------------------------------------------------------------------
-- Why an RPC?  Picking the lowest free seat is a read followed by a write.
-- Done from the client, two players could read the same free seat at once.
-- Here, `for update` locks the room row, so joins to the same room run one at
-- a time inside a single transaction.
--
-- security definer lets it insert into room_players, which has no insert
-- policy.  It always seats auth.uid(), never a caller-supplied id.

create function public.join_room(p_room_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.rooms%rowtype;
  v_seat int;
  v_count int;
begin
  if v_uid is null then
    raise exception 'Not signed in.' using errcode = '28000';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise exception 'That room no longer exists.' using errcode = 'P0002';
  end if;

  -- Joining a room you're already in returns your seat.
  select rp.seat into v_seat
  from public.room_players rp
  where rp.room_id = p_room_id and rp.player_id = v_uid;
  if found then
    return v_seat;
  end if;

  if v_room.status <> 'waiting' then
    raise exception 'That match has already started.' using errcode = 'P0001';
  end if;

  select count(*) into v_count from public.room_players where room_id = p_room_id;
  if v_count >= v_room.max_players then
    raise exception 'That room is full.' using errcode = 'P0001';
  end if;

  select min(s) into v_seat
  from generate_series(0, v_room.max_players - 1) as s
  where not exists (
    select 1 from public.room_players rp
    where rp.room_id = p_room_id and rp.seat = s
  );

  insert into public.room_players (room_id, player_id, seat)
  values (p_room_id, v_uid, v_seat);

  return v_seat;
end;
$$;

-- create_room ----------------------------------------------------------------
-- Creates a room and seats the host in one transaction, so the lobby never
-- shows an empty room.  It runs as the caller (security invoker), so the rooms
-- insert policy still checks host_id = auth.uid().

create function public.create_room(p_name text, p_max_players int)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_room_id uuid;
begin
  insert into public.rooms (name, host_id, max_players)
  values (trim(p_name), auth.uid(), p_max_players)
  returning id into v_room_id;

  perform public.join_room(v_room_id);
  return v_room_id;
end;
$$;

-- set_room_status ------------------------------------------------------------
-- The only way to change a room's status.  It checks that the caller is the
-- host and that the change moves forward: waiting -> playing -> finished, or
-- waiting -> finished if the host gives up before starting.

create function public.set_room_status(p_room_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms%rowtype;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise exception 'That room no longer exists.' using errcode = 'P0002';
  end if;

  if v_room.host_id is distinct from auth.uid() then
    raise exception 'Only the host can change the room status.' using errcode = '42501';
  end if;

  if not (
    (v_room.status = 'waiting' and p_status in ('playing', 'finished'))
    or (v_room.status = 'playing' and p_status = 'finished')
  ) then
    raise exception 'Cannot change status from % to %.', v_room.status, p_status
      using errcode = 'P0001';
  end if;

  update public.rooms set status = p_status where id = p_room_id;
end;
$$;

-- Supabase grants execute on new functions to anon by default.  These are for
-- signed-in players only.
revoke execute on function public.join_room(uuid) from public, anon;
revoke execute on function public.create_room(text, int) from public, anon;
revoke execute on function public.set_room_status(uuid, text) from public, anon;
grant execute on function public.join_room(uuid) to authenticated;
grant execute on function public.create_room(text, int) to authenticated;
grant execute on function public.set_room_status(uuid, text) to authenticated;

-- Realtime -------------------------------------------------------------------
-- Why Postgres Changes for the lobby?  Room lists change rarely, so "tell me
-- when something changed, I'll refetch" is simple and cheap.  Realtime checks
-- RLS before delivering each change, so clients only hear about rows they can
-- read.

alter publication supabase_realtime add table public.rooms, public.room_players;
