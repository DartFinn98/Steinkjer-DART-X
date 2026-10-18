import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { getCheckoutHint } from './checkout'
import { deleteSavedPlayer, loadSavedData, saveFinishedMatch, savePlayers, sendMatchReport, syncPendingChanges } from './database'
import type { SavedData } from './database'
import { supabase } from './supabase'
import type { Session } from '@supabase/supabase-js'
import { summarizePlayer } from './stats'
import { applyCricketVisit, CRICKET_TARGETS, hasWonCricket } from './cricket'
import type { CricketDart, CricketMarks } from './cricket'

type DartInputs = [string, string, string]
type ScoredDart = { points: number; isDouble: boolean; target: number | null; marks: number }
type GameMode = '501' | 'cricket' | '121'
type Visit = { darts: [number, number, number] | null; total: number; bust: boolean; checkout: boolean; dartsThrown: number; legNumber: number; cricketDarts?: CricketDart[] }
type Player = { id: string; name: string; score: number; visits: Visit[]; teamId?: 'A' | 'B'; cricketMarks?: CricketMarks; scoreCorrected?: boolean }
type Snapshot = { players: Player[]; activePlayer: number; winnerId: string | null; legsWon: Record<string, number>; matchWinnerId: string | null }
type EntryMode = 'darts' | 'total'
type GamePhase = 'setup' | 'bull-off' | 'leg-bull-off' | 'playing'
type CoinSide = 'kron' | 'mynt'
type CoinTossButtonProps = {
  disabled: boolean
  flipping: boolean
  landingSide: CoinSide | null
  result: CoinSide | null
  onClick: () => void
}

function CoinTossButton({ disabled, flipping, landingSide, result, onClick }: CoinTossButtonProps) {
  const coinSide = flipping ? landingSide : result
  const coinClass = flipping
    ? `coin-mark is-flipping spin-to-${landingSide}`
    : `coin-mark${coinSide ? ` landed-${coinSide}` : ''}`

  return <button className="coin-toss-button" type="button" disabled={disabled || flipping} onClick={onClick}>
    <span className={coinClass} aria-hidden="true"><span className="coin-face coin-face-kron">KRON</span><span className="coin-face coin-face-mynt">MYNT</span></span>
    <span>{flipping ? 'Mynten snurrer …' : 'Kast en mynt'}</span>
  </button>
}

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

const CRICKET_DART_OPTION_GROUPS = DART_OPTION_GROUPS.map((group) => ({
  ...group,
  options: group.options.filter((option) => option.value === 'MISS' || option.value === 'SB' || option.value === 'BULL' || /^[SDT](1[5-9]|20)$/.test(option.value)),
})).filter((group) => group.options.length > 0)

const QUICK_VISITS: Record<number, DartInputs> = {
  60: ['T20', 'MISS', 'MISS'],
  100: ['T20', 'D20', 'MISS'],
  140: ['T20', 'T20', 'S20'],
  180: ['T20', 'T20', 'T20'],
}

const CHECKOUT_TABLE = Array.from({ length: 169 }, (_, index) => 170 - index).flatMap((score) => {
  const route = getCheckoutHint(score)
  return route ? [{ score, route: route.replace(/\s+→\s+/g, ' → ') }] : []
})

function parseDartNotation(value: string): ScoredDart | null {
  const notation = value.trim().toUpperCase().replace(/\s/g, '')
  if (notation === 'MISS' || notation === '0') return { points: 0, isDouble: false, target: null, marks: 0 }
  if (notation === 'SB' || notation === '25') return { points: 25, isDouble: false, target: 25, marks: 1 }
  if (notation === 'BULL' || notation === 'DBULL') return { points: 50, isDouble: true, target: 25, marks: 2 }

  const segmentMatch = notation.match(/^([SDT])(20|1[0-9]|[1-9])$/)
  if (segmentMatch) {
    const [, segment, targetValue] = segmentMatch
    const target = Number(targetValue)
    const multiplier = segment === 'T' ? 3 : segment === 'D' ? 2 : 1
    return { points: target * multiplier, isDouble: segment === 'D', target, marks: multiplier }
  }

  if (/^\d+$/.test(notation)) {
    const points = Number(notation)
    if (points <= 60) return { points, isDouble: false, target: null, marks: 0 }
  }
  return null
}

function countCricketMarks(visits: Visit[]): CricketMarks {
  const marks: CricketMarks = Object.fromEntries(CRICKET_TARGETS.map((target) => [target, 0]))
  for (const visit of visits) {
    for (const dart of visit.cricketDarts ?? []) {
      if (dart.target !== null && marks[dart.target] !== undefined) {
        marks[dart.target] = Math.min(3, marks[dart.target] + dart.marks)
      }
    }
  }
  return marks
}

function formatSavedMatchPlayers(match: SavedData['matches'][number]): string {
  if (match.players.some((player) => player.teamId)) {
    return (['A', 'B'] as const).map((teamId) => {
      const members = match.players.filter((player) => player.teamId === teamId)
      if (members.length === 0) return null
      const wins = Math.max(0, ...members.map((player) => player.legsWon ?? 0))
      return `Lag ${teamId} (${members.map((player) => player.name).join(' + ')}): ${wins} ${wins === 1 ? 'legg' : 'legger'}`
    }).filter(Boolean).join(' · ')
  }
  return match.players.map((player) => player.legsWon === undefined
    ? `${player.name}: ${player.score} poeng`
    : `${player.name}: ${player.legsWon} ${match.gameMode === '121' ? player.legsWon === 1 ? 'runde' : 'runder' : player.legsWon === 1 ? 'legg' : 'legger'}`).join(' · ')
}

