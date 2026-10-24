-- Phase 0 of plans/anti-cheat.md: finish_match stops believing whatever the
-- host sends.  It's still the host's word, but now it has to be a plausible
-- one: points only for players who were in the match, no more points than
-- goals the match allowed, and not sooner than the match could have lasted.

-- Recorded when the match starts, by set_room_status('playing').  Nothing
-- else may write them, so finish_match can trust them.
alter table public.rooms
  add column started_at timestamptz,
  add column starting_players uuid[];

comment on column public.rooms.started_at is 'When the room went to playing.  Set by set_room_status.';
comment on column public.rooms.starting_players is 'Who held a seat when the room went to playing.  Set by set_room_status.';

-- Rooms already playing get what we can still tell: their seats now.
update public.rooms r
set started_at = r.created_at,
    starting_players = array(select rp.player_id from public.room_players rp where rp.room_id = r.id)
where r.status = 'playing';

-- A room inserted directly could otherwise start out playing, never pass
-- through set_room_status, and carry a made-up start.  New rooms start
-- waiting and unstarted; create_room inserts exactly that.
drop policy "users can create rooms they host" on public.rooms;
create policy "users can create rooms they host"
  on public.rooms for insert
  to authenticated
  with check (
    host_id = (select auth.uid())
    and status = 'waiting'
    and started_at is null
    and starting_players is null
  );

create or replace function public.set_room_status(p_room_id uuid, p_status text)
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

  if p_status = 'playing' then
    -- Everyone seated, which can include a few the host drops right after
    -- for not being connected.  More is fine: it's a list of who may score.
    update public.rooms
    set status = p_status,
        started_at = now(),
        starting_players = array(select rp.player_id from public.room_players rp where rp.room_id = p_room_id)
    where id = p_room_id;
  else
    update public.rooms set status = p_status where id = p_room_id;
  end if;
end;
$$;

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
  -- at the goal limit.
  select sum((value)::numeric)::int into v_points from jsonb_each(p_scores);
  if v_points > v_room.goal_limit then
    raise exception 'The scores add up to more than the match''s % goals.', v_room.goal_limit using errcode = '22023';
  end if;

  -- The 3-second countdown, then each point needs a goal, and a goal takes
  -- more than a second (the respawn delay alone is 1.2 s).  Generous, so a
  -- retune of the physics doesn't trip it.
  if now() < v_room.started_at + make_interval(secs => 3 + v_points) then
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
  return v_result_id;
end;
$$;
