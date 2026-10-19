import { supabase } from './supabase'
import type { PlayerMatchStats } from './stats'

export type SavedPlayer = {
  id: string
  name: string
  lastPlayedAt: string
}

export type SavedMatch = {
  id: string
  playedAt: string
  winnerName: string
  courtNumber?: 1 | 2 | 3 | 4 | 5
  gameMode?: '501' | 'cricket' | '121'
  bestOfLegs?: 3 | 5 | 7 | 9
  finishMethod?: 'checkout' | 'bull-off'
  legStarterName?: string
  players: PlayerMatchStats[]
}

export type SavedData = {
  players: SavedPlayer[]
  matches: SavedMatch[]
}

export type ClubSignup = {
  id: string
  eventDate: string
  playerName: string
  signedUpBy?: string
  signedUpAt: string
}

export type ClubAdmin = {
  email: string
  grantedAt: string
}

export type TournamentParticipant = {
  signupId: string
  playerName: string
  seed: number | null
  poolNumber: number | null
  advances: boolean
}

export type TournamentMatch = {
  id: string
  phase: 'pool' | 'cup'
  roundNumber: number
  bracketPosition: number
  poolNumber: number | null
  playerOneSignupId: string
  playerTwoSignupId: string | null
  playerOneLegs: number | null
  playerTwoLegs: number | null
  winnerSignupId: string | null
  bestOfLegs: 3 | 5 | 7 | 9
}

export type ClubTournament = {
  eventDate: string
  participants: TournamentParticipant[]
  matches: TournamentMatch[]
  cupRound: number
  createdAt: string
  updatedAt: string
}

export type LinkedPlayerProfile = {
  userId: string
  playerId: string
}

const DATABASE_NAME = 'darttavla'
const DATABASE_VERSION = 3
const PLAYER_STORE = 'players'
const MATCH_STORE = 'matches'
const PENDING_STORE = 'pending'
const CLUB_SIGNUP_STORE = 'club-signups'
const PROFILE_AVATAR_BUCKET = 'profile-avatars'
const PROFILE_AVATAR_MAX_SIZE = 2 * 1024 * 1024

type PendingChange =
  | { id: string; kind: 'save-players'; players: SavedPlayer[]; queuedAt: number }
  | { id: string; kind: 'delete-player'; playerId: string; queuedAt: number }
  | { id: string; kind: 'save-match'; match: SavedMatch; queuedAt: number }
  | { id: string; kind: 'delete-match'; matchId: string; queuedAt: number }
  | { id: string; kind: 'send-email'; match: SavedMatch; queuedAt: number }

type PendingPayload =
  | { kind: 'save-players'; players: SavedPlayer[] }
  | { kind: 'delete-player'; playerId: string }
  | { kind: 'save-match'; match: SavedMatch }
  | { kind: 'delete-match'; matchId: string }
  | { kind: 'send-email'; match: SavedMatch }

