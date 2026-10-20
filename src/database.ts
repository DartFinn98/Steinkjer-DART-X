import { supabase } from './supabase'
import type { PlayerMatchStats } from './stats'
import type { CricketDart, CricketMarks } from './cricket'

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

export type TournamentGamePlayer = {
  id: string
  name: string
  score: number
  visits: Array<{
    darts: [number, number, number] | null
    total: number
    bust: boolean
    checkout: boolean
    dartsThrown: number
    legNumber: number
    cricketDarts?: CricketDart[]
  }>
  teamId?: 'A' | 'B'
  cricketMarks?: CricketMarks
  scoreCorrected?: boolean
}

export type TournamentGameHistory = {
  players: TournamentGamePlayer[]
  activePlayer: number
  winnerId: string | null
  legsWon: Record<string, number>
  matchWinnerId: string | null
}

export type TournamentMatchProgress = {
  progressId?: string
  courtNumber?: 1 | 2 | 3 | 4 | 5
  refereeSignupId?: string
  players: TournamentGamePlayer[]
  activePlayer: number
  legsWon: Record<string, number>
  winnerId: string | null
  matchWinnerId: string | null
  legStarterIndex: number
  gamePhase: 'bull-off' | 'leg-bull-off' | 'playing'
  coinStarterIndex: number | null
  bullWinnerId: string
  previousState: TournamentGameHistory | null
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
  refereeSignupId?: string
  bestOfLegs: 3 | 5 | 7 | 9
  inProgress?: TournamentMatchProgress
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

export type ClubDocument = {
  path: string
  name: string
  createdAt: string | null
  size: number
}

export type PendingSyncIssue = {
  kind: PendingChange['kind']
  message: string
}

const DATABASE_NAME = 'darttavla'
const DATABASE_VERSION = 3
const PLAYER_STORE = 'players'
const MATCH_STORE = 'matches'
const PENDING_STORE = 'pending'
const CLUB_SIGNUP_STORE = 'club-signups'
const PROFILE_AVATAR_BUCKET = 'profile-avatars'
const PROFILE_AVATAR_MAX_SIZE = 2 * 1024 * 1024
const CLUB_DOCUMENT_BUCKET = 'club-documents'
const CLUB_DOCUMENT_MAX_SIZE = 25 * 1024 * 1024
const GUEST_SESSION_KEY = 'darttavla-guest-session'

type GuestSession = {
  displayName: string
  savedData: SavedData
}

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

function readGuestSession(): GuestSession | null {
  const storedSession = window.sessionStorage.getItem(GUEST_SESSION_KEY)
  if (!storedSession) return null

  let parsedSession: unknown
  try {
    parsedSession = JSON.parse(storedSession)
  } catch {
    throw new Error('Gjesteøkten kunne ikke leses. Avslutt økten og start på nytt.')
  }

  if (
    typeof parsedSession !== 'object'
    || parsedSession === null
    || !('displayName' in parsedSession)
    || typeof parsedSession.displayName !== 'string'
    || !('savedData' in parsedSession)
    || typeof parsedSession.savedData !== 'object'
    || parsedSession.savedData === null
    || !('players' in parsedSession.savedData)
    || !Array.isArray(parsedSession.savedData.players)
    || !('matches' in parsedSession.savedData)
    || !Array.isArray(parsedSession.savedData.matches)
  ) {
    throw new Error('Gjesteøkten inneholder ugyldige data. Avslutt økten og start på nytt.')
  }

  return parsedSession as GuestSession
}

function writeGuestSession(guestSession: GuestSession): void {
  window.sessionStorage.setItem(GUEST_SESSION_KEY, JSON.stringify(guestSession))
}

export function getGuestDisplayName(): string | null {
  return readGuestSession()?.displayName ?? null
}

export function beginGuestSession(displayName: string): string {
  const normalizedName = displayName.trim().replace(/\s+/g, ' ')
  if (normalizedName.length < 1 || normalizedName.length > 24) {
    throw new Error('Visningsnavnet må være mellom 1 og 24 tegn.')
  }

  writeGuestSession({
    displayName: normalizedName,
    savedData: { players: [], matches: [] },
  })
  return normalizedName
}

export function endGuestSession(): void {
  window.sessionStorage.removeItem(GUEST_SESSION_KEY)
}

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
  const guestSession = readGuestSession()
  if (guestSession) {
    return {
      players: [...guestSession.savedData.players].sort((first, second) => second.lastPlayedAt.localeCompare(first.lastPlayedAt) || first.name.localeCompare(second.name, 'nb')),
      matches: [...guestSession.savedData.matches].sort((first, second) => second.playedAt.localeCompare(first.playedAt)),
    }
  }
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

export async function loadRegisteredPlayerNames(): Promise<string[]> {
  if (!supabase) return []
  const { data, error } = await supabase.rpc('get_registered_player_names')
  if (error) throw error
  if (!Array.isArray(data)) throw new Error('Spillerlisten fra Supabase har ugyldig format.')
  const names: string[] = []
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null || !('display_name' in entry) || typeof entry.display_name !== 'string') {
      throw new Error('Spillerlisten fra Supabase har ugyldig format.')
    }
    names.push(entry.display_name)
  }
  return Array.from(new Set<string>(names))
    .sort((first, second) => first.localeCompare(second, 'nb'))
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

