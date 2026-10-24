-- Scheduled cleanup (pg_cron).
--
-- Why pg_cron?  Until now, cleanup depended on a browser: the host removes
-- seats, and a host who closes the tab leaves the room behind.  Abandoned
-- rooms and throwaway anonymous users pile up forever.  pg_cron runs SQL on a
-- schedule inside Postgres itself, so the database tidies up after itself
-- with no server or Edge Function of ours.

create extension if not exists pg_cron with schema pg_catalog;

-- cleanup ----------------------------------------------------------------------
-- Returns what it deleted, for running by hand and for tests.

create function public.cleanup()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_rooms int;
  v_users int;
  v_runs int;
begin
  -- Rooms older than 2 hours, whatever their status.  The lobby hides
  -- waiting rooms after an hour and a match lasts 2 minutes, so nothing
  -- that old is still in use.  Seats go with the room; match results stay,
  -- with room_id set to null.
  delete from public.rooms where created_at < now() - interval '2 hours';
  get diagnostics v_rooms = row_count;

  -- Anonymous users with no session activity for 7 days.  Sessions live in a
  -- tab's sessionStorage, so once the tab is closed that player can never
  -- sign in again.  Their profile, hosted rooms and seats cascade.  Their ids
  -- stay in match_results.scores.
  delete from auth.users u
  where u.is_anonymous
    and u.created_at < now() - interval '7 days'
    and not exists (
      select 1 from auth.sessions s
      where s.user_id = u.id
        and coalesce(s.refreshed_at, s.updated_at, s.created_at) > now() - interval '7 days'
    );
  get diagnostics v_users = row_count;

  -- pg_cron logs every run and never trims the log itself.
  delete from cron.job_run_details where end_time < now() - interval '7 days';
  get diagnostics v_runs = row_count;

  return jsonb_build_object('rooms', v_rooms, 'users', v_users, 'job_runs', v_runs);
end;
$$;

-- Postgres grants execute on new functions to everyone.  This one deletes
-- users, so only the database owner (and pg_cron, running as it) may call it.
revoke execute on function public.cleanup() from public, anon, authenticated;

select cron.schedule('cleanup', '*/15 * * * *', 'select public.cleanup()');
