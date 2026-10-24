-- Leaderboard and match history.
--
-- A result has to make sense on its own.  The cleanup job deletes rooms after
-- 2 hours and idle anonymous users (and so their profiles) after 7 days, so a
-- result that only held ids would soon have no room name and no player names.
-- finish_match now copies both into the result when the match ends.

alter table public.match_results add column room_name text;
alter table public.match_results add column names jsonb not null default '{}';  -- { player_id: display_name }

comment on column public.match_results.room_name is 'The room''s name when the match ended.  Null for results recorded before it was stored.';
comment on column public.match_results.names is '{ player_id: display_name } when the match ended.';

-- Fill in what's still around for results recorded before this migration.
update public.match_results r
set room_name = (select name from public.rooms where id = r.room_id),
    names = coalesce((
      select jsonb_object_agg(p.id, p.display_name)
      from public.profiles p
      where r.scores ? p.id::text
    ), '{}');

-- finish_match -----------------------------------------------------------------
-- Same checks as before.  It also records the room name and each player's
-- current display name.  The names come from profiles, not the caller, so the
-- host can't rename anyone in the record.

create or replace function public.finish_match(p_room_id uuid, p_scores jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms%rowtype;
  v_result_id uuid;
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

-- match_players ------------------------------------------------------------------
-- Why a view?  Scores are stored as one jsonb object per match, which is the
-- right shape for writing a result in one go.  Reading stats needs one row
-- per player per match instead.  The view unpacks the object and ranks each
-- match, so the client and the leaderboard query it like a table.
--
-- place uses rank(), the same "1, 1, 3" ranking as the results screen.  won
-- is first place (shared counts) in a match where not everyone tied, matching
-- the results screen, which calls an all-way tie "It's a tie!".
--
-- security_invoker keeps the RLS on match_results and profiles in force.

create view public.match_players
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
  (count(*) over m)::int as player_count
from public.match_results r
cross join lateral (
  select e.key, e.key::uuid as player_id, (e.value)::int as score
  from jsonb_each(r.scores) as e(key, value)
) s
left join public.profiles p on p.id = s.player_id
window m as (partition by r.id),
       w as (partition by r.id order by s.score desc);

-- leaderboard ----------------------------------------------------------------------
-- One row per player who has finished a match.  Ranked by wins, then total
-- points; ties share a rank.  The name is the player's current one, or their
-- name in their latest match once their profile has been cleaned up.
--
-- Both views recompute from every result on each read.  That's fine for a
-- prototype; at scale a trigger would keep a stats table up to date instead.

create view public.leaderboard
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
group by mp.player_id, p.display_name;

revoke all on public.match_players, public.leaderboard from anon, authenticated;
grant select on public.match_players, public.leaderboard to authenticated;
