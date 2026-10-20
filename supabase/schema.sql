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

create table if not exists public.club_tournaments (
  event_date date primary key,
  participants jsonb not null default '[]'::jsonb check (jsonb_typeof(participants) = 'array'),
  matches jsonb not null default '[]'::jsonb check (jsonb_typeof(matches) = 'array'),
  cup_round smallint not null default 0 check (cup_round >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.enforce_unique_tournament_courts()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  active_match jsonb;
  assigned_courts integer[] := '{}';
  court_number integer;
begin
  for active_match in
    select value
    from jsonb_array_elements(new.matches) as matches(value)
    where value ? 'inProgress'
  loop
    if active_match #>> '{inProgress,courtNumber}' is null then
      continue;
    end if;
    if active_match #>> '{inProgress,courtNumber}' !~ '^[1-5]$' then
      raise exception 'Turneringskampen har et ugyldig banenummer.';
    end if;

    court_number := (active_match #>> '{inProgress,courtNumber}')::integer;
    if court_number = any(assigned_courts) then
      raise exception 'Bane % er allerede tildelt en pågående turneringskamp.', court_number;
    end if;
    assigned_courts := array_append(assigned_courts, court_number);
  end loop;

  return new;
end;
$$;

drop trigger if exists enforce_unique_tournament_courts on public.club_tournaments;
create trigger enforce_unique_tournament_courts
  before insert or update of matches on public.club_tournaments
  for each row execute function public.enforce_unique_tournament_courts();

create table if not exists public.club_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now()
);

create table if not exists public.member_player_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  player_id text not null,
  avatar_path text
);

alter table public.member_player_profiles add column if not exists avatar_path text;

create table if not exists public.club_player_directory (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 24)
);

alter table public.club_player_directory enable row level security;
revoke all on public.club_player_directory from public, anon, authenticated;

insert into public.club_player_directory (user_id, display_name)
select
  users.id,
  left(trim(coalesce(
    nullif(trim(users.raw_user_meta_data ->> 'display_name'), ''),
    nullif(players.name, ''),
    nullif(trim(split_part(users.email, '@', 1)), ''),
    'Spiller'
  )), 24)
from auth.users as users
left join public.member_player_profiles as profiles on profiles.user_id = users.id
left join public.players as players on players.id = profiles.player_id
where users.email_confirmed_at is not null
on conflict (user_id) do nothing;

create or replace function public.sync_club_player_directory()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  player_display_name text;
begin
  if new.email_confirmed_at is null then
    return new;
  end if;

  player_display_name := left(trim(regexp_replace(coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(trim(split_part(new.email, '@', 1)), ''),
    'Spiller'
  ), '\s+', ' ', 'g')), 24);

  insert into public.club_player_directory (user_id, display_name)
  values (new.id, player_display_name)
  on conflict (user_id) do update
    set display_name = excluded.display_name;

  return new;
end;
$$;

drop trigger if exists sync_club_player_directory on auth.users;
create trigger sync_club_player_directory
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.sync_club_player_directory();

create or replace function public.get_registered_player_names()
returns table (display_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select names.display_name
  from (
    select distinct directory.display_name
    from public.club_player_directory as directory
  ) as names
  order by lower(names.display_name), names.display_name;
$$;

revoke all on function public.sync_club_player_directory() from public, anon, authenticated;
revoke all on function public.get_registered_player_names() from public;
grant execute on function public.get_registered_player_names() to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-avatars', 'profile-avatars', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('club-documents', 'club-documents', false, 26214400, null)
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
alter table public.club_tournaments enable row level security;
alter table public.club_admins enable row level security;
alter table public.member_player_profiles enable row level security;

create or replace function public.is_club_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.club_admins
    where user_id = (select auth.uid())
  );
$$;