let pendingSequence = 0

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(PLAYER_STORE)) {
        database.createObjectStore(PLAYER_STORE, { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains(MATCH_STORE)) {
        database.createObjectStore(MATCH_STORE, { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains(PENDING_STORE)) {
        database.createObjectStore(PENDING_STORE, { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains(CLUB_SIGNUP_STORE)) {
        database.createObjectStore(CLUB_SIGNUP_STORE, { keyPath: 'id' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Kunne ikke åpne databasen.'))
  })
}

function playerRecord(name: string, playedAt: string): SavedPlayer {
  return {
    id: name.trim().toLowerCase(),
    name: name.trim(),
    lastPlayedAt: playedAt,
  }
}

function transactionComplete(database: IDBDatabase, transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      database.close()
      resolve()
    }
    transaction.onerror = () => {
      database.close()
      reject(transaction.error ?? new Error('Lokal lagring mislyktes.'))
    }
    transaction.onabort = () => {
      database.close()
      reject(transaction.error ?? new Error('Lokal lagring ble avbrutt.'))
    }
  })
}

async function loadLocalSavedData(): Promise<SavedData> {
  const database = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = database.transaction([PLAYER_STORE, MATCH_STORE], 'readonly')
    const playersRequest = transaction.objectStore(PLAYER_STORE).getAll() as IDBRequest<SavedPlayer[]>
    const matchesRequest = transaction.objectStore(MATCH_STORE).getAll() as IDBRequest<SavedMatch[]>
    transaction.oncomplete = () => {
      database.close()
      resolve({
        players: playersRequest.result.sort((first, second) => second.lastPlayedAt.localeCompare(first.lastPlayedAt) || first.name.localeCompare(second.name, 'nb')),
        matches: matchesRequest.result.sort((first, second) => second.playedAt.localeCompare(first.playedAt)),
      })
    }
    transaction.onerror = () => {
      database.close()
      reject(transaction.error ?? new Error('Kunne ikke lese lokal lagring.'))
    }
    transaction.onabort = () => {
      database.close()
      reject(transaction.error ?? new Error('Lesing fra lokal lagring ble avbrutt.'))
    }
  })
}

async function cacheSavedData(data: SavedData): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction([PLAYER_STORE, MATCH_STORE], 'readwrite')
  const players = transaction.objectStore(PLAYER_STORE)
  const matches = transaction.objectStore(MATCH_STORE)
  players.clear()
  matches.clear()
  data.players.forEach((player) => players.put(player))
  data.matches.forEach((match) => matches.put(match))
  await transactionComplete(database, transaction)
}

async function queueChange(change: PendingPayload): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(PENDING_STORE, 'readwrite')
  const queuedAt = Date.now() * 1000 + pendingSequence++ % 1000
  transaction.objectStore(PENDING_STORE).put({
    ...change,
    id: `${queuedAt}-${Math.random().toString(36).slice(2, 10)}`,
    queuedAt,
  })
  await transactionComplete(database, transaction)
}

async function loadPendingChanges(): Promise<PendingChange[]> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PENDING_STORE, 'readonly')
    const request = transaction.objectStore(PENDING_STORE).getAll() as IDBRequest<PendingChange[]>
    transaction.oncomplete = () => {
      database.close()
      resolve(request.result.sort((first, second) => first.queuedAt - second.queuedAt))
    }
    transaction.onerror = () => {
      database.close()
      reject(transaction.error ?? new Error('Kunne ikke lese ventende endringer.'))
    }
  })
}

async function removePendingChange(id: string): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(PENDING_STORE, 'readwrite')
  transaction.objectStore(PENDING_STORE).delete(id)
  await transactionComplete(database, transaction)
}

export async function loadSavedData(): Promise<SavedData> {
  if (!supabase || !navigator.onLine) return loadLocalSavedData()

  try {
    const [playersResult, matchesResult] = await Promise.all([
      supabase.from('players').select('id, name, last_played_at').order('last_played_at', { ascending: false }),
      supabase.from('matches').select('id, played_at, winner_name, court_number, game_mode, best_of_legs, finish_method, leg_starter_name, players').order('played_at', { ascending: false }),
    ])

    if (playersResult.error) throw playersResult.error
    if (matchesResult.error) throw matchesResult.error

    const data = {
      players: (playersResult.data ?? []).map((player) => ({
        id: player.id,
        name: player.name,
        lastPlayedAt: player.last_played_at,
      })),
      matches: (matchesResult.data ?? []).map((match) => ({
        id: match.id,
        playedAt: match.played_at,
        winnerName: match.winner_name,
        courtNumber: match.court_number as SavedMatch['courtNumber'],
        gameMode: match.game_mode as SavedMatch['gameMode'],
        bestOfLegs: match.best_of_legs as 3 | 5 | 7 | 9 | undefined,
        finishMethod: match.finish_method as SavedMatch['finishMethod'],
        legStarterName: match.leg_starter_name ?? undefined,
        players: match.players as SavedMatch['players'],
      })),
    }
    await cacheSavedData(data)
    return data
  } catch {
    return loadLocalSavedData()
  }
}

