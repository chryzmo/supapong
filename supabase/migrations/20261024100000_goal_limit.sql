-- The room creator picks how many goals end the match.
--
-- A match ends when this many goals have been scored in total (or at the time
-- limit).  The lobby offers 5 to 25; the column accepts 1 to 50, so the
-- choices can change without a migration.
--
-- Written to work with the frontend that's already deployed, which CI keeps
-- serving until the new one is out: the column has a default, and
-- create_room's new argument is optional.

alter table public.rooms
  add column goal_limit int not null default 10 check (goal_limit between 1 and 50);

-- create_room ------------------------------------------------------------------
-- Same as before, plus the goal limit.  Adding an argument makes a new
-- function rather than replacing the old one, so drop the old one first, or a
-- two-argument call would be ambiguous.

drop function public.create_room(text, int);

create function public.create_room(p_name text, p_max_players int, p_goal_limit int default 10)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_room_id uuid;
begin
  insert into public.rooms (name, host_id, max_players, goal_limit)
  values (trim(p_name), auth.uid(), p_max_players, p_goal_limit)
  returning id into v_room_id;

  perform public.join_room(v_room_id);
  return v_room_id;
end;
$$;

revoke execute on function public.create_room(text, int, int) from public, anon;
grant execute on function public.create_room(text, int, int) to authenticated;

-- lobby_rooms --------------------------------------------------------------------
-- Adds goal_limit, so the lobby can show it.  `create or replace` can only
-- add columns at the end, and it keeps the view's grants.

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
  r.goal_limit
from public.rooms r
join public.profiles p on p.id = r.host_id
left join public.room_players rp on rp.room_id = r.id
where r.status = 'waiting'
  and r.created_at > now() - interval '1 hour'
group by r.id, p.display_name;
