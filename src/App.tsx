import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { getCheckoutHint } from './checkout'
import { deleteSavedPlayer, loadSavedData, saveFinishedMatch, savePlayers, sendMatchReport, syncPendingChanges } from './database'
import type { SavedData } from './database'
import { supabase } from './supabase'
import type { Session } from '@supabase/supabase-js'
import { summarizePlayer } from './stats'

type DartInputs = [string, string, string]
type ScoredDart = { points: number; isDouble: boolean }
type Visit = { darts: [number, number, number] | null; total: number; bust: boolean; checkout: boolean; dartsThrown: number; legNumber: number }
type Player = { id: string; name: string; score: number; visits: Visit[]; scoreCorrected?: boolean }
type Snapshot = { players: Player[]; activePlayer: number; winnerId: string | null; legsWon: Record<string, number>; matchWinnerId: string | null }
type EntryMode = 'darts' | 'total'
type GamePhase = 'setup' | 'bull-off' | 'leg-bull-off' | 'playing'
type CoinSide = 'kron' | 'mynt'

const DART_OPTION_GROUPS = [
  { label: 'Bom og bull', options: [
    { value: 'MISS', label: 'Bom · 0 poeng' },
    { value: 'SB', label: 'Ytre bull · 25 poeng' },
    { value: 'BULL', label: 'Indre bull · 50 poeng' },
  ] },
  { label: 'Enkel', options: Array.from({ length: 20 }, (_, index) => ({
    value: `S${index + 1}`,
    label: `Enkel ${index + 1} · ${index + 1} poeng`,
  })) },
  { label: 'Dobbel', options: Array.from({ length: 20 }, (_, index) => ({
    value: `D${index + 1}`,
    label: `Dobbel ${index + 1} · ${(index + 1) * 2} poeng`,
  })) },
  { label: 'Trippel', options: Array.from({ length: 20 }, (_, index) => ({
    value: `T${index + 1}`,
    label: `Trippel ${index + 1} · ${(index + 1) * 3} poeng`,
  })) },
]

const QUICK_VISITS: Record<number, DartInputs> = {
  60: ['T20', 'MISS', 'MISS'],
  100: ['T20', 'D20', 'MISS'],
  140: ['T20', 'T20', 'S20'],
  180: ['T20', 'T20', 'T20'],
}

function parseDartNotation(value: string): ScoredDart | null {
  const notation = value.trim().toUpperCase().replace(/\s/g, '')
  if (notation === 'MISS' || notation === '0') return { points: 0, isDouble: false }
  if (notation === 'SB' || notation === '25') return { points: 25, isDouble: false }
  if (notation === 'BULL' || notation === 'DBULL') return { points: 50, isDouble: true }

  const segmentMatch = notation.match(/^([SDT])(20|1[0-9]|[1-9])$/)
  if (segmentMatch) {
    const [, segment, targetValue] = segmentMatch
    const target = Number(targetValue)
    const multiplier = segment === 'T' ? 3 : segment === 'D' ? 2 : 1
    return { points: target * multiplier, isDouble: segment === 'D' }
  }

  if (/^\d+$/.test(notation)) {
    const points = Number(notation)
    if (points <= 60) return { points, isDouble: false }
  }
  return null
}