async function loadLocalClubSignups(): Promise<ClubSignup[]> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CLUB_SIGNUP_STORE, 'readonly')
    const request = transaction.objectStore(CLUB_SIGNUP_STORE).getAll() as IDBRequest<ClubSignup[]>
    transaction.oncomplete = () => {
      database.close()
      resolve(request.result.sort((first, second) => first.eventDate.localeCompare(second.eventDate) || first.signedUpAt.localeCompare(second.signedUpAt)))
    }
    transaction.onerror = () => {
      database.close()
      reject(transaction.error ?? new Error('Kunne ikke lese lokale påmeldinger.'))
    }
    transaction.onabort = () => {
      database.close()
      reject(transaction.error ?? new Error('Lesing av lokale påmeldinger ble avbrutt.'))
    }
  })
}

async function cacheClubSignups(signups: ClubSignup[]): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(CLUB_SIGNUP_STORE, 'readwrite')
  const store = transaction.objectStore(CLUB_SIGNUP_STORE)
  store.clear()
  signups.forEach((signup) => store.put(signup))
  await transactionComplete(database, transaction)
}

export async function loadClubSignups(): Promise<ClubSignup[]> {
  if (!supabase || !navigator.onLine) return loadLocalClubSignups()

  const { data, error } = await supabase
    .from('club_signups')
    .select('id, event_date, player_name, signed_up_by, signed_up_at')
    .order('event_date', { ascending: true })
    .order('signed_up_at', { ascending: true })
  if (error) throw error

  const signups = (data ?? []).map((signup) => ({
    id: signup.id,
    eventDate: signup.event_date,
    playerName: signup.player_name,
    signedUpBy: signup.signed_up_by,
    signedUpAt: signup.signed_up_at,
  }))
  await cacheClubSignups(signups)
  return signups
}

export async function saveClubSignup(eventDate: string, playerName: string, signedUpBy?: string): Promise<void> {
  const normalizedName = playerName.trim().replace(/\s+/g, ' ')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || normalizedName.length < 1 || normalizedName.length > 24) {
    throw new Error('Velg en klubbkveld og skriv inn et navn på 1–24 tegn.')
  }
  if (supabase && (!navigator.onLine || !signedUpBy)) {
    throw new Error(!navigator.onLine ? 'Du må være på nett for å melde deg på.' : 'Logg inn for å melde deg på.')
  }

  const signups = await loadLocalClubSignups()
  const existingSignup = signups.find((signup) => signup.eventDate === eventDate && (
    supabase
      ? signup.signedUpBy === signedUpBy
      : signup.playerName.toLocaleLowerCase('nb-NO') === normalizedName.toLocaleLowerCase('nb-NO')
  ))
  const signup: ClubSignup = {
    id: existingSignup?.id ?? (supabase ? `${eventDate}:${signedUpBy}` : `${eventDate}:${normalizedName.toLocaleLowerCase('nb-NO')}`),
    eventDate,
    playerName: normalizedName,
    ...(signedUpBy ? { signedUpBy } : {}),
    signedUpAt: new Date().toISOString(),
  }

  if (supabase) {
    const { error } = await supabase.from('club_signups').upsert({
      id: signup.id,
      event_date: signup.eventDate,
      player_name: signup.playerName,
      signed_up_by: signup.signedUpBy,
      signed_up_at: signup.signedUpAt,
    }, { onConflict: 'id' })
    if (error) throw error
  }

  await cacheClubSignups([...signups.filter((item) => item.id !== signup.id), signup])
}

export async function deleteClubSignup(signupId: string): Promise<void> {
  if (supabase) {
    if (!navigator.onLine) throw new Error('Du må være på nett for å melde deg av.')
    const { data, error } = await supabase.from('club_signups').delete().eq('id', signupId).select('id').maybeSingle()
    if (error) throw error
    if (!data) throw new Error('Påmeldingen kunne ikke slettes. Oppdater listen og prøv igjen.')
  }

  const signups = await loadLocalClubSignups()
  await cacheClubSignups(signups.filter((signup) => signup.id !== signupId))
}

