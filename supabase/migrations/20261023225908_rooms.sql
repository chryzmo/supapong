-- Rooms, seats and match results, with RLS.
--
-- Why Postgres + RLS for this instead of a custom server?  The rules ("only the
-- host can change a room", "you can only leave on your own behalf") live next
-- to the data, and the browser talks to the database directly through the
-- auto-generated API.  Anything RLS can't express cleanly (atomic seat
-- assignment, status transitions) goes through a small RPC in the next
-- migration.

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 32),
  host_id uuid not null references public.profiles on delete cascade,
  max_players int not null check (max_players between 2 and 8),
  status text not null default 'waiting' check (status in ('waiting', 'playing', 'finished')),
  created_at timestamptz not null default now()
);

create index rooms_status_created_at_idx on public.rooms (status, created_at desc);

create table public.room_players (
  room_id uuid references public.rooms on delete cascade,
  player_id uuid references public.profiles on delete cascade,
  seat int not null check (seat >= 0),  -- gate index, assigned by join_room
  joined_at timestamptz not null default now(),
  primary key (room_id, player_id),
  unique (room_id, seat)
);

create index room_players_player_id_idx on public.room_players (player_id);

create table public.match_results (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms on delete cascade,
  scores jsonb not null,  -- { player_id: points }
  finished_at timestamptz not null default now()
);

create index match_results_room_id_idx on public.match_results (room_id);

alter table public.rooms enable row level security;
alter table public.room_players enable row level security;
alter table public.match_results enable row level security;

-- rooms ----------------------------------------------------------------------

create policy "rooms are readable by authenticated users"
  on public.rooms for select
  to authenticated
  using (true);

create policy "users can create rooms they host"
  on public.rooms for insert
  to authenticated
  with check (host_id = (select auth.uid()));

-- The host closes a room by deleting it, which also removes its seats.
create policy "hosts can delete their rooms"
  on public.rooms for delete
  to authenticated
  using (host_id = (select auth.uid()));

-- No update policy: RLS can't limit an update to one column, so status changes
-- go through set_room_status(), which also checks the transition is valid.

-- room_players ---------------------------------------------------------------

create policy "seats are readable by authenticated users"
  on public.room_players for select
  to authenticated
  using (true);

-- Players can leave, and the host can remove a player whose presence is gone.
create policy "players can leave and hosts can remove players"
  on public.room_players for delete
  to authenticated
  using (
    player_id = (select auth.uid())
    or exists (
      select 1 from public.rooms r
      where r.id = room_id and r.host_id = (select auth.uid())
    )
  );

-- No insert policy: seats are only assigned by join_room(), which picks the
-- seat itself so two players can't race for the same one.

-- match_results --------------------------------------------------------------

create policy "match results are readable by authenticated users"
  on public.match_results for select
  to authenticated
  using (true);

create policy "hosts can record results for their rooms"
  on public.match_results for insert
  to authenticated
  with check (
    exists (
      select 1 from public.rooms r
      where r.id = room_id and r.host_id = (select auth.uid())
    )
  );