export async function loadClubDocuments(): Promise<ClubDocument[]> {
  if (!supabase) throw new Error('Supabase er ikke konfigurert.')
  if (!navigator.onLine) throw new Error('Du må være på nett for å hente dokumentene.')

  const { data, error } = await supabase.storage
    .from(CLUB_DOCUMENT_BUCKET)
    .list('', { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } })
  if (error) throw error

  return (data ?? [])
    .filter((file) => file.id !== null)
    .map((file) => ({
      path: file.name,
      name: file.name.slice(37),
      createdAt: file.created_at,
      size: Number(file.metadata?.size ?? 0),
    }))
}

export async function uploadClubDocument(file: File): Promise<void> {
  if (!supabase) throw new Error('Supabase er ikke konfigurert.')
  if (!navigator.onLine) throw new Error('Du må være på nett for å laste opp dokumenter.')
  if (file.size === 0) throw new Error('Filen er tom og kan ikke lastes opp.')
  if (file.size > CLUB_DOCUMENT_MAX_SIZE) throw new Error('Dokumentet kan ikke være større enn 25 MB.')

  const safeName = file.name
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 180)
  if (!safeName) throw new Error('Filen mangler et gyldig filnavn.')

  const { error } = await supabase.storage
    .from(CLUB_DOCUMENT_BUCKET)
    .upload(`${crypto.randomUUID()}-${safeName}`, file, {
      cacheControl: '3600',
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    })
  if (error) throw error
}

export async function downloadClubDocument(path: string): Promise<Blob> {
  if (!supabase) throw new Error('Supabase er ikke konfigurert.')
  if (!navigator.onLine) throw new Error('Du må være på nett for å laste ned dokumenter.')

  const { data, error } = await supabase.storage.from(CLUB_DOCUMENT_BUCKET).download(path)
  if (error) throw error
  return data
}