export async function updateClubSignup(signupId: string, eventDate: string, playerName: string): Promise<void> {
  if (!supabase) throw new Error('Supabase er ikke konfigurert.')
  if (!navigator.onLine) throw new Error('Du må være på nett for å endre en påmelding.')
  const normalizedName = playerName.trim().replace(/\s+/g, ' ')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || normalizedName.length < 1 || normalizedName.length > 24) {
    throw new Error('Velg en klubbkveld og skriv inn et navn på 1–24 tegn.')
  }

  const { data, error } = await supabase.from('club_signups').update({
    event_date: eventDate,
    player_name: normalizedName,
  }).eq('id', signupId).select('id, event_date, player_name, signed_up_by, signed_up_at').maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Påmeldingen kunne ikke endres. Oppdater listen og prøv igjen.')

  const signup: ClubSignup = {
    id: data.id,
    eventDate: data.event_date,
    playerName: data.player_name,
    signedUpBy: data.signed_up_by,
    signedUpAt: data.signed_up_at,
  }
  const signups = await loadLocalClubSignups()
  await cacheClubSignups([...signups.filter((item) => item.id !== signup.id), signup])
}

export async function loadClubAdminStatus(): Promise<boolean> {
  if (!supabase) return false
  const { data, error } = await supabase.rpc('is_club_admin')
  if (error) throw error
  return data === true
}

export async function loadClubAdmins(): Promise<ClubAdmin[]> {
  if (!supabase) throw new Error('Supabase er ikke konfigurert.')
  const { data, error } = await supabase.rpc('get_club_admins')
  if (error) throw error
  return (data ?? []).map((admin: { email: string; granted_at: string }) => ({
    email: admin.email,
    grantedAt: admin.granted_at,
  }))
}

export async function setClubAdminRole(email: string, isAdmin: boolean): Promise<void> {
  if (!supabase) throw new Error('Supabase er ikke konfigurert.')
  if (!navigator.onLine) throw new Error('Du må være på nett for å endre administratorroller.')
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail || normalizedEmail.length > 320) throw new Error('Skriv inn en gyldig e-postadresse.')
  const { error } = await supabase.rpc('set_club_admin', {
    target_email: normalizedEmail,
    make_admin: isAdmin,
  })
  if (error) throw error
}

export async function loadClubTournaments(): Promise<ClubTournament[]> {
  if (!supabase) throw new Error('Supabase er ikke konfigurert.')
  const { data, error } = await supabase
    .from('club_tournaments')
    .select('event_date, participants, matches, cup_round, created_at, updated_at')
    .order('event_date', { ascending: true })
  if (error) throw error
  return (data ?? []).map((tournament) => ({
    eventDate: tournament.event_date,
    participants: tournament.participants as TournamentParticipant[],
    matches: tournament.matches as TournamentMatch[],
    cupRound: tournament.cup_round,
    createdAt: tournament.created_at,
    updatedAt: tournament.updated_at,
  }))
}

export async function saveClubTournament(tournament: ClubTournament): Promise<void> {
  if (!supabase) throw new Error('Supabase er ikke konfigurert.')
  if (!navigator.onLine) throw new Error('Du må være på nett for å lagre turneringen.')
  const { error } = await supabase.from('club_tournaments').upsert({
    event_date: tournament.eventDate,
    participants: tournament.participants,
    matches: tournament.matches,
    cup_round: tournament.cupRound,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'event_date' })
  if (error) throw error
}

export async function deleteClubTournament(eventDate: string): Promise<void> {
  if (!supabase) throw new Error('Supabase er ikke konfigurert.')
  if (!navigator.onLine) throw new Error('Du må være på nett for å slette turneringen.')
  const { error } = await supabase.from('club_tournaments').delete().eq('event_date', eventDate)
  if (error) throw error
}

export async function deleteAllClubTournaments(): Promise<void> {
  if (!supabase) throw new Error('Supabase er ikke konfigurert.')
  if (!navigator.onLine) throw new Error('Du må være på nett for å slette turneringene.')
  const { error } = await supabase.from('club_tournaments').delete().not('event_date', 'is', null)
  if (error) throw error
}

