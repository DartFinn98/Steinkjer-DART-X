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
  bestOfLegs?: 3 | 5 | 7
  finishMethod?: 'checkout' | 'bull-off'
  legStarterName?: string
  players: PlayerMatchStats[]
}

export type SavedData = {
  players: SavedPlayer[]
  matches: SavedMatch[]
}

const DATABASE_NAME = 'darttavla'
const DATABASE_VERSION = 2
const PLAYER_STORE = 'players'
const MATCH_STORE = 'matches'
const PENDING_STORE = 'pending'

type PendingChange =
  | { id: string; kind: 'save-players'; players: SavedPlayer[]; queuedAt: number }
  | { id: string; kind: 'delete-player'; playerId: string; queuedAt: number }
  | { id: string; kind: 'save-match'; match: SavedMatch; queuedAt: number }
  | { id: string; kind: 'send-email'; match: SavedMatch; queuedAt: number }

type PendingPayload =
  | { kind: 'save-players'; players: SavedPlayer[] }
  | { kind: 'delete-player'; playerId: string }
  | { kind: 'save-match'; match: SavedMatch }
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
      supabase.from('matches').select('id, played_at, winner_name, best_of_legs, finish_method, leg_starter_name, players').order('played_at', { ascending: false }),
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
        bestOfLegs: match.best_of_legs as 3 | 5 | 7 | undefined,
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
    best_of_legs: match.bestOfLegs ?? null,
    finish_method: match.finishMethod ?? null,
    leg_starter_name: match.legStarterName ?? null,
    players: match.players,
  }, { onConflict: 'id' })
  if (playersError || matchError) await queueChange({ kind: 'save-match', match })
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
          best_of_legs: change.match.bestOfLegs ?? null,
          finish_method: change.match.finishMethod ?? null,
          leg_starter_name: change.match.legStarterName ?? null,
          players: change.match.players,
        }, { onConflict: 'id' })
        if (matchError) continue
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