function App() {
  const [playerCount, setPlayerCount] = useState(2)
  const [bestOfLegs, setBestOfLegs] = useState<3 | 5 | 7>(3)
  const [playerNames, setPlayerNames] = useState<string[]>(['', ''])
  const [newRosterName, setNewRosterName] = useState('')
  const [rosterSlot, setRosterSlot] = useState(0)
  const [playerPendingDeleteId, setPlayerPendingDeleteId] = useState<string | null>(null)
  const [setupCoinChoices, setSetupCoinChoices] = useState<Record<number, CoinSide>>({})
  const [bullCoinChoices, setBullCoinChoices] = useState<Record<string, CoinSide>>({})
  const [coinResult, setCoinResult] = useState<CoinSide | null>(null)
  const [players, setPlayers] = useState<Player[]>([])
  const [activePlayer, setActivePlayer] = useState(0)
  const [legsWon, setLegsWon] = useState<Record<string, number>>({})
  const [matchWinnerId, setMatchWinnerId] = useState<string | null>(null)
  const [legStarterIndex, setLegStarterIndex] = useState(0)
  const [gamePhase, setGamePhase] = useState<GamePhase>('setup')
  const [coinStarterIndex, setCoinStarterIndex] = useState<number | null>(null)
  const [bullWinnerId, setBullWinnerId] = useState('')
  const [winnerId, setWinnerId] = useState<string | null>(null)
  const [history, setHistory] = useState<Snapshot[]>([])
  const [darts, setDarts] = useState<DartInputs>(['', '', ''])
  const [entryMode, setEntryMode] = useState<EntryMode>('darts')
  const [manualTotal, setManualTotal] = useState('')
  const [manualDartsThrown, setManualDartsThrown] = useState<1 | 2 | 3>(3)
  const [manualLastDartDouble, setManualLastDartDouble] = useState(false)
  const [scoreEditPlayerId, setScoreEditPlayerId] = useState<string | null>(null)
  const [scoreEditInput, setScoreEditInput] = useState('')
  const [scoreEditLastDartDouble, setScoreEditLastDartDouble] = useState(false)
  const [scoreEditError, setScoreEditError] = useState('')
  const [message, setMessage] = useState('')
  const [savedData, setSavedData] = useState<SavedData>({ players: [], matches: [] })
  const [databaseMessage, setDatabaseMessage] = useState('')
  const [session, setSession] = useState<Session | null>(null)
  const [authLoading, setAuthLoading] = useState(Boolean(supabase))
  const [authMode, setAuthMode] = useState<'login' | 'signup' | 'reset' | 'update-password'>('login')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authMessage, setAuthMessage] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [emailReportMessage, setEmailReportMessage] = useState('')
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)
  const [reopenedMatchId, setReopenedMatchId] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    let mounted = true
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted) return
      if (error) setAuthMessage('Kunne ikke kontrollere innloggingen. Prøv å laste siden på nytt.')
      setSession(data.session)
      setAuthLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'PASSWORD_RECOVERY') {
        setAuthMode('update-password')
        setAuthMessage('Velg et nytt passord for kontoen din.')
      }
      setSession(nextSession)
      setAuthLoading(false)
    })
    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (supabase && !session) {
      setSavedData({ players: [], matches: [] })
      setPlayerNames([])
      setPlayers([])
      setLegsWon({})
      setWinnerId(null)
      setMatchWinnerId(null)
      setGamePhase('setup')
      return
    }

    let mounted = true
    void loadSavedData().then((data) => {
      if (mounted) setSavedData(data)
    }).catch(() => {
      if (mounted) setDatabaseMessage('Kunne ikke hente spillere og kamper. Sjekk tilkoblingen og prøv igjen.')
    })
    return () => { mounted = false }
  }, [session])

  useEffect(() => {
    const handleOffline = () => {
      setIsOnline(false)
      setDatabaseMessage(supabase
        ? 'Du er offline. Endringer lagres på enheten og synkroniseres når nettet er tilbake.'
        : 'Du er offline. Kampdata lagres i denne nettleseren.')
    }

    const handleOnline = () => {
      setIsOnline(true)
      if (!supabase || !session) {
        setDatabaseMessage('')
        return
      }
      void syncPendingChanges().then(async ({ synced, pending }) => {
        setSavedData(await loadSavedData())
        setDatabaseMessage(pending > 0
          ? `${pending} endringer venter fortsatt på synkronisering.`
          : synced > 0 ? `${synced} endringer ble synkronisert.` : '')
      }).catch(() => {
        setDatabaseMessage('Noen endringer venter fortsatt på synkronisering.')
      })
    }

    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)
    if (!navigator.onLine) handleOffline()
    else if (supabase && session) handleOnline()
    return () => {
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
    }
  }, [session])

  const currentPlayer = players[activePlayer]
  const winner = players.find((player) => player.id === winnerId)
  const scoreEditPlayer = players.find((player) => player.id === scoreEditPlayerId)
  const legsToWin = Math.ceil(bestOfLegs / 2)
  const legNumber = Object.values(legsWon).reduce((total, count) => total + count, 0) + 1
  const checkoutHint = currentPlayer ? getCheckoutHint(currentPlayer.score) : null
  const names = Array.from({ length: playerCount }, (_, index) => playerNames[index] ?? '')
  const setupCoinChoicesReady = names.every((_, index) => setupCoinChoices[index] !== undefined)
  const bullCoinChoicesReady = players.length > 0 && players.every((player) => bullCoinChoices[player.id] !== undefined)
  const bullThrowOrder = players.length > 0 && coinStarterIndex !== null
    ? players.map((_, offset) => players[(coinStarterIndex + offset) % players.length])
    : players

  function beginGame(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (playerCount > 1 && (coinResult === null || coinStarterIndex === null)) return
    const roster = names.map((name, index) => ({
      id: `${Date.now()}-${index}`,
      name: name.trim() || `Spiller ${index + 1}`,
      score: 501,
      visits: [],
    }))
    setPlayers(roster)
    setBullCoinChoices(Object.fromEntries(roster.map((player, index) => [player.id, setupCoinChoices[index]])))
    setActivePlayer(0)
    setLegsWon(Object.fromEntries(roster.map((player) => [player.id, 0])))
    setMatchWinnerId(null)
    setLegStarterIndex(0)
    setGamePhase(roster.length > 1 ? 'bull-off' : 'playing')
    setBullWinnerId('')
    setWinnerId(null)
    setHistory([])
    setDarts(['', '', ''])
    setManualTotal('')
    setManualLastDartDouble(false)
    setMessage('')
    setDatabaseMessage('')
    setEmailReportMessage('')
    setReopenedMatchId(null)
    void savePlayers(roster.map((player) => player.name)).then(() => loadSavedData()).then(setSavedData).catch(() => {
      setDatabaseMessage('Kampen startet, men spillerne kunne ikke lagres.')
    })
  }

  function tossCoin() {
    const result: CoinSide = Math.random() < 0.5 ? 'kron' : 'mynt'
    const firstMatchingIndex = gamePhase === 'setup'
      ? names.findIndex((_, index) => setupCoinChoices[index] === result)
      : players.findIndex((player) => bullCoinChoices[player.id] === result)
    setCoinResult(result)
    setCoinStarterIndex(firstMatchingIndex < 0 ? null : firstMatchingIndex)
  }

  function chooseSetupCoinSide(index: number, side: CoinSide) {
    setSetupCoinChoices((choices) => ({ ...choices, [index]: side }))
    setCoinResult(null)
    setCoinStarterIndex(null)
  }

  function chooseBullCoinSide(playerId: string, side: CoinSide) {
    setBullCoinChoices((choices) => ({ ...choices, [playerId]: side }))
    setCoinResult(null)
    setCoinStarterIndex(null)
  }

  function selectRosterPlayer(name: string) {
    setPlayerNames((current) => {
      const next = [...current]
      next[rosterSlot] = name
      return next
    })
    setSetupCoinChoices((choices) => {
      const next = { ...choices }
      delete next[rosterSlot]
      return next
    })
    setCoinResult(null)
    setCoinStarterIndex(null)
    setCoinResult(null)
    setPlayerPendingDeleteId(null)
    setRosterSlot((rosterSlot + 1) % playerCount)
  }

  function addRosterPlayer() {
    const name = newRosterName.trim()
    if (!name) return
    selectRosterPlayer(name)
    setNewRosterName('')
    void savePlayers([name]).then(() => loadSavedData()).then(setSavedData).catch(() => {
      setDatabaseMessage('Spilleren ble lagt til i oppsettet, men kunne ikke lagres i spillerlisten.')
    })
  }

  async function removeRosterPlayer(playerId: string) {
    const savedPlayer = savedData.players.find((player) => player.id === playerId)
    if (!savedPlayer) return
    try {
      await deleteSavedPlayer(playerId)
      setSavedData(await loadSavedData())
      setPlayerNames((current) => current.map((name) => name.trim().toLowerCase() === playerId ? '' : name))
      setPlayerPendingDeleteId(null)
    } catch {
      setDatabaseMessage('Spilleren kunne ikke slettes fra spillerlisten.')
    }
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    setAuthBusy(true)
    setAuthMessage('')
    try {
      if (authMode === 'reset') {
        const { error } = await supabase.auth.resetPasswordForEmail(authEmail.trim(), {
          redirectTo: `${window.location.origin}/`,
        })
        if (error) throw error
        setAuthMessage('Hvis e-postadressen er registrert, får du en lenke for å opprette nytt passord.')
      } else if (authMode === 'update-password') {
        const { error } = await supabase.auth.updateUser({ password: authPassword })
        if (error) throw error
        await supabase.auth.signOut()
        setAuthPassword('')
        setAuthMode('login')
        setAuthMessage('Passordet er oppdatert. Logg inn med det nye passordet.')
      } else if (authMode === 'signup') {
        const { data, error } = await supabase.auth.signUp({ email: authEmail.trim(), password: authPassword })
        if (error) throw error
        if (!data.session) setAuthMessage('Kontoen er opprettet. Sjekk e-posten din for å bekrefte adressen før du logger inn.')
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: authEmail.trim(), password: authPassword })
        if (error) throw error
      }
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : 'Innloggingen mislyktes. Prøv igjen.')
    } finally {
      setAuthBusy(false)
    }
  }

  function signOut() {
    if (!supabase) return
    void supabase.auth.signOut().catch(() => setDatabaseMessage('Kunne ikke logge ut. Prøv igjen.'))
  }

  function start501() {
    const startingPlayer = players.findIndex((player) => player.id === bullWinnerId)
    if (startingPlayer < 0 || coinStarterIndex === null) return
    setActivePlayer(startingPlayer)
    setLegStarterIndex(startingPlayer)
    setGamePhase('playing')
  }

  function finishLeg(legWinnerId: string, completedPlayers: Player[], finishMethod: 'checkout' | 'bull-off') {
    const nextLegsWon = { ...legsWon, [legWinnerId]: (legsWon[legWinnerId] ?? 0) + 1 }
    const isMatchWon = nextLegsWon[legWinnerId] >= legsToWin
    const legWinner = completedPlayers.find((player) => player.id === legWinnerId)
    setPlayers(completedPlayers)
    setLegsWon(nextLegsWon)
    setWinnerId(legWinnerId)
    setMatchWinnerId(isMatchWon ? legWinnerId : null)
    setGamePhase('playing')

    if (isMatchWon && legWinner) {
      const match = {
        id: reopenedMatchId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        playedAt: new Date().toISOString(),
        winnerName: legWinner.name,
        bestOfLegs,
        finishMethod,
        legStarterName: players[legStarterIndex]?.name,
        players: completedPlayers.map((player) => summarizePlayer(player, nextLegsWon[player.id] ?? 0)),
      }
      void saveFinishedMatch(match).then(() => loadSavedData()).then(setSavedData).catch(() => {
        setDatabaseMessage('Kampen er avgjort, men resultatet kunne ikke lagres.')
      })
      if (supabase) {
        void sendMatchReport(match).then((delivery) => {
          setEmailReportMessage(delivery === 'sent'
            ? `Kampresultatet er sendt til ${session?.user.email ?? 'e-postadressen din'}.`
            : 'E-postrapporten er lagret og sendes når nettet og e-posttjenesten er tilgjengelige.')
        }).catch(() => {
          setEmailReportMessage('Kampen er lagret, men e-postrapporten kunne ikke sendes. Kontroller e-postoppsettet i Supabase.')
        })
      } else {
        setEmailReportMessage('E-postrapport krever Supabase-innlogging.')
      }
    }
  }

  function beginLegBullOff() {
    if (players.length < 2 || !players.some((player) => player.score === 42)) return
    setBullCoinChoices({})
    setCoinResult(null)
    setCoinStarterIndex(null)
    setBullWinnerId('')
    setGamePhase('leg-bull-off')
  }

  function finishLegBullOff() {
    const legWinner = players.find((player) => player.id === bullWinnerId)
    if (!legWinner || !players.some((player) => player.score === 42)) return
    setHistory((items) => [...items, { players, activePlayer, winnerId, legsWon, matchWinnerId }])
    finishLeg(legWinner.id, players, 'bull-off')
  }

  function recordVisit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!currentPlayer || winnerId) return

    let scores: [number, number, number] | null
    let total: number
    let lastDartIsDouble: boolean
    let dartsThrown: number

    if (entryMode === 'total') {
      const parsedTotal = Number(manualTotal)
      if (manualTotal.trim() === '' || !Number.isInteger(parsedTotal) || parsedTotal < 0 || parsedTotal > 180) {
        setMessage('Skriv inn en totalsum fra 0 til 180.')
        return
      }
      scores = null
      total = parsedTotal
      lastDartIsDouble = manualLastDartDouble
      dartsThrown = manualDartsThrown
    } else {
      const scoredDarts = darts.map(parseDartNotation)
      if (scoredDarts.some((dart) => dart === null)) {
        setMessage('Velg et kast for alle tre pilene.')
        return
      }
      const validDarts = scoredDarts as [ScoredDart, ScoredDart, ScoredDart]
      scores = validDarts.map((dart) => dart.points) as [number, number, number]
      total = scores.reduce((sum, score) => sum + score, 0)
      lastDartIsDouble = validDarts[2].isDouble
      dartsThrown = 3
    }

    const remaining = currentPlayer.score - total
    const checkout = remaining === 0 && lastDartIsDouble
    const bust = remaining < 0 || remaining === 1 || (remaining === 0 && !lastDartIsDouble)
    const nextPlayers = players.map((player, index) => index === activePlayer
      ? { ...player, score: bust ? player.score : remaining, visits: [...player.visits, { darts: scores, total, bust, checkout, dartsThrown, legNumber }] }
      : player)

    setHistory((items) => [...items, { players, activePlayer, winnerId, legsWon, matchWinnerId }])
    setPlayers(nextPlayers)
    setActivePlayer((activePlayer + 1) % players.length)
    if (checkout) finishLeg(currentPlayer.id, nextPlayers, 'checkout')
    else setWinnerId(null)
    setDarts(['', '', ''])
    setManualTotal('')
    setManualDartsThrown(3)
    setManualLastDartDouble(false)
    setMessage(bust ? `${currentPlayer.name} gikk bust. Poengsummen står.` : '')
  }

  function undoVisit() {
    const previous = history.at(-1)
    if (!previous) return
    setPlayers(previous.players)
    setActivePlayer(previous.activePlayer)
    setWinnerId(previous.winnerId)
    setLegsWon(previous.legsWon)
    setMatchWinnerId(previous.matchWinnerId)
    setGamePhase('playing')
    setHistory((items) => items.slice(0, -1))
    setDarts(['', '', ''])
    setManualTotal('')
    setManualDartsThrown(3)
    setManualLastDartDouble(false)
    setMessage('Siste tur er angret.')
  }

  function newGame() {
    setPlayers([])
    setActivePlayer(0)
    setLegsWon({})
    setMatchWinnerId(null)
    setLegStarterIndex(0)
    setGamePhase('setup')
    setCoinStarterIndex(null)
    setCoinResult(null)
    setSetupCoinChoices({})
    setBullCoinChoices({})
    setBullWinnerId('')
    setWinnerId(null)
    setHistory([])
    setDarts(['', '', ''])
    setManualTotal('')
    setManualDartsThrown(3)
    setManualLastDartDouble(false)
    setMessage('')
  }

  function startNextLeg() {
    if (!winnerId || matchWinnerId) return
    const nextStarter = (legStarterIndex + 1) % players.length
    setPlayers(players.map((player) => ({ ...player, score: 501, scoreCorrected: false })))
    setWinnerId(null)
    setActivePlayer(nextStarter)
    setLegStarterIndex(nextStarter)
    setHistory([])
    setDarts(['', '', ''])
    setManualTotal('')
    setManualDartsThrown(3)
    setManualLastDartDouble(false)
    setBullWinnerId('')
    setCoinStarterIndex(null)
    setCoinResult(null)
    setBullCoinChoices({})
    setMessage('')
    setEmailReportMessage('')
  }

  function reopenSavedMatch(match: SavedData['matches'][number]) {
    if (!match.finishMethod || match.players.length === 0) return
    const reopenedPlayers = match.players.map((savedPlayer) => ({
      id: savedPlayer.name.trim().toLowerCase(),
      name: savedPlayer.name,
      score: savedPlayer.score,
      visits: savedPlayer.visits.map((visit) => ({ ...visit })),
      scoreCorrected: false,
    }))
    const matchWinnerIndex = reopenedPlayers.findIndex((player) => player.name === match.winnerName)
    if (matchWinnerIndex < 0) return

    let restoredPlayers = reopenedPlayers
    if (match.finishMethod === 'checkout') {
      const finalVisit = reopenedPlayers[matchWinnerIndex].visits.at(-1)
      if (!finalVisit?.checkout) return
      restoredPlayers = reopenedPlayers.map((player, index) => index === matchWinnerIndex
        ? { ...player, score: finalVisit.total, visits: player.visits.slice(0, -1) }
        : player)
    }

    const winnerId = reopenedPlayers[matchWinnerIndex].id
    const restoredLegs = Object.fromEntries(reopenedPlayers.map((player) => [
      player.id,
      Math.max(0, (match.players.find((savedPlayer) => savedPlayer.name === player.name)?.legsWon ?? 0) - (player.id === winnerId ? 1 : 0)),
    ]))
    const savedStarterIndex = match.legStarterName
      ? restoredPlayers.findIndex((player) => player.name === match.legStarterName)
      : matchWinnerIndex
    const starterIndex = savedStarterIndex >= 0 ? savedStarterIndex : matchWinnerIndex

    setPlayerCount(restoredPlayers.length)
    setPlayerNames(restoredPlayers.map((player) => player.name))
    setPlayers(restoredPlayers)
    setLegsWon(restoredLegs)
    setBestOfLegs(match.bestOfLegs ?? 3)
    setActivePlayer(matchWinnerIndex)
    setLegStarterIndex(starterIndex)
    setMatchWinnerId(null)
    setWinnerId(null)
    setHistory([])
    setGamePhase(match.finishMethod === 'bull-off' ? 'leg-bull-off' : 'playing')
    setBullWinnerId('')
    setBullCoinChoices({})
    setCoinResult(null)
    setCoinStarterIndex(null)
    setDarts(['', '', ''])
    setManualTotal('')
    setManualDartsThrown(3)
    setManualLastDartDouble(false)
    setMessage('Kampen er åpnet igjen. Den siste avgjørelsen er rullet tilbake.')
    setEmailReportMessage('')
    setReopenedMatchId(match.id)
  }

  function editPlayerScore(player: Player) {
    if (winnerId) return
    setScoreEditPlayerId(player.id)
    setScoreEditInput(String(player.score))
    setScoreEditLastDartDouble(false)
    setScoreEditError('')
  }

  function closeScoreEditor() {
    setScoreEditPlayerId(null)
    setScoreEditLastDartDouble(false)
    setScoreEditError('')
  }

  function saveScoreCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const player = players.find((item) => item.id === scoreEditPlayerId)
    const correctedScore = Number(scoreEditInput)
    if (!player || !Number.isInteger(correctedScore) || correctedScore < 0 || correctedScore > 501) {
      setScoreEditError('Skriv inn en gyldig poengsum fra 0 til 501.')
      return
    }
    if (correctedScore === 1) {
      setScoreEditError('Du kan ikke stå igjen med 1 poeng. Rett poengsummen eller bruk Angre.')
      return
    }
    if (correctedScore === 0 && !scoreEditLastDartDouble) {
      setScoreEditError('For å rette poengsummen til 0 må du bekrefte at siste pil traff en dobbel.')
      return
    }

    setHistory((items) => [...items, { players, activePlayer, winnerId, legsWon, matchWinnerId }])
    const correctedPlayers = players.map((item) => item.id === player.id
      ? { ...item, score: correctedScore, scoreCorrected: true }
      : item)
    closeScoreEditor()

    if (correctedScore === 0) finishLeg(player.id, correctedPlayers, 'checkout')
    else {
      setPlayers(correctedPlayers)
      setMessage(`${player.name}s poengsum er korrigert.`)
    }
  }

  function changeDart(index: number, value: string) {
    setDarts((current) => current.map((dart, dartIndex) => dartIndex === index ? value : dart) as DartInputs)
    setMessage('')
  }

  function applyCheckoutSuggestion() {
    if (!currentPlayer || !checkoutHint) return
    if (entryMode === 'total') {
      setManualTotal(String(currentPlayer.score))
      setManualLastDartDouble(true)
    } else {
      const route = checkoutHint.split('→').map((dart) => dart.trim())
      const missesBeforeRoute = Array.from({ length: 3 - route.length }, () => 'MISS')
      setDarts([...missesBeforeRoute, ...route] as DartInputs)
    }
    setMessage('Utgangsforslaget er fylt inn. Før poeng for å avslutte.')
  }

  if (supabase && authLoading) {
    return <main className="app-shell auth-shell"><div className="auth-panel"><p className="eyebrow">STEINKJER DART-X</p><h1>Kontrollerer innlogging …</h1></div></main>
  }

  if (import.meta.env.PROD && !supabase) {
    return <main className="app-shell auth-shell"><div className="auth-panel"><p className="eyebrow">STEINKJER DART-X</p><h1>Innlogging er ikke konfigurert</h1><p>Appen må kobles til Supabase før den kan brukes på nett. Se README for oppsett.</p></div></main>
  }

  if (supabase && (!session || authMode === 'update-password')) {
    const isPasswordReset = authMode === 'reset'
    const isPasswordUpdate = authMode === 'update-password'
    return <main className="app-shell auth-shell">
      <header className="topbar"><span className="brand"><img className="brand-logo" src="/logo.png" alt="" /><span>STEINKJER <span className="brand-dot">DART-X</span></span></span><div className="topbar-meta">FELLES KLUBBTAVLE</div></header>
      <section className="auth-layout">
        <div className="auth-copy"><p className="eyebrow">STEINKJER DART-X / KLUBB</p><h1>501<span className="title-period">.</span></h1><p className="intro">{isPasswordUpdate ? 'Velg et nytt passord for å få tilgang til klubbens poengtavle.' : isPasswordReset ? 'Skriv inn e-postadressen til kontoen din, så sender vi deg en tilbakestillingslenke.' : 'Logg inn for å se spillerlisten og kampene til klubben.'}</p></div>
        <form className="auth-panel" onSubmit={submitAuth}>
          <p className="eyebrow">{authMode === 'signup' ? 'NY BRUKER' : isPasswordReset || isPasswordUpdate ? 'GJENOPPRETT TILGANG' : 'KLUBBTILGANG'}</p>
          <h2>{authMode === 'signup' ? 'Opprett konto' : isPasswordReset ? 'Glemt passord' : isPasswordUpdate ? 'Nytt passord' : 'Logg inn'}</h2>
          {!isPasswordUpdate && <label className="auth-field"><span>E-POSTADRESSE</span><input type="email" autoComplete="email" required value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="navn@eksempel.no" /></label>}
          {!isPasswordReset && <label className="auth-field"><span>{isPasswordUpdate ? 'NYTT PASSORD' : 'PASSORD'}</span><input type="password" autoComplete={authMode === 'signup' || isPasswordUpdate ? 'new-password' : 'current-password'} minLength={6} required value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="Minst 6 tegn" /></label>}
          {authMessage && <p className="auth-message" role="status">{authMessage}</p>}
          <button className="primary-button auth-submit" type="submit" disabled={authBusy}>{authBusy ? 'VENT LITT …' : authMode === 'signup' ? 'Opprett konto' : isPasswordReset ? 'Send tilbakestillingslenke' : isPasswordUpdate ? 'Lagre nytt passord' : 'Logg inn'}</button>
          {authMode === 'login' && <><button className="auth-mode-toggle" type="button" onClick={() => { setAuthMode('reset'); setAuthMessage('') }}>Glemt passord?</button><button className="auth-mode-toggle" type="button" onClick={() => { setAuthMode('signup'); setAuthMessage('') }}>Ny bruker? Opprett konto</button></>}
          {authMode === 'signup' && <button className="auth-mode-toggle" type="button" onClick={() => { setAuthMode('login'); setAuthMessage('') }}>Har du allerede konto? Logg inn</button>}
          {authMode === 'reset' && <button className="auth-mode-toggle" type="button" onClick={() => { setAuthMode('login'); setAuthMessage('') }}>Tilbake til innlogging</button>}
        </form>
      </section>
    </main>
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Steinkjer DART-X, tilbake til start" onClick={(event) => { event.preventDefault(); newGame() }}>
          <img className="brand-logo" src="/logo.png" alt="" />
          <span>STEINKJER <span className="brand-dot">DART-X</span></span>
        </a>
        <div className="topbar-meta">{isOnline ? <span className="live-dot" /> : <span className="offline-dot" />} {isOnline ? '501 / DOBBEL UT' : 'OFFLINE'} {session && <button className="sign-out-button" type="button" onClick={signOut}>Logg ut</button>}{!supabase && <span className="local-mode-tag">LOKAL MODUS</span>}</div>
      </header>
      {databaseMessage && <p className="database-message" role="status">{databaseMessage}</p>}

      {players.length === 0 ? (
        <section className="setup-layout">
          <div className="setup-copy">
            <p className="eyebrow">KAMPROM / 01</p>
            <h1>501<span className="title-period">.</span></h1>
            <p className="intro">Følg poengene. Se hvem som leder.</p>
            <div className="rules-line"><span>501</span><i /> DOBBEL UT <i /> FØRST TIL NULL</div>
          </div>
          <form className="setup-panel" onSubmit={beginGame}>
            <div className="panel-heading"><div><p className="eyebrow">NY KAMP</p><h2>Hvem spiller?</h2></div><span className="panel-index">01 — 02</span></div>
            <fieldset className="player-count">
              <legend>ANTALL SPILLERE</legend>
              <div className="count-options">{[1, 2, 3, 4].map((count) => <button key={count} type="button" aria-pressed={playerCount === count} className={playerCount === count ? 'count-option selected' : 'count-option'} onClick={() => { setPlayerCount(count); setRosterSlot((slot) => Math.min(slot, count - 1)); setSetupCoinChoices({}); setCoinResult(null); setCoinStarterIndex(null) }}>{count}</button>)}</div>
            </fieldset>
            <fieldset className="match-format">
              <legend>KAMPFORMAT</legend>
              <div className="format-options">{([3, 5, 7] as const).map((format) => <button key={format} type="button" aria-pressed={bestOfLegs === format} className={bestOfLegs === format ? 'format-option selected' : 'format-option'} onClick={() => setBestOfLegs(format)}>Best av {format}</button>)}</div>
              <p>Først til {Math.ceil(bestOfLegs / 2)} {Math.ceil(bestOfLegs / 2) === 1 ? 'legg' : 'legger'} vinner kampen.</p>
            </fieldset>
            <div className="name-fields">{names.map((name, index) => (
              <label className="name-field" key={index}>
                <span>SPILLER {String(index + 1).padStart(2, '0')}</span>
                <input autoComplete="off" maxLength={24} placeholder={`Spiller ${index + 1}`} value={name} onChange={(event) => { setPlayerNames((items) => { const next = [...items]; next[index] = event.target.value; return next }); setSetupCoinChoices((choices) => { const next = { ...choices }; delete next[index]; return next }); setCoinResult(null); setCoinStarterIndex(null) }} />
              </label>
            ))}</div>
            <section className="player-library" aria-label="Spillerliste">
              <div className="player-library-heading"><div><p className="eyebrow">SPILLERLISTE</p><span>Legg til og velg spillere for kampen.</span></div><span className="player-library-count">{savedData.players.length}</span></div>
              <div className="add-roster-player"><input aria-label="Nytt spillernavn" autoComplete="off" maxLength={24} placeholder="Nytt spillernavn" value={newRosterName} onChange={(event) => setNewRosterName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addRosterPlayer() } }} /><button type="button" disabled={!newRosterName.trim()} onClick={addRosterPlayer}>Legg til</button></div>
              {savedData.players.length > 0 ? <>
                <label className="roster-slot-picker"><span>VELG SPILLERFELT</span><select value={rosterSlot} onChange={(event) => setRosterSlot(Number(event.target.value))}>{names.map((_, index) => <option key={index} value={index}>Spiller {index + 1}</option>)}</select></label>
                <ul className="player-library-list">{savedData.players.map((player) => {
                  const confirmDelete = playerPendingDeleteId === player.id
                  return <li key={player.id}>
                    <span className="player-library-name">{confirmDelete ? `Slette ${player.name}?` : player.name}</span>
                    {confirmDelete ? <div className="player-library-actions"><button className="player-delete-confirm" type="button" onClick={() => void removeRosterPlayer(player.id)}>Ja, slett</button><button type="button" onClick={() => setPlayerPendingDeleteId(null)}>Avbryt</button></div> : <div className="player-library-actions"><button type="button" onClick={() => selectRosterPlayer(player.name)} aria-label={`Velg ${player.name} som spiller ${rosterSlot + 1}`}>Velg</button><button className="player-library-delete" type="button" aria-label={`Slett ${player.name}`} onClick={() => setPlayerPendingDeleteId(player.id)}>Slett</button></div>}
                  </li>
                })}</ul>
              </> : <p className="player-library-empty">Spillerlisten er tom. Legg til et navn for å begynne.</p>}
            </section>
            {playerCount > 1 && <div className="coin-toss-control">
              <p className="coin-choice-label">VELG KRON ELLER MYNT</p>
              <div className="coin-guess-list">{names.map((name, index) => <div className="coin-guess-row" key={index}><span>{name || `Spiller ${index + 1}`}</span><div className="coin-choice-buttons"><button type="button" aria-pressed={setupCoinChoices[index] === 'kron'} onClick={() => chooseSetupCoinSide(index, 'kron')}>Kron</button><button type="button" aria-pressed={setupCoinChoices[index] === 'mynt'} onClick={() => chooseSetupCoinSide(index, 'mynt')}>Mynt</button></div></div>)}</div>
              <button className="coin-toss-button" type="button" disabled={!setupCoinChoicesReady} onClick={tossCoin}><span className="coin-mark" aria-hidden="true">50</span>Kast en mynt</button>
              <p role="status">{coinResult === null ? setupCoinChoicesReady ? 'Alle har valgt. Kast mynten for å se hvem som kaster først.' : 'Velg Kron eller Mynt for hver spiller.' : coinStarterIndex === null ? `${coinResult === 'kron' ? 'Kron' : 'Mynt'} kom opp, men ingen valgte denne siden. Endre valgene og kast igjen.` : `${coinResult === 'kron' ? 'Kron' : 'Mynt'} kom opp. ${names[coinStarterIndex] || `Spiller ${coinStarterIndex + 1}`} kaster først mot bull.`}</p>
            </div>}
            <button className="primary-button start-button" type="submit" disabled={playerCount > 1 && coinStarterIndex === null}>{playerCount > 1 ? 'Start bullkast' : 'Start kamp'} <span aria-hidden="true">↗</span></button>
            <p className="form-note">Spilleren som kommer nærmest bull, starter på 501. Spillernavn lagres automatisk.</p>
          </form>
          {savedData.matches.length > 0 && <section className="saved-history" aria-label="Tidligere kamper">
            <div className="saved-history-heading"><div><p className="eyebrow">LOKALT LAGRET</p><h2>Siste kamper</h2></div><span>{savedData.matches.length} KAMPER</span></div>
            <ul>{savedData.matches.slice(0, 5).map((match) => <li key={match.id}>
              <time dateTime={match.playedAt}>{new Intl.DateTimeFormat('nb-NO', { dateStyle: 'medium' }).format(new Date(match.playedAt))}</time>
              <strong>{match.winnerName} vant</strong>
              <span>{match.players.map((player) => player.legsWon === undefined ? `${player.name}: ${player.score} poeng` : `${player.name}: ${player.legsWon} ${player.legsWon === 1 ? 'legg' : 'legger'}`).join(' · ')}{match.bestOfLegs ? ` · Best av ${match.bestOfLegs}` : ''}</span>
              {match.finishMethod && <button className="reopen-match-button" type="button" onClick={() => reopenSavedMatch(match)}>Åpne kampen igjen</button>}
            </li>)}</ul>
          </section>}
          <div className="setup-stamp" aria-hidden="true">NORSK<br />DART<br /><b>501</b></div>
        </section>
      ) : gamePhase === 'bull-off' ? (
        <section className="bull-off-layout">
          <div className="bull-off-copy">
            <p className="eyebrow">FØR KAMP / BULLKAST</p>
            <h1>BULL<span className="title-period">.</span></h1>
            <p className="intro">Kast mot midten. Spilleren som kommer nærmest bull, starter på 501.</p>
            <div className="rules-line"><span>MYNTKAST</span><i /> BESTEMMER KASTEREKKEFØLGEN</div>
          </div>
          <div className="bull-off-panel">
            <div className="panel-heading"><div><p className="eyebrow">KASTEREKKEFØLGE</p><h2>Hvem kom nærmest bull?</h2></div><span className="panel-index">BULL / 01</span></div>
            <ol className="bull-order">{bullThrowOrder.map((player, index) => <li key={player.id}><span className="bull-order-number">{String(index + 1).padStart(2, '0')}</span><strong>{player.name}</strong>{index === 0 && <span className="bull-first-tag">KASTER FØRST</span>}</li>)}</ol>
            <label className="bull-winner-field"><span>HVEM KOM NÆRMEST BULL?</span><select required value={bullWinnerId} onChange={(event) => setBullWinnerId(event.target.value)}><option value="" disabled>Velg spiller</option>{players.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}</select></label>
            <button className="primary-button start-button" type="button" disabled={!bullWinnerId} onClick={start501}>Start 501 <span aria-hidden="true">↗</span></button>
            <button className="text-button bull-back-button" type="button" onClick={newGame}>Tilbake til oppsett</button>
          </div>
        </section>
      ) : gamePhase === 'leg-bull-off' ? (
        <section className="bull-off-layout">
          <div className="bull-off-copy">
            <p className="eyebrow">42-REGEL / AVGJØR LEGG</p>
            <h1>BULL<span className="title-period">.</span></h1>
            <p className="intro">Myntkastet avgjør hvem som kaster mot bull først. Velg spilleren som kommer nærmest.</p>
            <div className="rules-line"><span>42 IGJEN</span><i /> BULLKAST AVGJØR LEGGVINNEREN</div>
          </div>
          <div className="bull-off-panel">
            <div className="panel-heading"><div><p className="eyebrow">KASTEREKKEFØLGE</p><h2>Hvem kom nærmest bull?</h2></div><span className="panel-index">BULL / 42</span></div>
            <div className="coin-guess-list bull-guess-list">{players.map((player) => <div className="coin-guess-row" key={player.id}><span>{player.name}</span><div className="coin-choice-buttons"><button type="button" aria-pressed={bullCoinChoices[player.id] === 'kron'} onClick={() => chooseBullCoinSide(player.id, 'kron')}>Kron</button><button type="button" aria-pressed={bullCoinChoices[player.id] === 'mynt'} onClick={() => chooseBullCoinSide(player.id, 'mynt')}>Mynt</button></div></div>)}</div>
            <button className="coin-toss-button bull-toss-action" type="button" disabled={!bullCoinChoicesReady} onClick={tossCoin}><span className="coin-mark" aria-hidden="true">50</span>Kast en mynt</button>
            <p className="bull-toss-note" role="status">{coinResult === null ? bullCoinChoicesReady ? 'Alle har valgt. Kast mynten for å se hvem som kaster først.' : 'Velg Kron eller Mynt for hver spiller.' : coinStarterIndex === null ? `${coinResult === 'kron' ? 'Kron' : 'Mynt'} kom opp, men ingen valgte denne siden. Endre valgene og kast igjen.` : `${coinResult === 'kron' ? 'Kron' : 'Mynt'} kom opp. ${bullThrowOrder[0]?.name} kaster først.`}</p>
            {coinStarterIndex !== null && <ol className="bull-order">{bullThrowOrder.map((player, index) => <li key={player.id}><span className="bull-order-number">{String(index + 1).padStart(2, '0')}</span><strong>{player.name}</strong>{index === 0 && <span className="bull-first-tag">KASTER FØRST</span>}</li>)}</ol>}
            <label className="bull-winner-field"><span>HVEM KOM NÆRMEST BULL?</span><select required value={bullWinnerId} onChange={(event) => setBullWinnerId(event.target.value)}><option value="" disabled>Velg spiller</option>{players.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}</select></label>
            <button className="primary-button start-button" type="button" disabled={!bullWinnerId || coinStarterIndex === null} onClick={finishLegBullOff}>Avgjør leggen <span aria-hidden="true">↗</span></button>
            <button className="text-button bull-back-button" type="button" onClick={() => { setBullWinnerId(''); setCoinStarterIndex(null); setCoinResult(null); setBullCoinChoices({}); setGamePhase('playing') }}>Fortsett å spille 501</button>
          </div>
        </section>
      ) : (
        <section className="game-layout">
          <div className="game-heading">
            <div><p className="eyebrow">{matchWinnerId ? <>KAMPEN ER AVGJORT <span className="heading-slash">/</span> BEST AV {bestOfLegs}</> : <>KAMPROM / 01 <span className="heading-slash">/</span> LEGG {String(legNumber).padStart(2, '0')} <span className="heading-slash">/</span> BEST AV {bestOfLegs}</>}</p><h1>501<span className="title-period">.</span></h1></div>
            <div className="game-actions">
              <button className="text-button" type="button" disabled={!history.length || matchWinnerId !== null} onClick={undoVisit}><span aria-hidden="true">↶</span> Angre</button>
              <button className="text-button new-game-button" type="button" onClick={newGame}>Ny kamp <span aria-hidden="true">↗</span></button>
            </div>
          </div>
          {!winnerId && players.length > 1 && players.some((player) => player.score === 42) && <div className="bull-trigger" role="status"><div><span>42 IGJEN</span><strong>Vil dere avgjøre leggen med et kast på bull?</strong></div><button className="bull-trigger-button" type="button" onClick={beginLegBullOff}>Avgjør på bull</button></div>}
          <div className={`player-grid players-${players.length}`}>
            {players.map((player, index) => {
              const isActive = index === activePlayer && !winnerId
              const visibleLeg = winnerId ? legNumber - 1 : legNumber
              const legVisits = player.visits.filter((visit) => visit.legNumber === visibleLeg)
              const lastVisit = legVisits.at(-1)
              const stats = summarizePlayer(player, legsWon[player.id] ?? 0)
              return (
                <article className={`player-card${isActive ? ' is-active' : ''}${player.id === winnerId ? ' is-winner' : ''}`} key={player.id}>
                  <div className="player-card-top"><div className="player-name-wrap"><span className="player-number">{String(index + 1).padStart(2, '0')}</span><h2>{player.name}</h2></div>{isActive && <span className="turn-tag"><span className="live-dot" /> DIN TUR</span>}{player.id === winnerId && <span className="winner-tag">LEGGVINNER</span>}</div>
                  <button className="score-display score-edit-button" type="button" disabled={winnerId !== null} aria-label={`Rett poengsummen til ${player.score} for ${player.name}`} onClick={() => editPlayerScore(player)}>{player.score}<span className="score-edit-cue">{player.scoreCorrected ? 'POENGSUM RETTET' : 'TRYKK PÅ POENGSUMMEN FOR Å RETTE'}</span></button>
                  <div className="legs-progress" aria-label={`${legsWon[player.id] ?? 0} av ${legsToWin} legg`}><div>{Array.from({ length: legsToWin }, (_, legIndex) => <span key={legIndex} className={legIndex < (legsWon[player.id] ?? 0) ? 'leg-pip earned' : 'leg-pip'} />)}</div><span>{legsWon[player.id] ?? 0} / {legsToWin} LEGG</span></div>
                  <div className="player-stats" aria-label={`3-pilssnitt ${stats.average3.toFixed(1)}, ${stats.tons} 100-plussrunder, ${stats.oneEighties} 180-ere`}><div><strong>{stats.average3.toFixed(1)}</strong><span>3-PILSSNITT</span></div><div><strong>{stats.tons}</strong><span>100+</span></div><div><strong>{stats.oneEighties}</strong><span>180</span></div><div><strong>{stats.highestVisit}</strong><span>HØYESTE</span></div></div>
                  <div className="player-card-bottom"><span>{legVisits.length} {legVisits.length === 1 ? 'TUR' : 'TURER'} I LEGG</span>{player.scoreCorrected ? <span className="last-visit">POENGSUM RETTET</span> : lastVisit && <span className={lastVisit.bust ? 'last-visit bust-label' : 'last-visit'}>{lastVisit.bust ? 'SISTE TUR: BUST' : lastVisit.checkout ? 'UTGANG' : `SISTE TUR: ${lastVisit.total}`}</span>}</div>
                </article>
              )
            })}
          </div>
          {winner ? (
            <div className="winner-banner" role="status"><div><p className="eyebrow">{matchWinnerId ? 'KAMPEN ER AVGJORT' : `LEGG ${legNumber - 1} ER FERDIG`}</p><h2>{matchWinnerId ? `${winner.name} vant kampen.` : `${winner.name} vant leggen.`}</h2><p className="match-scoreline">{players.map((player) => `${player.name} ${legsWon[player.id] ?? 0}`).join('  ·  ')} <span>BEST AV {bestOfLegs}</span></p>{matchWinnerId && emailReportMessage && <p className="email-report-status" role="status">{emailReportMessage}</p>}</div><button className="primary-button" type="button" onClick={matchWinnerId ? newGame : startNextLeg}>{matchWinnerId ? 'Ny kamp' : 'Neste legg'} <span aria-hidden="true">↗</span></button></div>
          ) : (
            <form className="score-entry" onSubmit={recordVisit}>
              <div className="entry-title"><div><p className="eyebrow">REGISTRER POENG</p><h2>{currentPlayer?.name}<span> sin tur</span></h2></div><span className="dart-counter">{entryMode === 'total' ? 'TOTALSUM' : '3 KAST'}</span></div>
              {currentPlayer && currentPlayer.score <= 170 && <div className="checkout-hint" aria-live="polite"><div className="checkout-hint-copy"><span>UTGANGSFORSLAG</span><strong>{checkoutHint ?? 'Ingen utgang på tre piler'}</strong></div>{checkoutHint && <button className="checkout-apply" type="button" onClick={applyCheckoutSuggestion}>Bruk forslag</button>}</div>}
              <div className="entry-mode" role="group" aria-label="Registreringsmåte"><button type="button" aria-pressed={entryMode === 'darts'} onClick={() => setEntryMode('darts')}>Velg piler</button><button type="button" aria-pressed={entryMode === 'total'} onClick={() => setEntryMode('total')}>Skriv totalsum</button></div>
              {entryMode === 'darts' ? <div className="dart-inputs">{darts.map((dart, index) => (
                <label className="dart-input" key={index}><span>PIL {index + 1}</span><select aria-label={`Velg kast for pil ${index + 1}`} required value={dart} onChange={(event) => changeDart(index, event.target.value)}><option value="" disabled>Velg kast</option>{DART_OPTION_GROUPS.map((group) => <optgroup key={group.label} label={group.label}>{group.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>)}</select></label>
              ))}<div className="visit-total"><span>TOTAL</span><strong>{darts.reduce((sum, value) => sum + (parseDartNotation(value)?.points ?? 0), 0)}</strong></div><button className="primary-button submit-score" type="submit">Før poeng <span aria-hidden="true">↗</span></button></div> : <div className="manual-score-entry">
                <label className="manual-score-field"><span>TOTALSUM · 0–180</span><input aria-label="Totalsum for turen" autoComplete="off" inputMode="numeric" type="number" min="0" max="180" step="1" required value={manualTotal} onChange={(event) => { setManualTotal(event.target.value); setMessage('') }} placeholder="0" /></label>
                <label className="manual-darts-field"><span>PILER BRUKT</span><select aria-label="Antall piler brukt" value={manualDartsThrown} onChange={(event) => setManualDartsThrown(Number(event.target.value) as 1 | 2 | 3)}><option value={1}>1 pil</option><option value={2}>2 piler</option><option value={3}>3 piler</option></select></label>
                <label className="manual-double-toggle"><input type="checkbox" checked={manualLastDartDouble} onChange={(event) => setManualLastDartDouble(event.target.checked)} /><span className="custom-check" aria-hidden="true" />Siste pil var dobbel</label>
                <button className="primary-button submit-score" type="submit">Før poeng <span aria-hidden="true">↗</span></button>
              </div>}
              <div className="entry-bottom">
                <div className="quick-scores" aria-label="Hurtigvalg for besøket">{Object.entries(QUICK_VISITS).map(([score, values]) => <button key={score} type="button" onClick={() => { if (entryMode === 'total') setManualTotal(score); else setDarts(values); setMessage('') }}>{score}</button>)}</div>
              </div>
              <p className="entry-message" aria-live="polite">{message || (entryMode === 'total' ? 'Ved utgang må du merke av dersom siste pil traff en dobbel.' : 'Velg enkel, dobbel, trippel eller bom for hver pil.')}</p>
            </form>
          )}
          <div className="game-footer"><span>501 <i /> DOBBEL UT</span><span>ANGRE RULLER TILBAKE SISTE TUR</span></div>
        </section>
      )}
      {scoreEditPlayer && <div className="score-edit-backdrop"><section className="score-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="score-edit-title">
        <form onSubmit={saveScoreCorrection}>
          <p className="eyebrow">KORRIGER STILLING</p>
          <h2 id="score-edit-title">{scoreEditPlayer.name}</h2>
          <label className="score-edit-field"><span>GJENVÆRENDE POENG · 0–501</span><input autoFocus aria-label="Korrigert poengsum" inputMode="numeric" type="number" min="0" max="501" step="1" value={scoreEditInput} onChange={(event) => { setScoreEditInput(event.target.value); setScoreEditError('') }} /></label>
          {scoreEditInput === '0' && <label className="manual-double-toggle"><input type="checkbox" checked={scoreEditLastDartDouble} onChange={(event) => setScoreEditLastDartDouble(event.target.checked)} /><span className="custom-check" aria-hidden="true" />Siste pil traff en dobbel</label>}
          <p className="score-edit-note">Endringen kan angres med Angre.</p>
          {scoreEditError && <p className="score-edit-error" role="alert">{scoreEditError}</p>}
          <div className="score-edit-actions"><button className="text-button" type="button" onClick={closeScoreEditor}>Avbryt</button><button className="primary-button" type="submit">Lagre poengsum</button></div>
        </form>
      </section></div>}
    </main>
  )
}

export default App