export async function loadLinkedPlayerProfile(userId: string): Promise<{ playerId: string | null; avatarUrl: string | null }> {
  if (!supabase) throw new Error('Supabase er ikke konfigurert.')
  const { data, error } = await supabase
    .from('member_player_profiles')
    .select('player_id, avatar_path')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (!data?.avatar_path) return { playerId: data?.player_id ?? null, avatarUrl: null }

  const { data: signedUrl, error: signedUrlError } = await supabase.storage
    .from(PROFILE_AVATAR_BUCKET)
    .createSignedUrl(data.avatar_path, 60 * 60)
  if (signedUrlError) throw signedUrlError
  return { playerId: data.player_id, avatarUrl: signedUrl.signedUrl }
}

export async function saveLinkedPlayerId(userId: string, playerId: string): Promise<void> {
  if (!supabase) throw new Error('Supabase er ikke konfigurert.')
  if (!playerId.trim()) throw new Error('Velg en spillerprofil.')
  if (!navigator.onLine) throw new Error('Du må være på nett for å lagre spillerprofilen.')

  const { error } = await supabase.from('member_player_profiles').upsert({
    user_id: userId,
    player_id: playerId,
  }, { onConflict: 'user_id' })
  if (error) throw error
}

export async function uploadProfileAvatar(userId: string, file: File): Promise<string> {
  if (!supabase) throw new Error('Supabase er ikke konfigurert.')
  if (!navigator.onLine) throw new Error('Du må være på nett for å laste opp profilbilde.')
  if (file.size > PROFILE_AVATAR_MAX_SIZE) throw new Error('Bildet kan ikke være større enn 2 MB.')

  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  }
  const extension = extensions[file.type]
  if (!extension) throw new Error('Velg et JPG-, PNG- eller WebP-bilde.')

  const { data: profile, error: profileError } = await supabase
    .from('member_player_profiles')
    .select('player_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (profileError) throw profileError
  if (!profile) throw new Error('Knytt kontoen til en spillerprofil før du laster opp bilde.')

  const path = `${userId}/avatar.${extension}`
  const { error: uploadError } = await supabase.storage
    .from(PROFILE_AVATAR_BUCKET)
    .upload(path, file, { cacheControl: '3600', contentType: file.type, upsert: true })
  if (uploadError) throw uploadError

  const { error: profileUpdateError } = await supabase
    .from('member_player_profiles')
    .update({ avatar_path: path })
    .eq('user_id', userId)
  if (profileUpdateError) throw profileUpdateError

  const { data: signedUrl, error: signedUrlError } = await supabase.storage
    .from(PROFILE_AVATAR_BUCKET)
    .createSignedUrl(path, 60 * 60)
  if (signedUrlError) throw signedUrlError
  return signedUrl.signedUrl
}

export async function savePlayers(names: string[]): Promise<void> {
  const playedAt = new Date().toISOString()
  const records = names.map((value) => value.trim()).filter(Boolean).map((name) => playerRecord(name, playedAt))
  const database = await openDatabase()
  const transaction = database.transaction(PLAYER_STORE, 'readwrite')
  for (const player of records) transaction.objectStore(PLAYER_STORE).put(player)
  await transactionComplete(database, transaction)

  if (!supabase || records.length === 0) return
  if (!navigator.onLine) {
    await queueChange({ kind: 'save-players', players: records })
    return
  }

  const { error } = await supabase.from('players').upsert(records.map((player) => ({
    id: player.id,
    name: player.name,
    last_played_at: player.lastPlayedAt,
  })), { onConflict: 'id' })
  if (error) await queueChange({ kind: 'save-players', players: records })
}

export async function deleteSavedPlayer(playerId: string): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(PLAYER_STORE, 'readwrite')
  transaction.objectStore(PLAYER_STORE).delete(playerId)
  await transactionComplete(database, transaction)

  if (!supabase) return
  if (!navigator.onLine) {
    await queueChange({ kind: 'delete-player', playerId })
    return
  }
  const { error } = await supabase.from('players').delete().eq('id', playerId)
  if (error) await queueChange({ kind: 'delete-player', playerId })
}

