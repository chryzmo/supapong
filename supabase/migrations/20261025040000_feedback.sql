-- Player feedback, filed as GitHub issues by the create-issue Edge Function.
--
-- The function inserts each submission here as the player (with their own
-- JWT), so these rules apply to it as to any client: only signed-in players
-- with a profile, only as themselves, and at most a few a day.  Then it files
-- the issue and writes the result back with the service role.  The row stays
-- even if GitHub is down, with the reason in `error`.

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  -- A player without a profile has no name to file under, so they can't
  -- send any.  Set null, not deleted, when cleanup removes the player: the
  -- issue outlives them too.
  player_id uuid default auth.uid() references public.profiles on delete set null,
  kind text not null check (kind in ('bug', 'feature')),
  title text not null check (char_length(trim(title)) between 3 and 80),
  body text not null check (char_length(trim(body)) between 1 and 2000),
  -- For bugs, optionally: what the player was doing when it happened.
  doing text check (char_length(doing) <= 1000),
  -- What the app attaches: version, browser, screen.  Kept small.
  context jsonb not null default '{}' check (jsonb_typeof(context) = 'object' and pg_column_size(context) <= 2000),
  issue_number int,
  issue_url text,
  error text,
  created_at timestamptz not null default now()
);

create index feedback_player_recent on public.feedback (player_id, created_at desc);

alter table public.feedback enable row level security;

-- Only as yourself, and only a fresh submission: the issue columns are the
-- function's to fill in.
create policy "players can send feedback"
  on public.feedback for insert
  to authenticated
  with check (
    player_id = (select auth.uid())
    and issue_number is null
    and issue_url is null
    and error is null
  );

create policy "players can read their own feedback"
  on public.feedback for select
  to authenticated
  using (player_id = (select auth.uid()));

revoke all on public.feedback from anon, authenticated;
grant select, insert on public.feedback to authenticated;

-- A few a day per player -------------------------------------------------------------
-- Anonymous accounts are cheap, but sign-in sits behind Turnstile, so
-- making many is slow.  This keeps one player from flooding the repo.

create function public.limit_feedback()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    select count(*) from public.feedback
    where player_id = new.player_id and created_at > now() - interval '24 hours'
  ) >= 5 then
    raise exception 'That''s plenty of feedback for one day.  Thank you!  Try again tomorrow.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function public.limit_feedback() from public, anon, authenticated;

create trigger feedback_daily_limit
  before insert on public.feedback
  for each row execute function public.limit_feedback();
