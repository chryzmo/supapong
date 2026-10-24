-- Phase 1 of plans/anti-cheat.md: guests confirm the result.
--
-- The host records the result, but only the host's word says it happened.
-- Now each guest's client also reports the scores it was shown, and a result
-- only counts toward the leaderboard ("ranked") once more than half of the
-- match's players, the host included, agree on it.  A host who records
-- different scores from the ones it showed everyone (one console call, before
-- this) is left unranked.  A host who shows everyone the same fake scores
-- isn't caught: that's for later phases.

-- result_confirmations -------------------------------------------------------
-- Keyed by room, not result, because a guest's confirmation can arrive before
-- the host has recorded the result.  Whichever comes second settles the
-- ranking (refresh_ranking), which is stored on the result itself, so it
-- outlives these rows when cleanup deletes the room.

create table public.result_confirmations (
  room_id uuid not null references public.rooms on delete cascade,
  player_id uuid not null references public.profiles on delete cascade,
  scores jsonb not null,
  created_at timestamptz not null default now(),
  primary key (room_id, player_id)
);

-- Written only by confirm_result, read only by refresh_ranking.  Nobody needs
-- to see another player's report.
alter table public.result_confirmations enable row level security;
revoke all on public.result_confirmations from anon, authenticated;

-- match_results gains the outcome ------------------------------------------------

alter table public.match_results
  add column confirmed_by uuid[] not null default '{}',
  add column ranked boolean not null default false;

comment on column public.match_results.confirmed_by is 'Players other than the host who reported the same scores.  Set by refresh_ranking.';
comment on column public.match_results.ranked is 'Counts toward the leaderboard: more than half the players, host included, agree.  Set by refresh_ranking.';

-- Results from before confirmations existed keep counting.
update public.match_results set ranked = true;

-- refresh_ranking ----------------------------------------------------------------
-- Recounts a room's result from its confirmations.  Internal: called by
-- finish_match and confirm_result, not by clients.

create function public.refresh_ranking(p_room_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.match_results r
  set confirmed_by = agreed.ids,
      -- The host counts as one, since the result is the host's own report.
      ranked = (1 + cardinality(agreed.ids)) * 2 > (select count(*) from jsonb_object_keys(r.scores))
  from (
    select coalesce(array_agg(c.player_id order by c.player_id), '{}') as ids
    from public.result_confirmations c
    join public.match_results m on m.room_id = c.room_id
    where c.room_id = p_room_id
      and c.scores = m.scores
      and m.scores ? c.player_id::text
  ) agreed
  where r.room_id = p_room_id;
$$;
revoke execute on function public.refresh_ranking(uuid) from public, anon, authenticated;

-- confirm_result -----------------------------------------------------------------

create function public.confirm_result(p_room_id uuid, p_scores jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms%rowtype;
begin
  select * into v_room from public.rooms where id = p_room_id;
  if not found then
    raise exception 'That room no longer exists.' using errcode = 'P0002';
  end if;
  if v_room.host_id = auth.uid() then
    raise exception 'The host records the result; guests confirm it.' using errcode = '42501';
  end if;
  if v_room.status = 'waiting' then
    raise exception 'That match hasn''t started.' using errcode = 'P0001';
  end if;
  if not (auth.uid() = any (coalesce(v_room.starting_players, '{}'))) then
    raise exception 'Only players in the match can confirm its result.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_scores) is distinct from 'object' then
    raise exception 'Scores must map player ids to points.' using errcode = '22023';
  end if;

  -- A player's first report stands.
  insert into public.result_confirmations (room_id, player_id, scores)
  values (p_room_id, auth.uid(), p_scores)
  on conflict do nothing;

  perform public.refresh_ranking(p_room_id);
end;
$$;
revoke execute on function public.confirm_result(uuid, jsonb) from public, anon;
grant execute on function public.confirm_result(uuid, jsonb) to authenticated;

-- finish_match settles the ranking too --------------------------------------------
-- Unchanged from 20261024200000_result_checks.sql apart from the last step.

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
  -- Guests may have confirmed already.
  perform public.refresh_ranking(p_room_id);
  return v_result_id;
end;
$$;

-- Views ----------------------------------------------------------------------------
-- match_players gains `ranked` (added last, as create or replace requires),
-- so history can mark unconfirmed matches.  The leaderboard counts only
-- ranked ones.

create or replace view public.match_players
with (security_invoker = true) as
select
  r.id as result_id,
  r.finished_at,
  r.room_name,
  s.player_id,
  coalesce(r.names ->> s.key, p.display_name) as display_name,
  s.score,
  (rank() over w)::int as place,
  (s.score = max(s.score) over m and s.score > min(s.score) over m) as won,
  (count(*) over m)::int as player_count,
  r.ranked
from public.match_results r
cross join lateral (
  select e.key, e.key::uuid as player_id, (e.value)::int as score
  from jsonb_each(r.scores) as e(key, value)
) s
left join public.profiles p on p.id = s.player_id
window m as (partition by r.id),
       w as (partition by r.id order by s.score desc);

create or replace view public.leaderboard
with (security_invoker = true) as
select
  mp.player_id,
  coalesce(p.display_name, (array_agg(mp.display_name order by mp.finished_at desc))[1]) as display_name,
  count(*)::int as matches,
  (count(*) filter (where mp.won))::int as wins,
  sum(mp.score)::int as points,
  (rank() over (order by count(*) filter (where mp.won) desc, sum(mp.score) desc))::int as rank
from public.match_players mp
left join public.profiles p on p.id = mp.player_id
where mp.ranked
group by mp.player_id, p.display_name;
