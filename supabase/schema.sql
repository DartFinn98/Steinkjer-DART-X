create table if not exists public.players (
  id text primary key,
  name text not null check (char_length(trim(name)) between 1 and 24),
  last_played_at timestamptz not null default now()
);

create table if not exists public.matches (
  id text primary key,
  played_at timestamptz not null default now(),
  winner_name text not null,
  court_number smallint not null default 1 check (court_number between 1 and 5),
  game_mode text not null default '501' check (game_mode in ('501', 'cricket', '121')),
  best_of_legs smallint check (best_of_legs in (3, 5, 7, 9)),
  finish_method text check (finish_method in ('checkout', 'bull-off')),
  leg_starter_name text,
  players jsonb not null default '[]'::jsonb check (jsonb_typeof(players) = 'array')
);

create table if not exists public.club_signups (
  id text primary key,
  event_date date not null,
  player_name text not null check (char_length(trim(player_name)) between 1 and 24),
  signed_up_by uuid not null references auth.users(id) on delete cascade,
  signed_up_at timestamptz not null default now(),
  unique (event_date, signed_up_by)
);

create table if not exists public.member_player_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  player_id text not null,
  avatar_path text
);

alter table public.member_player_profiles add column if not exists avatar_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-avatars', 'profile-avatars', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

alter table public.matches add column if not exists finish_method text;
alter table public.matches add column if not exists leg_starter_name text;
alter table public.matches add column if not exists court_number smallint not null default 1 check (court_number between 1 and 5);
alter table public.matches add column if not exists game_mode text not null default '501' check (game_mode in ('501', 'cricket', '121'));
alter table public.matches drop constraint if exists matches_best_of_legs_check;
alter table public.matches add constraint matches_best_of_legs_check check (best_of_legs in (3, 5, 7, 9));

alter table public.players enable row level security;
alter table public.matches enable row level security;
alter table public.club_signups enable row level security;
alter table public.member_player_profiles enable row level security;

drop policy if exists "Signed-in members can manage shared players" on public.players;
create policy "Signed-in members can manage shared players"
  on public.players
  for all
  to authenticated
  using ((select auth.uid()) is not null)
  with check ((select auth.uid()) is not null);

drop policy if exists "Signed-in members can manage shared matches" on public.matches;
create policy "Signed-in members can manage shared matches"
  on public.matches
  for all
  to authenticated
  using ((select auth.uid()) is not null)
  with check ((select auth.uid()) is not null);

grant select, insert, update, delete on public.players to authenticated;
grant select, insert, update, delete on public.matches to authenticated;

drop policy if exists "Signed-in members can view club signups" on public.club_signups;
create policy "Signed-in members can view club signups"
  on public.club_signups
  for select
  to authenticated
  using ((select auth.uid()) is not null);

drop policy if exists "Members can manage their own club signups" on public.club_signups;
create policy "Members can manage their own club signups"
  on public.club_signups
  for all
  to authenticated
  using (signed_up_by = (select auth.uid()))
  with check (signed_up_by = (select auth.uid()));

grant select, insert, update, delete on public.club_signups to authenticated;

drop policy if exists "Members can manage their own player profile link" on public.member_player_profiles;
create policy "Members can manage their own player profile link"
  on public.member_player_profiles
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.member_player_profiles to authenticated;

drop policy if exists "Members can view their own profile avatar" on storage.objects;
create policy "Members can view their own profile avatar"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Members can upload their own profile avatar" on storage.objects;
create policy "Members can upload their own profile avatar"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Members can update their own profile avatar" on storage.objects;
create policy "Members can update their own profile avatar"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Members can delete their own profile avatar" on storage.objects;
create policy "Members can delete their own profile avatar"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