export async function deleteClubDocument(path: string): Promise<void> {
  if (!supabase) throw new Error('Supabase er ikke konfigurert.')
  if (!navigator.onLine) throw new Error('Du må være på nett for å slette dokumenter.')

  const { data, error } = await supabase.storage.from(CLUB_DOCUMENT_BUCKET).remove([path])
  if (error) throw error
  if (!data?.length) throw new Error('Dokumentet kunne ikke slettes. Oppdater listen og prøv igjen.')
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

type ClubTournamentRow = {
  event_date: string
  participants: TournamentParticipant[]
  matches: TournamentMatch[]
  cup_round: number
  created_at: string
  updated_at: string
}

function mapClubTournamentRow(row: ClubTournamentRow): ClubTournament {
  return {
    eventDate: row.event_date,
    participants: row.participants,
    matches: row.matches,
    cupRound: row.cup_round,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function updateTournamentMatch(
  args: {
    target_event_date: string
    target_match_id: string
    operation: 'save-progress' | 'finish-match'
    progress?: TournamentMatchProgress
    progress_id?: string
    player_one_legs?: number
    player_two_legs?: number
  },
): Promise<ClubTournament> {
  if (!supabase) throw new Error('Supabase er ikke konfigurert.')
  if (!navigator.onLine) throw new Error('Du må være på nett for å lagre turneringskampen.')
  const { data, error } = await supabase.rpc('update_club_tournament_match', args)
  if (error) throw error
  const row = Array.isArray(data) ? data.length === 1 ? data[0] : null : data
  if (!row || typeof row !== 'object') throw new Error('Supabase returnerte ikke oppdatert turneringskamp.')
  return mapClubTournamentRow(row as ClubTournamentRow)
}

export function saveTournamentMatchProgress(
  eventDate: string,
  matchId: string,
  progress: TournamentMatchProgress,
): Promise<ClubTournament> {
  return updateTournamentMatch({
    target_event_date: eventDate,
    target_match_id: matchId,
    operation: 'save-progress',
    progress,
  })
}

export function finishTournamentMatch(
  eventDate: string,
  matchId: string,
  progressId: string,
  playerOneLegs: number,
  playerTwoLegs: number,
): Promise<ClubTournament> {
  return updateTournamentMatch({
    target_event_date: eventDate,
    target_match_id: matchId,
    operation: 'finish-match',
    progress_id: progressId,
    player_one_legs: playerOneLegs,
    player_two_legs: playerTwoLegs,
  })
}

export async function addTournamentCupRound(
  eventDate: string,
  roundNumber: number,
  matches: TournamentMatch[],
): Promise<ClubTournament> {
  if (!supabase) throw new Error('Supabase er ikke konfigurert.')
  if (!navigator.onLine) throw new Error('Du må være på nett for å lagre cuprunden.')
  const { data, error } = await supabase.rpc('add_club_tournament_cup_round', {
    target_event_date: eventDate,
    target_round: roundNumber,
    round_matches: matches,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data.length === 1 ? data[0] : null : data
  if (!row || typeof row !== 'object') throw new Error('Supabase returnerte ikke oppdatert cuprunde.')
  return mapClubTournamentRow(row as ClubTournamentRow)
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
  const guestSession = readGuestSession()
  if (guestSession) {
    const players = new Map(guestSession.savedData.players.map((player) => [player.id, player]))
    records.forEach((player) => players.set(player.id, player))
    writeGuestSession({
      ...guestSession,
      savedData: { ...guestSession.savedData, players: Array.from(players.values()) },
    })
    return
  }

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
  const guestSession = readGuestSession()
  if (guestSession) {
    writeGuestSession({
      ...guestSession,
      savedData: {
        ...guestSession.savedData,
        players: guestSession.savedData.players.filter((player) => player.id !== playerId),
      },
    })
    return
  }

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
  const guestSession = readGuestSession()
  if (guestSession) {
    const players = new Map(guestSession.savedData.players.map((player) => [player.id, player]))
    match.players.forEach((player) => players.set(player.name.trim().toLowerCase(), playerRecord(player.name, match.playedAt)))
    writeGuestSession({
      ...guestSession,
      savedData: {
        players: Array.from(players.values()),
        matches: [match, ...guestSession.savedData.matches.filter((savedMatch) => savedMatch.id !== match.id)],
      },
    })
    return
  }

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
  const guestSession = readGuestSession()
  if (guestSession) {
    writeGuestSession({
      ...guestSession,
      savedData: {
        ...guestSession.savedData,
        matches: guestSession.savedData.matches.filter((match) => match.id !== matchId),
      },
    })
    return
  }

  const database = await openDatabase()
  const transaction = database.transaction(MATCH_STORE, 'readwrite')
  transaction.objectStore(MATCH_STORE).delete(matchId)
  await transactionComplete(database, transaction)

  if (!supabase) return
  await queueChange({ kind: 'delete-match', matchId })
  if (navigator.onLine) await syncPendingChanges()
}

export async function sendMatchReport(match: SavedMatch): Promise<'sent' | 'queued' | 'unavailable'> {
  if (readGuestSession()) return 'unavailable'
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

export async function syncPendingChanges(): Promise<{ synced: number; pending: number; issues: PendingSyncIssue[] }> {
  if (!supabase || !navigator.onLine) return { synced: 0, pending: 0, issues: [] }
  const pending = await loadPendingChanges()
  let synced = 0
  const issues: PendingSyncIssue[] = []
  const recordSyncIssue = (change: PendingChange, error: unknown) => {
    console.error(`Could not sync pending ${change.kind} change:`, error)
    const message = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
      ? error.message
      : 'Ukjent feil'
    issues.push({ kind: change.kind, message })
  }

  for (const change of pending) {
    try {
      if (change.kind === 'save-players') {
        const { error } = await supabase.from('players').upsert(change.players.map((player) => ({
          id: player.id,
          name: player.name,
          last_played_at: player.lastPlayedAt,
        })), { onConflict: 'id' })
        if (error) {
          recordSyncIssue(change, error)
          continue
        }
      } else if (change.kind === 'delete-player') {
        const { error } = await supabase.from('players').delete().eq('id', change.playerId)
        if (error) {
          recordSyncIssue(change, error)
          continue
        }
      } else if (change.kind === 'save-match') {
        const playerRecords = change.match.players.map((player) => ({
          id: player.name.trim().toLowerCase(),
          name: player.name.trim(),
          last_played_at: change.match.playedAt,
        }))
        const { error: playersError } = await supabase.from('players').upsert(playerRecords, { onConflict: 'id' })
        if (playersError) {
          recordSyncIssue(change, playersError)
          continue
        }
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
        if (matchError) {
          recordSyncIssue(change, matchError)
          continue
        }
      } else if (change.kind === 'delete-match') {
        const { error } = await supabase.from('matches').delete().eq('id', change.matchId)
        if (error) {
          recordSyncIssue(change, error)
          continue
        }
      } else {
        const { error } = await supabase.functions.invoke('send-match-report', { body: change.match })
        if (error) {
          recordSyncIssue(change, error)
          continue
        }
      }

      await removePendingChange(change.id)
      if (change.kind !== 'send-email') synced += 1
    } catch (error) {
      recordSyncIssue(change, error)
      continue
    }
  }

  const remaining = await loadPendingChanges()
  return {
    synced,
    pending: remaining.filter((change) => change.kind !== 'send-email').length,
    issues,
  }
}
