-- The host sets the match's length, goal limit and power-ups in the waiting
-- room.
--
-- Either can be "no limit" (null), but not both: something has to end the
-- match.  Lengths are 2, 5 or 10 minutes (stored in seconds, as the physics
-- counts them); goal limits keep their 1-50 range.  The match itself follows
-- the host's `start` event, which carries both.

alter table public.rooms
  add column match_seconds int default 120 check (match_seconds in (120, 300, 600)),
  alter column goal_limit drop not null,
  add constraint rooms_match_ends check (goal_limit is not null or match_seconds is not null);

comment on column public.rooms.match_seconds is 'How long the match lasts, or null for no time limit.';
comment on column public.rooms.goal_limit is 'Goals in total that end the match, or null for no goal limit.';

-- create_room ------------------------------------------------------------------
-- Takes the length too, optionally, so the previous frontend's calls still
-- work.  The old signature goes, so those calls aren't ambiguous.

drop function public.create_room(text, int, int, boolean);

create function public.create_room(
  p_name text,
  p_max_players int,
  p_goal_limit int default 10,
  p_power_ups boolean default true,
  p_match_seconds int default 120
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_room_id uuid;
begin
  insert into public.rooms (name, host_id, max_players, goal_limit, power_ups, match_seconds)
  values (trim(p_name), auth.uid(), p_max_players, p_goal_limit, p_power_ups, p_match_seconds)
  returning id into v_room_id;

  perform public.join_room(v_room_id);
  return v_room_id;
end;
$$;
revoke execute on function public.create_room(text, int, int, boolean, int) from public, anon;
grant execute on function public.create_room(text, int, int, boolean, int) to authenticated;

-- set_match_settings ----------------------------------------------------------------
-- There's no update policy on rooms (RLS can't limit an update to some
-- columns), so the host changes these through here, and only before the
-- match starts.  The table's checks reject anything outside the choices.

create function public.set_match_settings(p_room_id uuid, p_goal_limit int, p_match_seconds int, p_power_ups boolean)
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
  set goal_limit = p_goal_limit, match_seconds = p_match_seconds, power_ups = p_power_ups
  where id = p_room_id;
end;
$$;
revoke execute on function public.set_match_settings(uuid, int, int, boolean) from public, anon;
grant execute on function public.set_match_settings(uuid, int, int, boolean) to authenticated;

-- lobby_rooms --------------------------------------------------------------------
-- Adds match_seconds at the end, as `create or replace` requires.

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
  r.match_seconds
from public.rooms r
join public.profiles p on p.id = r.host_id
left join public.room_players rp on rp.room_id = r.id
where r.status = 'waiting'
  and r.created_at > now() - interval '1 hour'
group by r.id, p.display_name;

-- finish_match: no goal limit means no cap on the points --------------------------------
-- Unchanged from 20261025020000_power_ups.sql apart from that check.

create or replace function public.finish_match(p_room_id uuid, p_scores jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms%rowtype;
  v_result_id uuid;
  v_points int;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise exception 'That room no longer exists.' using errcode = 'P0002';
  end if;
  if v_room.host_id is distinct from auth.uid() then
    raise exception 'Only the host can record the result.' using errcode = '42501';
  end if;
  if v_room.status <> 'playing' then
    raise exception 'That match isn''t running.' using errcode = 'P0001';
  end if;

  if jsonb_typeof(p_scores) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_scores)) not between 2 and 8
    or exists (
      select 1 from jsonb_each(p_scores) as e(key, value)
      where jsonb_typeof(e.value) <> 'number'
        or (e.value)::numeric < 0
        or (e.value)::numeric <> trunc((e.value)::numeric)
        or e.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
  then
    raise exception 'Scores must map 2 to 8 player ids to whole, non-negative points.' using errcode = '22023';
  end if;

  -- Seats can be gone by now (a player who left mid-match loses theirs), so
  -- check against who was seated at the start.
  if exists (
    select 1 from jsonb_object_keys(p_scores) as k
    where not (k::uuid = any (coalesce(v_room.starting_players, '{}')))
  ) then
    raise exception 'Scores can only go to players who were in the match.' using errcode = '22023';
  end if;

  -- Each goal gives at most one point (some give none), and the match ends
  -- at the goal limit, if it has one.
  select sum((value)::numeric)::int into v_points from jsonb_each(p_scores);
  if v_room.goal_limit is not null and v_points > v_room.goal_limit then
    raise exception 'The scores add up to more than the match''s % goals.', v_room.goal_limit using errcode = '22023';
  end if;

  -- The 3-second countdown, then each point needs a goal, and a goal takes
  -- more than a second (the respawn delay alone is 1.2 s).  Generous, so a
  -- retune of the physics doesn't trip it.  With power-ups, multiball can put
  -- several goals inside a second, so allow 0.3 s a point.
  if now() < v_room.started_at + make_interval(secs => 3 + v_points * (case when v_room.power_ups then 0.3 else 1 end)) then
    raise exception 'That result came in sooner than the match could have lasted.' using errcode = '22023';
  end if;

  insert into public.match_results (room_id, scores, room_name, names)
  values (
    p_room_id,
    p_scores,
    v_room.name,
    coalesce((
      select jsonb_object_agg(p.id, p.display_name)
      from public.profiles p
      where p_scores ? p.id::text
    ), '{}')
  )
  returning id into v_result_id;

  update public.rooms set status = 'finished' where id = p_room_id;
  -- Guests may have confirmed already.
  perform public.refresh_ranking(p_room_id);
  return v_result_id;
end;
$$;