export async function saveFinishedMatch(match: SavedMatch): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction([PLAYER_STORE, MATCH_STORE], 'readwrite')
  const playerStore = transaction.objectStore(PLAYER_STORE)
  for (const player of match.players) playerStore.put(playerRecord(player.name, match.playedAt))
  transaction.objectStore(MATCH_STORE).put(match)
  await transactionComplete(database, transaction)

  if (!supabase) return
  if (!navigator.onLine) {
    await queueChange({ kind: 'save-match', match })
    return
  }
  const playerRecords = match.players.map((player) => ({
    id: player.name.trim().toLowerCase(),
    name: player.name.trim(),
    last_played_at: match.playedAt,
  }))
  const { error: playersError } = await supabase.from('players').upsert(playerRecords, { onConflict: 'id' })
  const { error: matchError } = playersError ? { error: playersError } : await supabase.from('matches').upsert({
    id: match.id,
    played_at: match.playedAt,
    winner_name: match.winnerName,
    court_number: match.courtNumber ?? 1,
    game_mode: match.gameMode ?? '501',
    best_of_legs: match.bestOfLegs ?? null,
    finish_method: match.finishMethod ?? null,
    leg_starter_name: match.legStarterName ?? null,
    players: match.players,
  }, { onConflict: 'id' })
  if (playersError || matchError) await queueChange({ kind: 'save-match', match })
}

export async function deleteSavedMatch(matchId: string): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(MATCH_STORE, 'readwrite')
  transaction.objectStore(MATCH_STORE).delete(matchId)
  await transactionComplete(database, transaction)

  if (!supabase) return
  await queueChange({ kind: 'delete-match', matchId })
  if (navigator.onLine) await syncPendingChanges()
}

export async function sendMatchReport(match: SavedMatch): Promise<'sent' | 'queued' | 'unavailable'> {
  if (!supabase) return 'unavailable'
  if (!navigator.onLine) {
    await queueChange({ kind: 'send-email', match })
    return 'queued'
  }
  const { error } = await supabase.functions.invoke('send-match-report', { body: match })
  if (error) {
    await queueChange({ kind: 'send-email', match })
    return 'queued'
  }
  return 'sent'
}

export async function syncPendingChanges(): Promise<{ synced: number; pending: number }> {
  if (!supabase || !navigator.onLine) return { synced: 0, pending: 0 }
  const pending = await loadPendingChanges()
  let synced = 0

  for (const change of pending) {
    try {
      if (change.kind === 'save-players') {
        const { error } = await supabase.from('players').upsert(change.players.map((player) => ({
          id: player.id,
          name: player.name,
          last_played_at: player.lastPlayedAt,
        })), { onConflict: 'id' })
        if (error) continue
      } else if (change.kind === 'delete-player') {
        const { error } = await supabase.from('players').delete().eq('id', change.playerId)
        if (error) continue
      } else if (change.kind === 'save-match') {
        const playerRecords = change.match.players.map((player) => ({
          id: player.name.trim().toLowerCase(),
          name: player.name.trim(),
          last_played_at: change.match.playedAt,
        }))
        const { error: playersError } = await supabase.from('players').upsert(playerRecords, { onConflict: 'id' })
        if (playersError) continue
        const { error: matchError } = await supabase.from('matches').upsert({
          id: change.match.id,
          played_at: change.match.playedAt,
          winner_name: change.match.winnerName,
          court_number: change.match.courtNumber ?? 1,
          game_mode: change.match.gameMode ?? '501',
          best_of_legs: change.match.bestOfLegs ?? null,
          finish_method: change.match.finishMethod ?? null,
          leg_starter_name: change.match.legStarterName ?? null,
          players: change.match.players,
        }, { onConflict: 'id' })
        if (matchError) continue
      } else if (change.kind === 'delete-match') {
        const { error } = await supabase.from('matches').delete().eq('id', change.matchId)
        if (error) continue
      } else {
        const { error } = await supabase.functions.invoke('send-match-report', { body: change.match })
        if (error) continue
      }

      await removePendingChange(change.id)
      synced += 1
    } catch {
      continue
    }
  }

  return { synced, pending: pending.length - synced }
}