create or replace function public.get_club_admins()
returns table (email text, granted_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_club_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;

  return query
    select users.email::text, admins.granted_at
    from public.club_admins as admins
    join auth.users as users on users.id = admins.user_id
    where users.email is not null
    order by lower(users.email);
end;
$$;

create or replace function public.set_club_admin(target_email text, make_admin boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_user_id uuid;
begin
  if not public.is_club_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if target_email is null or length(trim(target_email)) = 0 then
    raise exception 'Email address is required' using errcode = '22023';
  end if;

  select users.id
    into target_user_id
    from auth.users as users
    where lower(users.email) = lower(trim(target_email))
      and users.email_confirmed_at is not null
    limit 1;
  if target_user_id is null then
    raise exception 'No account found for that email address' using errcode = 'P0002';
  end if;
  if target_user_id = (select auth.uid()) and not make_admin then
    raise exception 'You cannot remove your own administrator role' using errcode = '42501';
  end if;

  if make_admin then
    insert into public.club_admins (user_id)
    values (target_user_id)
    on conflict (user_id) do nothing;
  else
    delete from public.club_admins where user_id = target_user_id;
  end if;
end;
$$;

revoke all on function public.is_club_admin() from public, anon;
revoke all on function public.get_club_admins() from public, anon;
revoke all on function public.set_club_admin(text, boolean) from public, anon;
grant execute on function public.is_club_admin() to authenticated;
grant execute on function public.get_club_admins() to authenticated;
grant execute on function public.set_club_admin(text, boolean) to authenticated;
revoke all on public.club_admins from anon, authenticated;

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

drop policy if exists "Club admins can manage all club signups" on public.club_signups;
create policy "Club admins can manage all club signups"
  on public.club_signups
  for all
  to authenticated
  using ((select public.is_club_admin()))
  with check ((select public.is_club_admin()));

grant select, insert, update, delete on public.club_signups to authenticated;

drop policy if exists "Signed-in members can view club tournaments" on public.club_tournaments;
create policy "Signed-in members can view club tournaments"
  on public.club_tournaments
  for select
  to authenticated
  using ((select auth.uid()) is not null);

drop policy if exists "Club admins can manage tournaments" on public.club_tournaments;
create policy "Club admins can manage tournaments"
  on public.club_tournaments
  for all
  to authenticated
  using ((select public.is_club_admin()))
  with check ((select public.is_club_admin()));

grant select, insert, update, delete on public.club_tournaments to authenticated;

create or replace function public.update_club_tournament_match(
  target_event_date date,
  target_match_id text,
  operation text,
  progress jsonb default null,
  progress_id text default null,
  player_one_legs integer default null,
  player_two_legs integer default null
)
returns public.club_tournaments
language plpgsql
set search_path = public, pg_temp
as $$
declare
  tournament_row public.club_tournaments%rowtype;
  match_data jsonb;
  match_position integer := -1;
  current_position integer;
  legs_to_win integer;
  winner_signup_id text;
begin
  if not public.is_club_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;

  select * into tournament_row
  from public.club_tournaments
  where event_date = target_event_date
  for update;
  if not found then
    raise exception 'Turneringen ble ikke funnet.';
  end if;

  for current_position in 0..jsonb_array_length(tournament_row.matches) - 1 loop
    if tournament_row.matches -> current_position ->> 'id' = target_match_id then
      match_position := current_position;
      exit;
    end if;
  end loop;
  if match_position < 0 then
    raise exception 'Turneringskampen ble ikke funnet.';
  end if;

  match_data := tournament_row.matches -> match_position;
  if (match_data ->> 'winnerSignupId') is not null then
    raise exception 'Turneringskampen er allerede avgjort.';
  end if;

  if operation = 'save-progress' then
    if jsonb_typeof(progress) <> 'object'
      or jsonb_array_length(coalesce(progress -> 'players', '[]'::jsonb)) <> 2
      or coalesce(progress ->> 'progressId', '') = '' then
      raise exception 'Ugyldig kampframdrift.';
    end if;
    if not (match_data ? 'inProgress') and (
      select count(*)
      from jsonb_array_elements(tournament_row.matches) as active_match(value)
      where active_match.value ? 'inProgress'
    ) >= 5 then
      raise exception 'Alle fem banene er i bruk. Vent til en kamp er ferdig.';
    end if;
    if coalesce(match_data #>> '{inProgress,progressId}', '') <> ''
      and (match_data #>> '{inProgress,progressId}') <> (progress ->> 'progressId') then
      raise exception 'Denne turneringskampen er allerede startet på en annen bane.';
    end if;
    match_data := jsonb_set(match_data, '{inProgress}', progress, true);
  elsif operation = 'finish-match' then
    if coalesce(match_data #>> '{inProgress,progressId}', '') <> ''
      and (match_data #>> '{inProgress,progressId}') <> coalesce(progress_id, '') then
      raise exception 'Turneringskampen er startet på en annen bane.';
    end if;
    legs_to_win := (match_data ->> 'bestOfLegs')::integer / 2 + 1;
    if player_one_legs is null
      or player_two_legs is null
      or player_one_legs < 0
      or player_two_legs < 0
      or player_one_legs > legs_to_win
      or player_two_legs > legs_to_win
      or player_one_legs = player_two_legs
      or greatest(player_one_legs, player_two_legs) <> legs_to_win then
      raise exception 'Ugyldig turneringsresultat.';
    end if;
    winner_signup_id := case
      when player_one_legs > player_two_legs then match_data ->> 'playerOneSignupId'
      else match_data ->> 'playerTwoSignupId'
    end;
    match_data := (match_data - 'inProgress') || jsonb_build_object(
      'playerOneLegs', player_one_legs,
      'playerTwoLegs', player_two_legs,
      'winnerSignupId', winner_signup_id
    );
  else
    raise exception 'Ukjent handling for turneringskamp.';
  end if;

  tournament_row.matches := jsonb_set(
    tournament_row.matches,
    array[match_position::text],
    match_data,
    false
  );
  tournament_row.updated_at := now();
  update public.club_tournaments
  set matches = tournament_row.matches,
      updated_at = tournament_row.updated_at
  where event_date = target_event_date
  returning * into tournament_row;

  return tournament_row;
end;
$$;

create or replace function public.add_club_tournament_cup_round(
  target_event_date date,
  target_round smallint,
  round_matches jsonb
)
returns public.club_tournaments
language plpgsql
set search_path = public, pg_temp
as $$
declare
  tournament_row public.club_tournaments%rowtype;
  current_round_matches jsonb;
begin
  if not public.is_club_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;

  select * into tournament_row
  from public.club_tournaments
  where event_date = target_event_date
  for update;
  if not found then
    raise exception 'Turneringen ble ikke funnet.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(tournament_row.matches) as existing_match(value)
    where existing_match.value ->> 'phase' = 'cup'
      and (existing_match.value ->> 'roundNumber')::integer = target_round
  ) then
    return tournament_row;
  end if;

  select coalesce(jsonb_agg(current_match.value), '[]'::jsonb)
  into current_round_matches
  from jsonb_array_elements(tournament_row.matches) as current_match(value)
  where current_match.value ->> 'phase' = 'cup'
    and (current_match.value ->> 'roundNumber')::integer = target_round - 1;
  if jsonb_array_length(current_round_matches) < 2
    or exists (
      select 1
      from jsonb_array_elements(current_round_matches) as current_match(value)
      where coalesce(current_match.value ->> 'winnerSignupId', '') = ''
    ) then
    raise exception 'Fullfør forrige cuprunde før neste runde opprettes.';
  end if;
  if jsonb_typeof(round_matches) <> 'array' or jsonb_array_length(round_matches) = 0 then
    raise exception 'Ugyldig neste cuprunde.';
  end if;

  update public.club_tournaments
  set matches = matches || round_matches,
      cup_round = target_round,
      updated_at = now()
  where event_date = target_event_date
  returning * into tournament_row;

  return tournament_row;
end;
$$;

revoke all on function public.update_club_tournament_match(date, text, text, jsonb, text, integer, integer) from public;
revoke all on function public.add_club_tournament_cup_round(date, smallint, jsonb) from public;
grant execute on function public.update_club_tournament_match(date, text, text, jsonb, text, integer, integer) to authenticated;
grant execute on function public.add_club_tournament_cup_round(date, smallint, jsonb) to authenticated;

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

drop policy if exists "Club admins can view club documents" on storage.objects;
create policy "Club admins can view club documents"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'club-documents'
    and (select public.is_club_admin())
  );

drop policy if exists "Club admins can upload club documents" on storage.objects;
create policy "Club admins can upload club documents"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'club-documents'
    and (select public.is_club_admin())
  );

drop policy if exists "Club admins can delete club documents" on storage.objects;
create policy "Club admins can delete club documents"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'club-documents'
    and (select public.is_club_admin())
  );