function App() {
  const [playerCount, setPlayerCount] = useState(2)
  const [gameMode, setGameMode] = useState<GameMode>('501')
  const [teamMode, setTeamMode] = useState(false)
  const teamPreviousPlayerCount = useRef(2)
  const [bestOfLegs, setBestOfLegs] = useState<3 | 5 | 7>(3)
  const [playerNames, setPlayerNames] = useState<string[]>(['', ''])
  const [newRosterName, setNewRosterName] = useState('')
  const [rosterSlot, setRosterSlot] = useState(0)
  const [playerPendingDeleteId, setPlayerPendingDeleteId] = useState<string | null>(null)
  const [coinResult, setCoinResult] = useState<CoinSide | null>(null)
  const [coinFlipping, setCoinFlipping] = useState(false)
  const [coinLandingSide, setCoinLandingSide] = useState<CoinSide | null>(null)
  const coinFlipTimer = useRef<number | null>(null)
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
  const [checkoutTableOpen, setCheckoutTableOpen] = useState(false)
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
  const winnerDisplayName = winner ? teamDisplayName(players, winner) : ''
  const scorePlayers = teamMode
    ? players.filter((player, index) => players.findIndex((candidate) => candidate.teamId === player.teamId) === index)
    : players
  const scoreEditPlayer = players.find((player) => player.id === scoreEditPlayerId)
  const legsToWin = Math.ceil(bestOfLegs / 2)
  const legScorePlayers = teamMode
    ? players.filter((player, index) => players.findIndex((candidate) => candidate.teamId === player.teamId) === index)
    : players
  const legNumber = legScorePlayers.reduce((total, player) => total + (legsWon[player.id] ?? 0), 0) + 1
  const roundWord = gameMode === '121' ? 'RUNDE' : 'LEGG'
  const roundWordLower = gameMode === '121' ? 'runde' : 'legg'
  const roundWordPlural = gameMode === '121' ? 'runder' : 'legger'
  const checkoutHint = currentPlayer && gameMode !== 'cricket' ? getCheckoutHint(currentPlayer.score) : null
  const names = Array.from({ length: playerCount }, (_, index) => playerNames[index] ?? '')
  const bullThrowOrder = players.length > 0 && coinStarterIndex !== null
    ? players.map((_, offset) => players[(coinStarterIndex + offset) % players.length])
    : players

  function teamMembers(roster: Player[], player: Player): Player[] {
    return player.teamId ? roster.filter((member) => member.teamId === player.teamId) : [player]
  }

  function teamDisplayName(roster: Player[], player: Player): string {
    const members = teamMembers(roster, player)
    return members.length > 1 ? members.map((member) => member.name).join(' + ') : player.name
  }

  function selectGameMode(mode: GameMode) {
    cancelCoinFlip()
    setGameMode(mode)
    if (mode === 'cricket' && playerCount === 1) {
      setPlayerCount(2)
      setRosterSlot(0)
    }
    setEntryMode('darts')
    setCoinResult(null)
    setCoinStarterIndex(null)
  }

  function beginGame(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (playerCount > 1 && (coinResult === null || coinStarterIndex === null)) return
    const roster = names.map((name, index) => ({
      id: `${Date.now()}-${index}`,
      name: name.trim() || `Spiller ${index + 1}`,
      score: gameMode === '121' ? 121 : gameMode === '501' ? 501 : 0,
      visits: [],
      ...(teamMode ? { teamId: index % 2 === 0 ? 'A' as const : 'B' as const } : {}),
      ...(gameMode === 'cricket' ? { cricketMarks: Object.fromEntries(CRICKET_TARGETS.map((target) => [target, 0])) } : {}),
    }))
    setPlayers(roster)
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

  function cancelCoinFlip() {
    if (coinFlipTimer.current !== null) {
      window.clearTimeout(coinFlipTimer.current)
      coinFlipTimer.current = null
    }
    setCoinFlipping(false)
    setCoinLandingSide(null)
  }

  function tossCoin() {
    if (coinFlipTimer.current !== null) return
    const result: CoinSide = Math.random() < 0.5 ? 'kron' : 'mynt'
    const participantCount = gamePhase === 'setup' ? names.length : players.length
    const firstMatchingIndex = Math.floor(Math.random() * participantCount)
    setCoinResult(null)
    setCoinStarterIndex(null)
    setCoinLandingSide(result)
    setCoinFlipping(true)
    coinFlipTimer.current = window.setTimeout(() => {
      setCoinResult(result)
      setCoinStarterIndex(firstMatchingIndex)
      setCoinFlipping(false)
      setCoinLandingSide(null)
      coinFlipTimer.current = null
    }, 900)
  }

  function selectRosterPlayer(name: string) {
    setPlayerNames((current) => {
      const next = [...current]
      next[rosterSlot] = name
      return next
    })
    cancelCoinFlip()
    setCoinResult(null)
    setCoinStarterIndex(null)
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

  function startGame() {
    const startingPlayer = players.findIndex((player) => player.id === bullWinnerId)
    if (startingPlayer < 0 || coinStarterIndex === null) return
    setActivePlayer(startingPlayer)
    setLegStarterIndex(startingPlayer)
    setGamePhase('playing')
  }

  function finishLeg(legWinnerId: string, completedPlayers: Player[], finishMethod: 'checkout' | 'bull-off') {
    const legWinner = completedPlayers.find((player) => player.id === legWinnerId)
    const winningPlayers = legWinner ? teamMembers(completedPlayers, legWinner) : []
    const nextLegsWon = { ...legsWon }
    for (const player of winningPlayers) nextLegsWon[player.id] = (nextLegsWon[player.id] ?? 0) + 1
    const isMatchWon = nextLegsWon[legWinnerId] >= legsToWin
    setPlayers(completedPlayers)
    setLegsWon(nextLegsWon)
    setWinnerId(legWinnerId)
    setMatchWinnerId(isMatchWon ? legWinnerId : null)
    setGamePhase('playing')

    if (isMatchWon && legWinner) {
      const match = {
        id: reopenedMatchId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        playedAt: new Date().toISOString(),
        winnerName: teamMode && legWinner ? teamDisplayName(completedPlayers, legWinner) : legWinner?.name ?? '',
        gameMode,
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
    let cricketDarts: CricketDart[] | null = null

    if (entryMode === 'total') {
      if (gameMode === 'cricket') {
        setMessage('Velg kast for hver pil for å registrere Cricket-treff.')
        return
      }
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
      cricketDarts = validDarts.map(({ target, marks }) => ({ target, marks }))
    }

    if (gameMode === 'cricket' && cricketDarts) {
      const opponents = players.filter((player) => teamMode
        ? player.teamId !== currentPlayer.teamId
        : player.id !== currentPlayer.id)
      const result = applyCricketVisit(
        currentPlayer.cricketMarks ?? {},
        opponents.map((player) => player.cricketMarks ?? {}),
        currentPlayer.score,
        cricketDarts,
      )
      const cricketWinner = hasWonCricket(result.marks, result.score, opponents.map((player) => player.score))
      const visitPoints = result.score - currentPlayer.score
      const nextPlayers = players.map((player) => {
        const isCurrentPlayer = player.id === currentPlayer.id
        const sharesTeam = teamMode && player.teamId === currentPlayer.teamId
        return isCurrentPlayer || sharesTeam
          ? { ...player, score: result.score, cricketMarks: result.marks, visits: isCurrentPlayer ? [...player.visits, { darts: scores, total: visitPoints, bust: false, checkout: cricketWinner, dartsThrown, legNumber, cricketDarts }] : player.visits }
          : player
      })

      setHistory((items) => [...items, { players, activePlayer, winnerId, legsWon, matchWinnerId }])
      setPlayers(nextPlayers)
      setActivePlayer((activePlayer + 1) % players.length)
      if (cricketWinner) finishLeg(currentPlayer.id, nextPlayers, 'checkout')
      else setWinnerId(null)
      setDarts(['', '', ''])
      setManualTotal('')
      setMessage(cricketWinner ? 'Alle feltene er lukket. Kampen er avgjort.' : `${visitPoints > 0 ? `${visitPoints} poeng lagt til.` : 'Treffene er registrert.'}`)
      return
    }

    const remaining = currentPlayer.score - total
    const checkout = remaining === 0 && lastDartIsDouble
    const bust = remaining < 0 || remaining === 1 || (remaining === 0 && !lastDartIsDouble)
    const nextPlayers = players.map((player, index) => {
      const isCurrentPlayer = index === activePlayer
      const sharesTeam = teamMode && player.teamId === currentPlayer.teamId
      return isCurrentPlayer || sharesTeam
        ? { ...player, score: bust ? currentPlayer.score : remaining, visits: isCurrentPlayer ? [...player.visits, { darts: scores, total, bust, checkout, dartsThrown, legNumber }] : player.visits }
        : player
    })

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
    cancelCoinFlip()
    setPlayers([])
    setActivePlayer(0)
    setLegsWon({})
    setMatchWinnerId(null)
    setLegStarterIndex(0)
    setGamePhase('setup')
    setCoinStarterIndex(null)
    setCoinResult(null)
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
    setPlayers(players.map((player) => ({
      ...player,
      score: gameMode === '121' ? 121 : gameMode === '501' ? 501 : 0,
      ...(gameMode === 'cricket' ? { cricketMarks: Object.fromEntries(CRICKET_TARGETS.map((target) => [target, 0])) } : {}),
      scoreCorrected: false,
    })))
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
    setMessage('')
    setEmailReportMessage('')
  }

  function reopenSavedMatch(match: SavedData['matches'][number]) {
    if (!match.finishMethod || match.players.length === 0) return
    const isCricket = match.gameMode === 'cricket'
    const reopenedPlayers = match.players.map((savedPlayer) => {
      const marksVisits = savedPlayer.teamId
        ? match.players.filter((player) => player.teamId === savedPlayer.teamId).flatMap((player) => player.visits)
        : savedPlayer.visits
      return {
        id: savedPlayer.name.trim().toLowerCase(),
        name: savedPlayer.name,
        score: savedPlayer.score,
        visits: savedPlayer.visits.map((visit) => ({ ...visit })),
        ...(savedPlayer.teamId ? { teamId: savedPlayer.teamId } : {}),
        ...(isCricket ? { cricketMarks: countCricketMarks(marksVisits) } : {}),
        scoreCorrected: false,
      }
    })
    const reopenedTeamMode = reopenedPlayers.some((player) => player.teamId !== undefined)
    const matchWinnerIndex = reopenedPlayers.findIndex((player) => reopenedTeamMode
      ? teamDisplayName(reopenedPlayers, player) === match.winnerName
      : player.name === match.winnerName)
    if (matchWinnerIndex < 0) return
    const matchWinnerTeamId = reopenedPlayers[matchWinnerIndex].teamId
    const decidingPlayerIndex = match.finishMethod === 'checkout'
      ? reopenedPlayers.findIndex((player) => (!reopenedTeamMode || player.teamId === matchWinnerTeamId) && player.visits.at(-1)?.checkout)
      : matchWinnerIndex
    if (decidingPlayerIndex < 0) return

    let restoredPlayers = reopenedPlayers
    if (match.finishMethod === 'checkout') {
      const finalVisit = reopenedPlayers[decidingPlayerIndex].visits.at(-1)
      if (!finalVisit?.checkout) return
      const winningTeamPlayers = reopenedTeamMode
        ? reopenedPlayers.filter((player) => player.teamId === matchWinnerTeamId)
        : [reopenedPlayers[matchWinnerIndex]]
      const restoredCricketMarks = countCricketMarks(winningTeamPlayers.flatMap((player) => (
        player.id === reopenedPlayers[decidingPlayerIndex].id ? player.visits.slice(0, -1) : player.visits
      )))
      restoredPlayers = reopenedPlayers.map((player, index) => {
        const isWinningTeamMember = index === matchWinnerIndex || (reopenedTeamMode && player.teamId === matchWinnerTeamId)
        return isWinningTeamMember
          ? {
          ...player,
          score: isCricket ? Math.max(0, player.score - finalVisit.total) : finalVisit.total,
            visits: index === decidingPlayerIndex ? player.visits.slice(0, -1) : player.visits,
          ...(isCricket ? { cricketMarks: restoredCricketMarks } : {}),
        }
        : player
      })
    }

    const winnerId = reopenedPlayers[matchWinnerIndex].id
    const restoredLegs = Object.fromEntries(reopenedPlayers.map((player) => [
      player.id,
      Math.max(0, (match.players.find((savedPlayer) => savedPlayer.name === player.name)?.legsWon ?? 0) - (player.id === winnerId || (reopenedTeamMode && player.teamId === matchWinnerTeamId) ? 1 : 0)),
    ]))
    const savedStarterIndex = match.legStarterName
      ? restoredPlayers.findIndex((player) => player.name === match.legStarterName)
      : matchWinnerIndex
    const starterIndex = savedStarterIndex >= 0 ? savedStarterIndex : matchWinnerIndex

    setPlayerCount(restoredPlayers.length)
    setTeamMode(reopenedTeamMode)
    setGameMode(match.gameMode ?? '501')
    setPlayerNames(restoredPlayers.map((player) => player.name))
    setPlayers(restoredPlayers)
    setLegsWon(restoredLegs)
    setBestOfLegs(match.bestOfLegs ?? 3)
    setActivePlayer(decidingPlayerIndex)
    setLegStarterIndex(starterIndex)
    setMatchWinnerId(null)
    setWinnerId(null)
    setHistory([])
    setGamePhase(match.finishMethod === 'bull-off' ? 'leg-bull-off' : 'playing')
    setBullWinnerId('')
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
    const maximumScore = gameMode === '121' ? 121 : 501
    if (!player || gameMode === 'cricket' || !Number.isInteger(correctedScore) || correctedScore < 0 || correctedScore > maximumScore) {
      setScoreEditError(`Skriv inn en gyldig poengsum fra 0 til ${maximumScore}.`)
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
    const correctedPlayers = players.map((item) => item.id === player.id || (teamMode && item.teamId === player.teamId)
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
        <div className="topbar-meta">{isOnline ? <span className="live-dot" /> : <span className="offline-dot" />} {isOnline ? gameMode === 'cricket' ? 'CRICKET' : `${gameMode} / DOBBEL UT` : 'OFFLINE'} {session && <button className="sign-out-button" type="button" onClick={signOut}>Logg ut</button>}{!supabase && <span className="local-mode-tag">LOKAL MODUS</span>}</div>
      </header>
      {databaseMessage && <p className="database-message" role="status">{databaseMessage}</p>}

      {players.length === 0 ? (
        <section className="setup-layout">
          <div className="setup-copy">
            <p className="eyebrow">KAMPROM / 01</p>
            <h1>{gameMode === 'cricket' ? 'Cricket' : gameMode}<span className="title-period">.</span></h1>
            <p className="intro">{gameMode === 'cricket' ? 'Lukk feltene fra 15 til 20 og bull før motstanderen.' : gameMode === '121' ? 'Start på 121 poeng. Avslutt med en dobbel.' : 'Følg poengene. Se hvem som leder.'}</p>
            <div className="rules-line"><span>{gameMode === 'cricket' ? '15–20 + BULL' : gameMode}</span><i /> {gameMode === 'cricket' ? 'TRE TREFF LUKKER' : 'DOBBEL UT'} <i /> {gameMode === 'cricket' ? 'FLERE POENG VINNER' : 'FØRST TIL NULL'}</div>
          </div>
          <form className="setup-panel" onSubmit={beginGame}>
            <div className="panel-heading"><div><p className="eyebrow">NY KAMP</p><h2>Hvem spiller?</h2></div><span className="panel-index">01 — 02</span></div>
            <fieldset className="player-count">
              <legend>ANTALL SPILLERE</legend>
              <div className="count-options">{[1, 2, 3, 4].filter((count) => gameMode !== 'cricket' || count > 1).map((count) => <button key={count} type="button" disabled={teamMode && count !== 4} aria-pressed={playerCount === count} className={playerCount === count ? 'count-option selected' : 'count-option'} onClick={() => { cancelCoinFlip(); setPlayerCount(count); setRosterSlot((slot) => Math.min(slot, count - 1)); setCoinResult(null); setCoinStarterIndex(null) }}>{count}</button>)}</div>
            </fieldset>
            <label className="manual-double-toggle team-mode-toggle"><input type="checkbox" checked={teamMode} onChange={(event) => { const enabled = event.target.checked; cancelCoinFlip(); if (enabled) teamPreviousPlayerCount.current = playerCount; const nextPlayerCount = enabled ? 4 : teamPreviousPlayerCount.current; setTeamMode(enabled); setPlayerCount(nextPlayerCount); setPlayerNames((current) => Array.from({ length: nextPlayerCount }, (_, index) => current[index] ?? '')); setRosterSlot((slot) => Math.min(slot, nextPlayerCount - 1)); setCoinResult(null); setCoinStarterIndex(null) }} /><span className="custom-check" aria-hidden="true" />Spill dobler · 2 mot 2</label>
            <fieldset className="match-format game-mode-format">
              <legend>SPILLTYPE</legend>
              <div className="game-mode-options">{([{ id: '501', label: '501' }, { id: 'cricket', label: 'Cricket' }, { id: '121', label: '121 utgang' }] as const).map((mode) => <button key={mode.id} type="button" aria-pressed={gameMode === mode.id} className={gameMode === mode.id ? 'format-option selected' : 'format-option'} onClick={() => selectGameMode(mode.id)}>{mode.label}</button>)}</div>
              <p>{gameMode === 'cricket' ? 'Tre treff lukker 15–20 og bull. Treff på lukkede felt gir poeng så lenge motstanderen har feltet åpent.' : gameMode === '121' ? 'Hver runde starter på 121. Dobbel ut gjelder.' : 'Først til valgt antall legger vinner kampen.'}</p>
            </fieldset>
            <fieldset className="match-format">
              <legend>KAMPFORMAT</legend>
              <div className="format-options">{([3, 5, 7] as const).map((format) => <button key={format} type="button" aria-pressed={bestOfLegs === format} className={bestOfLegs === format ? 'format-option selected' : 'format-option'} onClick={() => setBestOfLegs(format)}>Best av {format}</button>)}</div>
              <p>Først til {Math.ceil(bestOfLegs / 2)} {gameMode === '121' ? Math.ceil(bestOfLegs / 2) === 1 ? 'runde' : roundWordPlural : Math.ceil(bestOfLegs / 2) === 1 ? 'legg' : roundWordPlural} vinner kampen.</p>
            </fieldset>
            <div className="name-fields">{names.map((name, index) => (
              <label className="name-field" key={index}>
                <span>{teamMode ? `LAG ${index % 2 === 0 ? 'A' : 'B'} · SPILLER ${Math.floor(index / 2) + 1}` : `SPILLER ${String(index + 1).padStart(2, '0')}`}</span>
                <input autoComplete="off" maxLength={24} placeholder={teamMode ? `Lag ${index % 2 === 0 ? 'A' : 'B'} spiller ${Math.floor(index / 2) + 1}` : `Spiller ${index + 1}`} value={name} onChange={(event) => { cancelCoinFlip(); setPlayerNames((items) => { const next = [...items]; next[index] = event.target.value; return next }); setCoinResult(null); setCoinStarterIndex(null) }} />
              </label>
            ))}</div>
            <section className="player-library" aria-label="Spillerliste">
              <div className="player-library-heading"><div><p className="eyebrow">SPILLERLISTE</p><span>Legg til og velg spillere for kampen.</span></div><span className="player-library-count">{savedData.players.length}</span></div>
              <div className="add-roster-player"><input aria-label="Nytt spillernavn" autoComplete="off" maxLength={24} placeholder="Nytt spillernavn" value={newRosterName} onChange={(event) => setNewRosterName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addRosterPlayer() } }} /><button type="button" disabled={!newRosterName.trim()} onClick={addRosterPlayer}>Legg til</button></div>
              {savedData.players.length > 0 ? <>
                <label className="roster-slot-picker"><span>VELG SPILLERFELT</span><select value={rosterSlot} onChange={(event) => setRosterSlot(Number(event.target.value))}>{names.map((_, index) => <option key={index} value={index}>{teamMode ? `Lag ${index % 2 === 0 ? 'A' : 'B'} · Spiller ${Math.floor(index / 2) + 1}` : `Spiller ${index + 1}`}</option>)}</select></label>
                <ul className="player-library-list">{savedData.players.map((player) => {
                  const confirmDelete = playerPendingDeleteId === player.id
                  return <li key={player.id}>
                    <span className="player-library-name">{confirmDelete ? `Slette ${player.name}?` : player.name}</span>
                    {confirmDelete ? <div className="player-library-actions"><button className="player-delete-confirm" type="button" onClick={() => void removeRosterPlayer(player.id)}>Ja, slett</button><button type="button" onClick={() => setPlayerPendingDeleteId(null)}>Avbryt</button></div> : <div className="player-library-actions"><button type="button" onClick={() => selectRosterPlayer(player.name)} aria-label={`Velg ${player.name} som ${teamMode ? `lag ${rosterSlot % 2 === 0 ? 'A' : 'B'} spiller ${Math.floor(rosterSlot / 2) + 1}` : `spiller ${rosterSlot + 1}`}`}>Velg</button><button className="player-library-delete" type="button" aria-label={`Slett ${player.name}`} onClick={() => setPlayerPendingDeleteId(player.id)}>Slett</button></div>}
                  </li>
                })}</ul>
              </> : <p className="player-library-empty">Spillerlisten er tom. Legg til et navn for å begynne.</p>}
            </section>
            {playerCount > 1 && <div className="coin-toss-control">
              <p className="coin-choice-label">KAST MYNTEN FOR Å TREKKE FØRSTE KASTER</p>
              <CoinTossButton disabled={false} flipping={coinFlipping} landingSide={coinLandingSide} result={coinResult} onClick={tossCoin} />
              <p role="status">{coinFlipping ? 'Mynten snurrer …' : coinResult === null ? 'Mynten trekker tilfeldig hvem som kaster først mot bull.' : `${coinResult === 'kron' ? 'Kron' : 'Mynt'} kom opp. ${coinStarterIndex === null ? 'Første kaster er trukket.' : names[coinStarterIndex] || `Spiller ${coinStarterIndex + 1}`} kaster først mot bull.`}</p>
            </div>}
            <button className="primary-button start-button" type="submit" disabled={playerCount > 1 && coinStarterIndex === null}>{playerCount > 1 ? 'Start bullkast' : 'Start kamp'} <span aria-hidden="true">↗</span></button>
            <p className="form-note">{playerCount > 1 ? 'Myntkastet bestemmer rekkefølgen for bullkastet. ' : ''}Spillernavn lagres automatisk.</p>
          </form>
          {savedData.matches.length > 0 && <section className="saved-history" aria-label="Tidligere kamper">
            <div className="saved-history-heading"><div><p className="eyebrow">LOKALT LAGRET</p><h2>Siste kamper</h2></div><span>{savedData.matches.length} KAMPER</span></div>
            <ul>{savedData.matches.slice(0, 5).map((match) => <li key={match.id}>
              <time dateTime={match.playedAt}>{new Intl.DateTimeFormat('nb-NO', { dateStyle: 'medium' }).format(new Date(match.playedAt))}</time>
              <strong>{match.winnerName} vant</strong>
              <span>{match.gameMode && match.gameMode !== '501' ? `${match.gameMode === '121' ? '121 utgang' : 'Cricket'} · ` : ''}{formatSavedMatchPlayers(match)}{match.bestOfLegs ? ` · Best av ${match.bestOfLegs}` : ''}</span>
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
            <p className="intro">Kast mot midten. Spilleren som kommer nærmest bull, starter {gameMode === 'cricket' ? 'kampen' : `på ${gameMode}`}.</p>
            <div className="rules-line"><span>MYNTKAST</span><i /> BESTEMMER KASTEREKKEFØLGEN</div>
          </div>
          <div className="bull-off-panel">
            <div className="panel-heading"><div><p className="eyebrow">KASTEREKKEFØLGE</p><h2>Hvem kom nærmest bull?</h2></div><span className="panel-index">BULL / 01</span></div>
            <ol className="bull-order">{bullThrowOrder.map((player, index) => <li key={player.id}><span className="bull-order-number">{String(index + 1).padStart(2, '0')}</span><strong>{player.name}</strong>{index === 0 && <span className="bull-first-tag">KASTER FØRST</span>}</li>)}</ol>
            <label className="bull-winner-field"><span>HVEM KOM NÆRMEST BULL?</span><select required value={bullWinnerId} onChange={(event) => setBullWinnerId(event.target.value)}><option value="" disabled>Velg spiller</option>{players.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}</select></label>
            <button className="primary-button start-button" type="button" disabled={!bullWinnerId} onClick={startGame}>Start {gameMode === 'cricket' ? 'Cricket' : gameMode} <span aria-hidden="true">↗</span></button>
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
            <p className="bull-toss-note">Kast mynten for å trekke første kaster.</p>
            <CoinTossButton disabled={false} flipping={coinFlipping} landingSide={coinLandingSide} result={coinResult} onClick={tossCoin} />
            <p className="bull-toss-note" role="status">{coinFlipping ? 'Mynten snurrer …' : coinResult === null ? 'Mynten trekker tilfeldig hvem som kaster først.' : `${coinResult === 'kron' ? 'Kron' : 'Mynt'} kom opp. ${bullThrowOrder[0]?.name} kaster først.`}</p>
            {coinStarterIndex !== null && <ol className="bull-order">{bullThrowOrder.map((player, index) => <li key={player.id}><span className="bull-order-number">{String(index + 1).padStart(2, '0')}</span><strong>{player.name}</strong>{index === 0 && <span className="bull-first-tag">KASTER FØRST</span>}</li>)}</ol>}
            <label className="bull-winner-field"><span>HVEM KOM NÆRMEST BULL?</span><select required value={bullWinnerId} onChange={(event) => setBullWinnerId(event.target.value)}><option value="" disabled>Velg spiller</option>{players.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}</select></label>
            <button className="primary-button start-button" type="button" disabled={!bullWinnerId || coinStarterIndex === null} onClick={finishLegBullOff}>Avgjør leggen <span aria-hidden="true">↗</span></button>
            <button className="text-button bull-back-button" type="button" onClick={() => { cancelCoinFlip(); setBullWinnerId(''); setCoinStarterIndex(null); setCoinResult(null); setGamePhase('playing') }}>Fortsett å spille</button>
          </div>
        </section>
      ) : (
        <section className="game-layout">
          <div className="game-heading">
            <div><p className="eyebrow">{matchWinnerId ? <>KAMPEN ER AVGJORT <span className="heading-slash">/</span> BEST AV {bestOfLegs}</> : <>KAMPROM / 01 <span className="heading-slash">/</span> {roundWord} {String(legNumber).padStart(2, '0')} <span className="heading-slash">/</span> BEST AV {bestOfLegs}</>}</p><h1>{gameMode === 'cricket' ? 'Cricket' : gameMode}<span className="title-period">.</span></h1></div>
            <div className="game-actions">
              <button className="text-button" type="button" disabled={!history.length || matchWinnerId !== null} onClick={undoVisit}><span aria-hidden="true">↶</span> Angre</button>
              <button className="text-button new-game-button" type="button" onClick={newGame}>Ny kamp <span aria-hidden="true">↗</span></button>
            </div>
          </div>
          {gameMode === '501' && !winnerId && players.length > 1 && players.some((player) => player.score === 42) && <div className="bull-trigger" role="status"><div><span>42 IGJEN</span><strong>Vil dere avgjøre leggen med et kast på bull?</strong></div><button className="bull-trigger-button" type="button" onClick={beginLegBullOff}>Avgjør på bull</button></div>}
          <div className={`player-grid players-${players.length}`}>
            {players.map((player, index) => {
              const isActive = index === activePlayer && !winnerId
              const visibleLeg = winnerId ? legNumber - 1 : legNumber
              const legVisits = player.visits.filter((visit) => visit.legNumber === visibleLeg)
              const lastVisit = legVisits.at(-1)
              const playerLegsWon = teamMode
                ? Math.max(0, ...teamMembers(players, player).map((member) => legsWon[member.id] ?? 0))
                : legsWon[player.id] ?? 0
              const isTeamWinner = Boolean(teamMode && winner && player.teamId === winner.teamId)
              const stats = summarizePlayer(player, playerLegsWon)
              return (
                <article className={`player-card${isActive ? ' is-active' : ''}${player.id === winnerId || isTeamWinner ? ' is-winner' : ''}`} key={player.id}>
                  <div className="player-card-top"><div className="player-name-wrap"><span className="player-number">{String(index + 1).padStart(2, '0')}</span><h2>{player.name}</h2>{player.teamId && <span className="player-team-tag">LAG {player.teamId}</span>}</div>{isActive && <span className="turn-tag"><span className="live-dot" /> DIN TUR</span>}{(player.id === winnerId || isTeamWinner) && <span className="winner-tag">{teamMode ? 'LAGSEIER' : `${roundWord}VINNER`}</span>}</div>
                  {gameMode === 'cricket' ? <div className="score-display cricket-score" aria-label={`${player.score} poeng`}>{player.score}<span>POENG</span></div> : <button className="score-display score-edit-button" type="button" disabled={winnerId !== null} aria-label={`Rett poengsummen til ${player.score} for ${player.name}`} onClick={() => editPlayerScore(player)}>{player.score}<span className="score-edit-cue">{player.scoreCorrected ? 'POENGSUM RETTET' : 'TRYKK PÅ POENGSUMMEN FOR Å RETTE'}</span></button>}
                  {gameMode === 'cricket' && <div className="cricket-mark-board" aria-label={`Cricket-felt for ${player.name}`}>{CRICKET_TARGETS.map((target) => {
                    const marks = player.cricketMarks?.[target] ?? 0
                    return <div className="cricket-mark" key={target} aria-label={`${target === 25 ? 'Bull' : target}: ${marks} av 3 treff`}><strong>{target === 25 ? 'BULL' : target}</strong><span>{[0, 1, 2].map((mark) => <i key={mark} className={mark < marks ? 'marked' : ''} />)}</span></div>
                  })}</div>}
                  <div className="legs-progress" aria-label={`${playerLegsWon} av ${legsToWin} ${roundWordPlural}`}><div>{Array.from({ length: legsToWin }, (_, legIndex) => <span key={legIndex} className={legIndex < playerLegsWon ? 'leg-pip earned' : 'leg-pip'} />)}</div><span>{playerLegsWon} / {legsToWin} {roundWordPlural.toUpperCase()}</span></div>
                  {gameMode !== 'cricket' && <div className={`player-stats${gameMode === '501' ? ' has-fastest-checkout' : ''}`} aria-label={`3-pilssnitt ${stats.average3.toFixed(1)}, ${stats.tons} 100-plussrunder, ${stats.oneEighties} 180-ere${gameMode === '501' ? `, raskeste 501-utgang ${stats.fastestCheckoutDarts === null ? 'ikke registrert' : `${stats.fastestCheckoutDarts} piler`}` : ''}`}><div><strong>{stats.average3.toFixed(1)}</strong><span>3-PILSSNITT</span></div><div><strong>{stats.tons}</strong><span>100+</span></div><div><strong>{stats.oneEighties}</strong><span>180</span></div><div><strong>{stats.highestVisit}</strong><span>HØYESTE</span></div>{gameMode === '501' && <div><strong>{stats.fastestCheckoutDarts ?? '—'}</strong><span title="Færrest piler brukt på en 501-legg">RASK 501</span></div>}</div>}
                  <div className="player-card-bottom"><span>{legVisits.length} {legVisits.length === 1 ? 'TUR' : 'TURER'} I {roundWord}</span>{player.scoreCorrected ? <span className="last-visit">POENGSUM RETTET</span> : lastVisit && <span className={lastVisit.bust ? 'last-visit bust-label' : 'last-visit'}>{lastVisit.bust ? 'SISTE TUR: BUST' : lastVisit.checkout ? 'UTGANG' : `SISTE TUR: ${lastVisit.total}`}</span>}</div>
                </article>
              )
            })}
          </div>
          {winner ? (
            <div className="winner-banner" role="status"><div><p className="eyebrow">{matchWinnerId ? 'KAMPEN ER AVGJORT' : `${roundWord} ${legNumber - 1} ER FERDIG`}</p><h2>{matchWinnerId ? `${winnerDisplayName} vant kampen.` : `${winnerDisplayName} vant ${roundWordLower}en.`}</h2><p className="match-scoreline">{scorePlayers.map((player) => `${teamMode ? `Lag ${player.teamId} (${teamMembers(players, player).map((member) => member.name).join(' + ')})` : player.name} ${legsWon[player.id] ?? 0}`).join('  ·  ')} <span>BEST AV {bestOfLegs}</span></p>{matchWinnerId && emailReportMessage && <p className="email-report-status" role="status">{emailReportMessage}</p>}</div><button className="primary-button" type="button" onClick={matchWinnerId ? newGame : startNextLeg}>{matchWinnerId ? 'Ny kamp' : `Neste ${roundWordLower}`} <span aria-hidden="true">↗</span></button></div>
          ) : (
            <form className="score-entry" onSubmit={recordVisit}>
              <div className="entry-title"><div><p className="eyebrow">{gameMode === 'cricket' ? 'REGISTRER TREFF' : 'REGISTRER POENG'}</p><h2>{currentPlayer?.name}<span> sin tur</span></h2></div><span className="dart-counter">{entryMode === 'total' && gameMode !== 'cricket' ? 'TOTALSUM' : '3 KAST'}</span></div>
              {gameMode === '501' && <button className="checkout-table-toggle" type="button" aria-expanded={checkoutTableOpen} aria-controls="checkout-table" onClick={() => setCheckoutTableOpen((open) => !open)}><span aria-hidden="true">{checkoutTableOpen ? '−' : '+'}</span>{checkoutTableOpen ? 'Skjul utgangstabell' : 'Utgangstabell'}</button>}
              {gameMode === '501' && <section className="checkout-table" id="checkout-table" aria-label="Utgangstabell for 501 med dobbel ut" hidden={!checkoutTableOpen}><div className="checkout-table-heading"><strong>501 · DOBBEL UT</strong><span>Utganger fra 2 til 170</span></div><div className="checkout-table-grid">{CHECKOUT_TABLE.map(({ score, route }) => <div className="checkout-table-row" key={score}><strong>{score}</strong><span>{route}</span></div>)}</div></section>}
              {gameMode !== 'cricket' && currentPlayer && currentPlayer.score <= 170 && <div className="checkout-hint" aria-live="polite"><div className="checkout-hint-copy"><span>UTGANGSFORSLAG</span><strong>{checkoutHint ?? 'Ingen utgang på tre piler'}</strong></div>{checkoutHint && <button className="checkout-apply" type="button" onClick={applyCheckoutSuggestion}>Bruk forslag</button>}</div>}
              {gameMode === 'cricket' ? <p className="cricket-entry-note">Registrer treff på 15–20 og bull for hver pil. Trippel gir tre treff, dobbel bull gir to.</p> : <div className="entry-mode" role="group" aria-label="Registreringsmåte"><button type="button" aria-pressed={entryMode === 'darts'} onClick={() => setEntryMode('darts')}>Velg piler</button><button type="button" aria-pressed={entryMode === 'total'} onClick={() => setEntryMode('total')}>Skriv totalsum</button></div>}
              {entryMode === 'darts' || gameMode === 'cricket' ? <div className="dart-inputs">{darts.map((dart, index) => (
                <label className="dart-input" key={index}><span>PIL {index + 1}</span><select aria-label={`Velg kast for pil ${index + 1}`} required value={dart} onChange={(event) => changeDart(index, event.target.value)}><option value="" disabled>Velg kast</option>{(gameMode === 'cricket' ? CRICKET_DART_OPTION_GROUPS : DART_OPTION_GROUPS).map((group) => <optgroup key={group.label} label={group.label}>{group.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>)}</select></label>
              ))}<div className="visit-total"><span>TOTAL</span><strong>{darts.reduce((sum, value) => sum + (parseDartNotation(value)?.points ?? 0), 0)}</strong></div><button className="primary-button submit-score" type="submit">Før poeng <span aria-hidden="true">↗</span></button></div> : <div className="manual-score-entry">
                <label className="manual-score-field"><span>TOTALSUM · 0–180</span><input aria-label="Totalsum for turen" autoComplete="off" inputMode="numeric" type="number" min="0" max="180" step="1" required value={manualTotal} onChange={(event) => { setManualTotal(event.target.value); setMessage('') }} placeholder="0" /></label>
                <label className="manual-darts-field"><span>PILER BRUKT</span><select aria-label="Antall piler brukt" value={manualDartsThrown} onChange={(event) => setManualDartsThrown(Number(event.target.value) as 1 | 2 | 3)}><option value={1}>1 pil</option><option value={2}>2 piler</option><option value={3}>3 piler</option></select></label>
                <label className="manual-double-toggle"><input type="checkbox" checked={manualLastDartDouble} onChange={(event) => setManualLastDartDouble(event.target.checked)} /><span className="custom-check" aria-hidden="true" />Siste pil var dobbel</label>
                <button className="primary-button submit-score" type="submit">Før poeng <span aria-hidden="true">↗</span></button>
              </div>}
              <div className="entry-bottom">
                {gameMode !== 'cricket' && <div className="quick-scores" aria-label="Hurtigvalg for besøket">{Object.entries(QUICK_VISITS).map(([score, values]) => <button key={score} type="button" onClick={() => { if (entryMode === 'total') setManualTotal(score); else setDarts(values); setMessage('') }}>{score}</button>)}</div>}
              </div>
              <p className="entry-message" aria-live="polite">{message || (gameMode === 'cricket' ? 'Lukk alle feltene og ha minst like mange poeng som motstanderen.' : entryMode === 'total' ? 'Ved utgang må du merke av dersom siste pil traff en dobbel.' : 'Velg enkel, dobbel, trippel eller bom for hver pil.')}</p>
            </form>
          )}
          <div className="game-footer"><span>{gameMode === 'cricket' ? <>15–20 + BULL <i /> TRE TREFF</> : <>{gameMode} <i /> DOBBEL UT</>}</span><span>ANGRE RULLER TILBAKE SISTE TUR</span></div>
        </section>
      )}
      {scoreEditPlayer && <div className="score-edit-backdrop"><section className="score-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="score-edit-title">
        <form onSubmit={saveScoreCorrection}>
          <p className="eyebrow">KORRIGER STILLING</p>
          <h2 id="score-edit-title">{scoreEditPlayer.name}</h2>
          <label className="score-edit-field"><span>GJENVÆRENDE POENG · 0–{gameMode === '121' ? 121 : 501}</span><input autoFocus aria-label="Korrigert poengsum" inputMode="numeric" type="number" min="0" max={gameMode === '121' ? 121 : 501} step="1" value={scoreEditInput} onChange={(event) => { setScoreEditInput(event.target.value); setScoreEditError('') }} /></label>
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
