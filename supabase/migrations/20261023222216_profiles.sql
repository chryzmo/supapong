-- Profiles: one row per (anonymous) auth user, holding the display name.
--
-- Why a separate table instead of auth.users.raw_user_meta_data?
-- Other players need to read each other's names, and auth.users is not exposed
-- through the API.  A public table with RLS gives us readable-by-all,
-- writable-by-owner in a few lines, and lets other tables reference it with
-- real foreign keys.

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null check (length(display_name) between 1 and 24)
);

alter table public.profiles enable row level security;

-- Anyone signed in (anonymous users included) can read every profile.
create policy "profiles are readable by authenticated users"
  on public.profiles for select
  to authenticated
  using (true);

-- You can only create your own profile...
create policy "users can insert their own profile"
  on public.profiles for insert
  to authenticated
  with check (id = (select auth.uid()));

-- ...and only change your own profile.
create policy "users can update their own profile"
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
