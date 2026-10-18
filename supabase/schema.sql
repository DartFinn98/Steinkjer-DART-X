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

alter table public.matches add column if not exists finish_method text;
alter table public.matches add column if not exists leg_starter_name text;
alter table public.matches add column if not exists court_number smallint not null default 1 check (court_number between 1 and 5);
alter table public.matches add column if not exists game_mode text not null default '501' check (game_mode in ('501', 'cricket', '121'));
alter table public.matches drop constraint if exists matches_best_of_legs_check;
alter table public.matches add constraint matches_best_of_legs_check check (best_of_legs in (3, 5, 7, 9));

alter table public.players enable row level security;
alter table public.matches enable row level security;

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
