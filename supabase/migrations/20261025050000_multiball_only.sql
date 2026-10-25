-- A third game type: only multiball tokens.
--
-- The game type is two flags: power_ups (on or off, as before) and, with it
-- on, multiball_only.  Keeping power_ups as it was means the previous
-- frontend, which knows nothing of multiball_only, keeps working: its calls
-- leave the flag at its default, off.  finish_match's looser minimum length
-- already follows power_ups, which multiball needs most.  As with power_ups,
-- the match itself follows the host's `start` event; the column is what the
-- lobby shows, and what the host reads when it starts the match.

alter table public.rooms add column multiball_only boolean not null default false;

comment on column public.rooms.multiball_only is 'With power_ups: every token is a multiball.';

-- create_room ------------------------------------------------------------------
-- Takes the flag too, optionally, so the previous frontend's calls still
-- work.  The old signature goes, so those calls aren't ambiguous.

drop function public.create_room(text, int, int, boolean, int);

create function public.create_room(
  p_name text,
  p_max_players int,
  p_goal_limit int default 10,
  p_power_ups boolean default true,
  p_match_seconds int default 120,
  p_multiball_only boolean default false
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_room_id uuid;
begin
  insert into public.rooms (name, host_id, max_players, goal_limit, power_ups, match_seconds, multiball_only)
  values (trim(p_name), auth.uid(), p_max_players, p_goal_limit, p_power_ups, p_match_seconds, p_multiball_only)
  returning id into v_room_id;

  perform public.join_room(v_room_id);
  return v_room_id;
end;
$$;
revoke execute on function public.create_room(text, int, int, boolean, int, boolean) from public, anon;
grant execute on function public.create_room(text, int, int, boolean, int, boolean) to authenticated;

-- set_match_settings ----------------------------------------------------------------
-- Unchanged from 20261025030000_match_settings.sql apart from the flag, which
-- is optional for the previous frontend's calls.

drop function public.set_match_settings(uuid, int, int, boolean);

create function public.set_match_settings(
  p_room_id uuid,
  p_goal_limit int,
  p_match_seconds int,
  p_power_ups boolean,
  p_multiball_only boolean default false
)
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
    raise exception 'Only the host can change the match settings.' using errcode = '42501';
  end if;
  if v_room.status <> 'waiting' then
    raise exception 'The match has already started.' using errcode = 'P0001';
  end if;

  update public.rooms
  set goal_limit = p_goal_limit, match_seconds = p_match_seconds, power_ups = p_power_ups, multiball_only = p_multiball_only
  where id = p_room_id;
end;
$$;
revoke execute on function public.set_match_settings(uuid, int, int, boolean, boolean) from public, anon;
grant execute on function public.set_match_settings(uuid, int, int, boolean, boolean) to authenticated;

-- lobby_rooms --------------------------------------------------------------------
-- Adds multiball_only at the end, as `create or replace` requires.

create or replace view public.lobby_rooms
with (security_invoker = true) as
select
  r.id,
  r.name,
  r.host_id,
  p.display_name as host_name,
  r.max_players,
  count(rp.player_id)::int as player_count,
  r.created_at,
  r.goal_limit,
  r.power_ups,
  r.match_seconds,
  r.multiball_only
from public.rooms r
join public.profiles p on p.id = r.host_id
left join public.room_players rp on rp.room_id = r.id
where r.status = 'waiting'
  and r.created_at > now() - interval '1 hour'
group by r.id, p.display_name;
