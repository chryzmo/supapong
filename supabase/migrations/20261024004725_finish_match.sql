-- Recording a finished match.
--
-- Results outlive their room: deleting a room (or its host's account) now
-- leaves the result with room_id = null instead of deleting it.  A room has
-- at most one match, so at most one result.

alter table public.match_results alter column room_id drop not null;
alter table public.match_results drop constraint match_results_room_id_fkey;
alter table public.match_results
  add constraint match_results_room_id_fkey
  foreign key (room_id) references public.rooms on delete set null;
alter table public.match_results add constraint match_results_room_id_key unique (room_id);

-- Results are written only by finish_match(), never inserted directly.
drop policy "hosts can record results for their rooms" on public.match_results;

-- finish_match -----------------------------------------------------------------
-- Why an RPC?  Ending a match is two writes (the result and the room status)
-- that must happen together, plus checks RLS can't express: the caller is the
-- host, the match is actually running, and the scores are well formed.
--
-- p_scores is { player_id: points } for everyone who played, including
-- players who left mid-match.

create function public.finish_match(p_room_id uuid, p_scores jsonb)
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

  insert into public.match_results (room_id, scores)
  values (p_room_id, p_scores)
  returning id into v_result_id;

  update public.rooms set status = 'finished' where id = p_room_id;
  return v_result_id;
end;
$$;

revoke execute on function public.finish_match(uuid, jsonb) from public, anon;
grant execute on function public.finish_match(uuid, jsonb) to authenticated;
