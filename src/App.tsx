import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { getCheckoutHint } from './checkout'
import { addAdminGuestSignup, addTournamentCupRound, beginGuestSession, deleteAllClubTournaments, deleteClubDocument, deleteClubSignup, deleteClubTournament, deleteSavedMatch, deleteSavedPlayer, downloadClubDocument, endGuestSession, finishTournamentMatch, getGuestDisplayName, loadClubAdminStatus, loadClubAdmins, loadClubDocuments, loadClubSignups, loadClubTournaments, loadLinkedPlayerProfile, loadRegisteredPlayerNames, loadSavedData, saveClubSignup, saveClubTournament, saveFinishedMatch, saveLinkedPlayerId, savePlayers, saveTournamentMatchProgress, sendMatchReport, setClubAdminRole, syncPendingChanges, updateClubSignup, updateTournamentParticipantAvailability, uploadClubDocument, uploadProfileAvatar } from './database'
import type { ClubAdmin, ClubDocument, ClubSignup, ClubTournament, PendingSyncIssue, SavedData, TournamentGameHistory, TournamentMatch, TournamentMatchProgress, TournamentGamePlayer } from './database'
import { supabase } from './supabase'
import type { Session } from '@supabase/supabase-js'
import { summarizePlayer, summarizeTournamentPlayer } from './stats'
import { applyCricketVisit, CRICKET_TARGETS, hasWonCricket } from './cricket'
import type { CricketDart, CricketMarks } from './cricket'
import { createNextCupRound, drawClubPools, getNextQueuedTournamentMatch, getPoolStandings, getTournamentMatchRefereeSignupId, setTournamentAdvancement } from './tournament'

type DartInputs = [string, string, string]
type ScoredDart = { points: number; isDouble: boolean; target: number | null; marks: number }
type ActiveTournamentMatch = {
  eventDate: string
  matchId: string
  playerOneId: string
  playerTwoId: string
  progressId: string
}
type GameMode = '501' | 'cricket' | '121'
type Player = TournamentGamePlayer
type Snapshot = TournamentGameHistory
type EntryMode = 'darts' | 'total'
type GamePhase = 'setup' | 'bull-off' | 'leg-bull-off' | 'playing'
type AppSection = 'scoreboard' | 'club-evenings' | 'players' | 'profile' | 'admin' | 'tournament'
type CoinSide = 'kron' | 'mynt'
type CourtNumber = 1 | 2 | 3 | 4 | 5
type Visit = TournamentGamePlayer['visits'][number]

function getLegDartsThrown(players: Player[], legNumber: number, playerId?: string): number {
  return players
    .filter((player) => playerId === undefined || player.id === playerId)
    .flatMap((player) => player.visits)
    .filter((visit) => visit.legNumber === legNumber)
    .reduce((total, visit) => total + visit.dartsThrown, 0)
}

function getSavedCourtNumber(): CourtNumber {
  try {
    const savedCourtNumber = Number(window.localStorage.getItem('darttavla-court-number'))
    return ([1, 2, 3, 4, 5] as const).includes(savedCourtNumber as CourtNumber)
      ? savedCourtNumber as CourtNumber
      : 1
  } catch {
    return 1
  }
}

function tournamentErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('All five boards are already in use.')) {
    return 'Alle fem banene er i bruk. Vent til en kamp er ferdig.'
  }
  if (message.includes('This tournament match is already active on another board.')
    || message.includes('This tournament match is active on another board.')) {
    return 'Denne turneringskampen er allerede startet på en annen bane.'
  }
  return message || fallback
}

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

type TournamentBoardProps = {
  tournament: ClubTournament | null
  eventDate: string
  eventDates: string[]
  archivedTournaments: ClubTournament[]
  signups: ClubSignup[]
  seedRanks: Record<string, string>
  busy: boolean
  canPlayMatch: boolean
  canResumeMatch: boolean
  onAssignBoard: (match: TournamentMatch, courtNumber: CourtNumber) => void
  isAdmin: boolean
  message: string
  messageIsError: boolean
  onEventDateChange: (date: string) => void
  onSeedChange: (signupId: string, rank: string) => void
  onDraw: () => void
  onPlayMatch: (match: TournamentMatch) => void
  onReadinessChange: (signupId: string, availability: 'not-arrived' | 'ready' | 'pause') => void
  onToggleAdvancement: (signupId: string, advances: boolean) => void
  onCreateCup: () => void
  pendingDeleteDate: string | null
  confirmDeleteAll: boolean
  deleting: boolean
  activeTournamentDate: string | null
  onRequestDeleteTournament: (eventDate: string) => void
  onDeleteTournament: (eventDate: string) => void
  onConfirmDeleteAll: () => void
  onCancelDelete: () => void
  onDeleteAll: () => void
}

function TournamentBoard({
  tournament,
  eventDate,
  eventDates,
  archivedTournaments,
  signups,
  seedRanks,
  busy,
  canPlayMatch,
  canResumeMatch,
  onAssignBoard,
  isAdmin,
  message,
  messageIsError,
  onEventDateChange,
  onSeedChange,
  onDraw,
  onPlayMatch,
  onReadinessChange,
  onToggleAdvancement,
  onCreateCup,
  pendingDeleteDate,
  confirmDeleteAll,
  deleting,
  activeTournamentDate,
  onRequestDeleteTournament,
  onDeleteTournament,
  onConfirmDeleteAll,
  onCancelDelete,
  onDeleteAll,
}: TournamentBoardProps) {
  const [timeNow, setTimeNow] = useState(Date.now())
  useEffect(() => {
    const intervalId = window.setInterval(() => setTimeNow(Date.now()), 60_000)
    return () => window.clearInterval(intervalId)
  }, [])
  const seedOptions = Array.from({ length: signups.length }, (_, index) => String(index + 1))
  const tournamentPools = tournament
    ? Array.from(new Set(tournament.participants.flatMap((participant) => participant.poolNumber === null ? [] : [participant.poolNumber]))).sort((first, second) => first - second)
    : []
  const poolMatches = tournament?.matches.filter((match) => match.phase === 'pool') ?? []
  const activeMatchCount = tournament?.matches.filter((match) => match.inProgress).length ?? 0
  const activeMatches = tournament?.matches.filter((match) => match.inProgress) ?? []
  const assignedBoards = new Set(activeMatches.flatMap((match) => match.inProgress?.courtNumber ? [match.inProgress.courtNumber] : []))
  const unassignedActiveMatches = activeMatches.filter((match) => !match.inProgress?.courtNumber)
  const freeBoards = unassignedActiveMatches.length === 0
    ? ([1, 2, 3, 4, 5] as const).filter((court) => !assignedBoards.has(court))
    : []
  const poolsComplete = poolMatches.length > 0 && poolMatches.every((match) => match.winnerSignupId !== null)
  const cupMatches = tournament?.matches.filter((match) => match.phase === 'cup') ?? []
  const cupRoundMatches = tournament && cupMatches.length > 0
    ? cupMatches.filter((match) => match.roundNumber === tournament.cupRound)
    : []
  const tournamentFinished = tournament?.cupRound
    && cupRoundMatches.length === 1
    && cupRoundMatches[0].winnerSignupId !== null
  const tournamentPlayerStats = new Map<string, {
    tons: number
    oneEighties: number
    fastestCheckoutDarts: number | null
    highestCheckout: number
  }>()
  for (const match of tournament?.matches ?? []) {
    for (const stats of match.playerStats ?? []) {
      const previous = tournamentPlayerStats.get(stats.signupId)
      tournamentPlayerStats.set(stats.signupId, {
        tons: (previous?.tons ?? 0) + stats.tons,
        oneEighties: (previous?.oneEighties ?? 0) + stats.oneEighties,
        fastestCheckoutDarts: stats.fastestCheckoutDarts === null
          ? previous?.fastestCheckoutDarts ?? null
          : previous?.fastestCheckoutDarts === null || previous?.fastestCheckoutDarts === undefined
            ? stats.fastestCheckoutDarts
            : Math.min(previous.fastestCheckoutDarts, stats.fastestCheckoutDarts),
        highestCheckout: Math.max(previous?.highestCheckout ?? 0, stats.highestCheckout),
      })
    }
  }
  const participantName = (signupId: string) => tournament?.participants.find((participant) => participant.signupId === signupId)?.playerName ?? 'Ukjent spiller'
  const poolMeetingLabel = (match: TournamentMatch) => match.poolMeeting === 2 ? ' · returoppgjør' : ''
  const getRoundLabel = (round: number, matchesInRound: number) => matchesInRound === 1
    ? 'Finale'
    : matchesInRound === 2 ? 'Semifinale' : `Cup · runde ${round}`
  const currentRoundMatches = tournament?.cupRound
    ? cupMatches.filter((match) => match.roundNumber === tournament.cupRound)
    : poolMatches
  const activeSignupIds = new Set(activeMatches.flatMap((match) => [match.playerOneSignupId, match.playerTwoSignupId].filter((id): id is string => id !== null)))
  const matchesPlayed = new Map<string, number>()
  const participantById = new Map((tournament?.participants ?? []).map((participant) => [participant.signupId, participant]))
  for (const match of currentRoundMatches) {
    if ((!match.winnerSignupId && !match.inProgress) || !match.playerTwoSignupId) continue
    matchesPlayed.set(match.playerOneSignupId, (matchesPlayed.get(match.playerOneSignupId) ?? 0) + 1)
    if (match.playerTwoSignupId) {
      matchesPlayed.set(match.playerTwoSignupId, (matchesPlayed.get(match.playerTwoSignupId) ?? 0) + 1)
    }
  }
  const queuedMatches = (tournament?.cupRound
    ? cupMatches.filter((match) => match.roundNumber === tournament.cupRound)
    : poolMatches)
    .filter((match) => match.winnerSignupId === null && !match.inProgress && match.playerTwoSignupId !== null)
    .sort((first, second) => {
      const firstParticipants = [participantById.get(first.playerOneSignupId), participantById.get(first.playerTwoSignupId!)]
      const secondParticipants = [participantById.get(second.playerOneSignupId), participantById.get(second.playerTwoSignupId!)]
      const firstReady = firstParticipants.every((participant) => (participant?.availability ?? 'ready') === 'ready')
        && !activeSignupIds.has(first.playerOneSignupId) && !activeSignupIds.has(first.playerTwoSignupId!)
      const secondReady = secondParticipants.every((participant) => (participant?.availability ?? 'ready') === 'ready')
        && !activeSignupIds.has(second.playerOneSignupId) && !activeSignupIds.has(second.playerTwoSignupId!)
      if (firstReady !== secondReady) return firstReady ? -1 : 1
      const readyTimestamp = (participant: typeof firstParticipants[number]) => Date.parse(participant?.readySince ?? tournament?.createdAt ?? '')
      const firstWaitStart = Math.max(...firstParticipants.map(readyTimestamp))
      const secondWaitStart = Math.max(...secondParticipants.map(readyTimestamp))
      if (Number.isFinite(firstWaitStart) && Number.isFinite(secondWaitStart) && firstWaitStart !== secondWaitStart) {
        return firstWaitStart - secondWaitStart
      }
      const firstLoads = [matchesPlayed.get(first.playerOneSignupId) ?? 0, matchesPlayed.get(first.playerTwoSignupId!) ?? 0]
      const secondLoads = [matchesPlayed.get(second.playerOneSignupId) ?? 0, matchesPlayed.get(second.playerTwoSignupId!) ?? 0]
      return Math.max(...firstLoads) - Math.max(...secondLoads)
        || firstLoads.reduce((total, count) => total + count, 0) - secondLoads.reduce((total, count) => total + count, 0)
        || (first.poolNumber ?? 0) - (second.poolNumber ?? 0)
        || first.bracketPosition - second.bracketPosition
    })
    .slice(0, 5)
  const recommendedMatch = queuedMatches.find((match) => {
    const first = participantById.get(match.playerOneSignupId)
    const second = participantById.get(match.playerTwoSignupId!)
    return (first?.availability ?? 'ready') === 'ready'
      && (second?.availability ?? 'ready') === 'ready'
      && !activeSignupIds.has(match.playerOneSignupId)
      && !activeSignupIds.has(match.playerTwoSignupId!)
  })
  const formatWaitTime = (readySince: string | undefined) => {
    const parsedTime = Date.parse(readySince ?? tournament?.createdAt ?? '')
    if (!Number.isFinite(parsedTime)) return 'Klar'
    const minutes = Math.max(0, Math.floor((timeNow - parsedTime) / 60_000))
    if (minutes < 1) return 'Klar nå'
    if (minutes < 60) return `Klar i ${minutes} min`
    return `Klar i ${Math.floor(minutes / 60)} t ${minutes % 60} min`
  }
  const getMatchWaitTime = (match: TournamentMatch) => {
    const fallbackTime = tournament?.createdAt ?? new Date().toISOString()
    const waitStarts = [match.playerOneSignupId, match.playerTwoSignupId]
      .map((signupId) => Date.parse(participantById.get(signupId ?? '')?.readySince ?? fallbackTime))
      .filter(Number.isFinite)
    return formatWaitTime(new Date(Math.max(...waitStarts)).toISOString())
  }
  const canStartQueuedMatches = canPlayMatch && unassignedActiveMatches.length === 0

  return <section className="admin-panel tournament-panel">
    <div className="admin-section-heading">
      <div><p className="eyebrow">PULJER OG CUP</p><h2>Turnering</h2></div>
      <label className="admin-export-select"><span>KLUBBKVELD</span><select value={eventDate} onChange={(event) => onEventDateChange(event.target.value)}>{eventDates.map((date) => <option key={date} value={date}>{formatClubDate(date)}</option>)}</select></label>
      <div className="tournament-heading-actions">
        {tournament && activeMatchCount > 0 && <p className="tournament-active-count" role="status">{activeMatchCount} / 5 kamper pågår på banene</p>}
        {tournament && isAdmin && <button className="tournament-print-button" type="button" onClick={() => window.print()}>Skriv ut skjemaer</button>}
        {!tournament && isAdmin && <button className="primary-button admin-export-button" type="button" disabled={busy || signups.length < 2} onClick={onDraw}>Trekk puljer</button>}
      </div>
    </div>
    {message && <p className={`admin-message${messageIsError ? ' is-error' : ''}`} role={messageIsError ? 'alert' : 'status'}>{message}</p>}
    {!tournament ? <div className="tournament-draw">
      <p className="admin-empty">{signups.length} påmeldte. Velg eventuelle seedede spillere før du trekker. Seedede plasseres først i ulike puljer; de øvrige fordeles tilfeldig og jevnt.</p>
      {isAdmin && signups.length > 0 && <ul className="tournament-seed-list">{signups.map((signup) => {
        const currentSeed = seedRanks[signup.id] ?? ''
        const takenSeeds = new Set(Object.entries(seedRanks).filter(([id, rank]) => id !== signup.id && rank).map(([, rank]) => rank))
        return <li key={signup.id}>
          <span>{signup.playerName}</span>
          <label><span>SEEDING</span><select aria-label={`Seeding for ${signup.playerName}`} value={currentSeed} onChange={(event) => onSeedChange(signup.id, event.target.value)}><option value="">Ikke seedet</option>{seedOptions.map((seed) => <option key={seed} value={seed} disabled={takenSeeds.has(seed)}>Seed {seed}</option>)}</select></label>
        </li>
      })}</ul>}
      {isAdmin && signups.length < 2 && <p className="admin-empty">Minst to påmeldte trengs for å trekke puljer.</p>}
      {!isAdmin && <p className="admin-empty">{signups.length === 0 ? 'Ingen turnering er trukket for denne klubbkvelden ennå.' : 'Administrator har ikke trukket puljene ennå.'}</p>}
    </div> : <>
      <p className="tournament-format-note">Puljespill: best av 3 legg · Cup: best av 5 legg · Semifinale: best av 7 legg · Finale: best av 9 legg</p>
      <section className="tournament-day-panel" aria-label="Kampdagoversikt">
        <div className="tournament-day-heading"><h3>Kampdagoversikt</h3><span>{activeMatchCount} / 5 kamper i gang</span></div>
        <div className="tournament-board-status" aria-label="Baneoversikt">
          {unassignedActiveMatches.length > 0
            ? <p className="tournament-board-warning" role="status">Tildel bane til {unassignedActiveMatches.length} pågående {unassignedActiveMatches.length === 1 ? 'kamp' : 'kamper'} før ledige baner kan bekreftes eller nye kamper startes.</p>
            : <div className="tournament-board-chips">{([1, 2, 3, 4, 5] as const).map((court) => <span className={assignedBoards.has(court) ? 'is-occupied' : 'is-free'} key={court}>Bane {court} · {assignedBoards.has(court) ? 'I bruk' : 'Ledig'}</span>)}</div>}
        </div>
        {activeMatches.length > 0 && <ul className="tournament-day-match-list">{activeMatches.map((match) => {
          const progress = match.inProgress
          if (!progress) return null
          const playerOne = participantName(match.playerOneSignupId)
          const playerTwo = match.playerTwoSignupId ? participantName(match.playerTwoSignupId) : 'Walkover'
          const refereeSignupId = getTournamentMatchRefereeSignupId(tournament, match)
          const refereeName = refereeSignupId ? participantName(refereeSignupId) : null
          const progressScore = `${progress.legsWon[progress.players[0]?.id ?? ''] ?? 0}–${progress.legsWon[progress.players[1]?.id ?? ''] ?? 0}`
          const roundLabel = match.phase === 'pool' ? `Pulje ${match.poolNumber}${poolMeetingLabel(match)}` : getRoundLabel(match.roundNumber, cupMatches.filter((item) => item.roundNumber === match.roundNumber).length)
          const availableForAssignment = ([1, 2, 3, 4, 5] as const).filter((court) => !activeMatches.some((other) => other.id !== match.id && other.inProgress?.courtNumber === court))
          return <li key={match.id}>
            <div className="tournament-day-match-info">
              <strong>{progress.courtNumber ? `Bane ${progress.courtNumber}` : 'Bane må tildeles'} · {roundLabel}</strong>
              <span>{playerOne} – {playerTwo}</span>
              <small>Stillingen er {progressScore} legg</small>
              <small>{refereeName ? `Dommer: ${refereeName}` : 'Dommer ikke tildelt'}</small>
            </div>
            {isAdmin && !progress.courtNumber && <label className="tournament-board-select"><span>TILDEL BANE</span><select disabled={busy} value="" onChange={(event) => { const selectedCourt = Number(event.target.value); if (isCourtNumber(selectedCourt)) onAssignBoard(match, selectedCourt) }}><option value="">Velg bane</option>{availableForAssignment.map((court) => <option key={court} value={court}>Bane {court}</option>)}</select></label>}
            {isAdmin && progress.courtNumber && <button className="tournament-play-button" type="button" disabled={busy || !canResumeMatch} onClick={() => onPlayMatch(match)}>Fortsett på bane {progress.courtNumber}</button>}
          </li>
        })}</ul>}
        <div className="tournament-day-queue">
          <div className="tournament-queue-heading"><h4>Smart kampflyt</h4><span>JEVN PAUSE · DU VELGER</span></div>
          <p className="tournament-checkin-note">Meld spillerne klare når de møter. Forslagene bruker bare innsjekkede spillere.</p>
          <ul className="tournament-readiness-list" aria-label="Spillerklarhet">
            {(tournament?.participants ?? []).map((participant) => {
              const isPlaying = activeSignupIds.has(participant.signupId)
              const availability = participant.availability ?? 'ready'
              return <li key={participant.signupId}>
                <span><strong>{participant.playerName}</strong><small>{isPlaying ? 'Spiller nå' : availability === 'not-arrived' ? 'Ikke sjekket inn' : availability === 'pause' ? 'Tar pause' : formatWaitTime(participant.readySince)}</small></span>
                {isAdmin && <div className="tournament-readiness-actions">
                  <button type="button" disabled={busy || isPlaying || availability === 'ready'} aria-pressed={!isPlaying && availability === 'ready'} onClick={() => onReadinessChange(participant.signupId, 'ready')}>Klar</button>
                  <button type="button" disabled={busy || isPlaying || availability === 'pause'} aria-pressed={!isPlaying && availability === 'pause'} onClick={() => onReadinessChange(participant.signupId, 'pause')}>Pause</button>
                  <button type="button" disabled={busy || isPlaying || availability === 'not-arrived'} aria-pressed={!isPlaying && availability === 'not-arrived'} onClick={() => onReadinessChange(participant.signupId, 'not-arrived')}>Ikke møtt</button>
                </div>}
              </li>
            })}
          </ul>
          {recommendedMatch && <div className="tournament-recommendation">
            <span className="tournament-recommendation-label">SYSTEMETS FLYTVALG</span>
            <strong>{participantName(recommendedMatch.playerOneSignupId)} – {participantName(recommendedMatch.playerTwoSignupId!)}</strong>
            <span>{recommendedMatch.phase === 'pool' ? `Pulje ${recommendedMatch.poolNumber}${poolMeetingLabel(recommendedMatch)}` : getRoundLabel(recommendedMatch.roundNumber, cupMatches.filter((item) => item.roundNumber === recommendedMatch.roundNumber).length)} · Begge er klare · Har ventet minst {getMatchWaitTime(recommendedMatch)} · {Math.min(matchesPlayed.get(recommendedMatch.playerOneSignupId) ?? 0, matchesPlayed.get(recommendedMatch.playerTwoSignupId!) ?? 0)}–{Math.max(matchesPlayed.get(recommendedMatch.playerOneSignupId) ?? 0, matchesPlayed.get(recommendedMatch.playerTwoSignupId!) ?? 0)} kamper spilt</span>
            <small>Anbefalingen tar hensyn til ventetid og kampbelastning. Du velger selv hvilken kamp som starter.</small>
          </div>}
          <h4>Neste kamper · velg selv</h4>
          {queuedMatches.length > 0
            ? <ol>{queuedMatches.map((match) => <li key={match.id}>
              <span>
                {match.phase === 'pool' ? `Pulje ${match.poolNumber}${poolMeetingLabel(match)}` : getRoundLabel(match.roundNumber, cupMatches.filter((item) => item.roundNumber === match.roundNumber).length)} · {participantName(match.playerOneSignupId)} – {participantName(match.playerTwoSignupId!)}
                <small>{activeSignupIds.has(match.playerOneSignupId) || activeSignupIds.has(match.playerTwoSignupId!)
                  ? 'Spiller opptatt på en annen bane'
                  : [participantById.get(match.playerOneSignupId), participantById.get(match.playerTwoSignupId!)].find((participant) => participant?.availability === 'not-arrived')
                    ? `${[participantById.get(match.playerOneSignupId), participantById.get(match.playerTwoSignupId!)].find((participant) => participant?.availability === 'not-arrived')?.playerName} er ikke sjekket inn`
                    : [participantById.get(match.playerOneSignupId), participantById.get(match.playerTwoSignupId!)].find((participant) => participant?.availability === 'pause')
                    ? `${[participantById.get(match.playerOneSignupId), participantById.get(match.playerTwoSignupId!)].find((participant) => participant?.availability === 'pause')?.playerName} har valgt pause`
                    : `${matchesPlayed.get(match.playerOneSignupId) ?? 0}–${matchesPlayed.get(match.playerTwoSignupId!) ?? 0} kamper spilt i runden`}</small>
                <small>{getTournamentMatchRefereeSignupId(tournament, match)
                  ? `Dommer: ${participantName(getTournamentMatchRefereeSignupId(tournament, match)!)}`
                  : 'Dommer ikke tildelt'}</small>
              </span>
              {isAdmin && <button className={`tournament-play-button${recommendedMatch?.id === match.id ? ' is-recommended' : ''}`} type="button" disabled={busy || !canStartQueuedMatches || freeBoards.length === 0 || activeSignupIds.has(match.playerOneSignupId) || activeSignupIds.has(match.playerTwoSignupId!) || (participantById.get(match.playerOneSignupId)?.availability !== undefined && participantById.get(match.playerOneSignupId)?.availability !== 'ready') || (participantById.get(match.playerTwoSignupId!)?.availability !== undefined && participantById.get(match.playerTwoSignupId!)?.availability !== 'ready')} onClick={() => onPlayMatch(match)}>{unassignedActiveMatches.length > 0 ? 'Tildel aktive baner først' : activeSignupIds.has(match.playerOneSignupId) || activeSignupIds.has(match.playerTwoSignupId!) ? 'Spiller opptatt' : (participantById.get(match.playerOneSignupId)?.availability !== undefined && participantById.get(match.playerOneSignupId)?.availability !== 'ready') || (participantById.get(match.playerTwoSignupId!)?.availability !== undefined && participantById.get(match.playerTwoSignupId!)?.availability !== 'ready') ? 'Sjekk at begge er klare' : freeBoards.length > 0 ? `Start på bane ${freeBoards[0]}` : 'Alle baner er i bruk'}</button>}
            </li>)}</ol>
            : <p>{tournamentFinished ? 'Turneringen er ferdig.' : 'Ingen flere kamper venter i denne runden.'}</p>}
          {queuedMatches.length > 0 && !recommendedMatch && <p>Ingen kamp har to ledige spillere som er markert klare akkurat nå. Oppdater spillerstatus når de er klare.</p>}
        </div>
      </section>
      {tournamentPools.map((poolNumber) => {
        const standings = getPoolStandings(tournament, poolNumber)
        const poolIsComplete = poolMatches.filter((match) => match.poolNumber === poolNumber).every((match) => match.winnerSignupId !== null)
        return <section className="tournament-pool" key={poolNumber}>
          <h3>Pulje {poolNumber}<span>{standings.length} spillere</span></h3>
          <div className="tournament-table-wrap"><table className="tournament-standings"><thead><tr><th>#</th><th>Spiller</th><th>Seire</th><th>Leggdifferanse</th>{isAdmin && tournament.cupRound === 0 && <th>Videre</th>}</tr></thead><tbody>{standings.map((participant, index) => <tr key={participant.signupId}>
            <td>{index + 1}</td><th scope="row">{participant.playerName}{participant.seed !== null && <small>Seed {participant.seed}</small>}</th><td>{participant.wins}</td><td>{participant.legDifference > 0 ? `+${participant.legDifference}` : participant.legDifference}</td>
            {isAdmin && tournament.cupRound === 0 && <td><input type="checkbox" aria-label={`${participant.playerName} går videre`} checked={participant.advances} disabled={!poolIsComplete || busy} onChange={(event) => onToggleAdvancement(participant.signupId, event.target.checked)} /></td>}
          </tr>)}</tbody></table></div>
          <ul className="tournament-match-list">{poolMatches.filter((match) => match.poolNumber === poolNumber).map((match) => <TournamentMatchRow key={match.id} match={match} tournament={tournament} isAdmin={isAdmin} busy={busy} canPlayMatch={canStartQueuedMatches} canResumeMatch={canResumeMatch} onPlayMatch={onPlayMatch} />)}</ul>
        </section>
      })}
      {isAdmin && tournament.cupRound === 0 && poolsComplete && <div className="tournament-actions">
        <p className="admin-empty">Velg spillerne som går videre. Tabellrekkefølgen viser seire, leggdifferanse og deretter seeding.</p>
        <button className="primary-button" type="button" disabled={busy || tournament.participants.filter((participant) => participant.advances).length < 2} onClick={onCreateCup}>Lag cup-oppsett</button>
      </div>}
      {cupMatches.length > 0 && <section className="tournament-pool">
        <h3>Cup-oppsett<span>{tournamentFinished ? 'Ferdig' : `${getRoundLabel(tournament.cupRound, cupRoundMatches.length)} gjenstår`}</span></h3>
        {Array.from(new Set(cupMatches.map((match) => match.roundNumber))).sort((first, second) => first - second).map((round) => {
          const roundMatches = cupMatches.filter((match) => match.roundNumber === round).sort((first, second) => first.bracketPosition - second.bracketPosition)
          return <section className="tournament-cup-round" key={round}><h4>{getRoundLabel(round, roundMatches.length)}</h4><ul className="tournament-match-list">{roundMatches.map((match) => <TournamentMatchRow key={match.id} match={match} tournament={tournament} isAdmin={isAdmin} busy={busy} canPlayMatch={canStartQueuedMatches} canResumeMatch={canResumeMatch} onPlayMatch={onPlayMatch} />)}</ul></section>
        })}
        {tournamentFinished && <p className="tournament-champion">Vinner: {participantName(cupRoundMatches[0].winnerSignupId!)}</p>}
      </section>}
      {isAdmin && archivedTournaments.length > 0 && <section className="tournament-archive">
        <div className="tournament-archive-heading"><h3>Arkiv for turneringsark<span>{archivedTournaments.length} turneringer</span></h3><button className="tournament-delete-button" type="button" disabled={deleting || activeTournamentDate !== null} onClick={onConfirmDeleteAll}>Slett alle turneringer</button></div>
        <p>Turneringsarkene kan åpnes og skrives ut på nytt. Velg «Skriv ut som PDF» i utskriftsvinduet for å lagre en digital kopi.</p>
        {confirmDeleteAll && <div className="tournament-delete-confirmation" role="alert"><span>Er du sikker på at du vil slette alle {archivedTournaments.length} turneringene? Dette kan ikke angres.</span><button className="tournament-delete-button" type="button" disabled={deleting} onClick={onDeleteAll}>{deleting ? 'Sletter …' : 'Ja, slett alle'}</button><button type="button" disabled={deleting} onClick={onCancelDelete}>Avbryt</button></div>}
        <ul>{[...archivedTournaments].sort((first, second) => second.eventDate.localeCompare(first.eventDate)).map((archived) => {
          const cupRounds = archived.matches.filter((match) => match.phase === 'cup')
          const finalMatch = cupRounds.find((match) => match.roundNumber === archived.cupRound)
          const poolMatches = archived.matches.filter((match) => match.phase === 'pool')
          const incompletePoolMatches = poolMatches.filter((match) => match.winnerSignupId === null).length
          const matchInProgress = archived.matches.some((match) => match.inProgress)
          const baseStatus = archived.participants.length < 2 || poolMatches.length === 0
            ? 'Feil: puljeoppsett mangler'
            : finalMatch?.winnerSignupId
            ? 'Ferdig'
            : archived.cupRound > 0
              ? `${getRoundLabel(archived.cupRound, cupRounds.filter((match) => match.roundNumber === archived.cupRound).length)} gjenstår`
              : incompletePoolMatches === 0 ? 'Puljer ferdige' : `Puljespill · ${incompletePoolMatches} kamper gjenstår`
          const status = matchInProgress ? `${baseStatus} · kamp kan fortsettes` : baseStatus
          return <li key={archived.eventDate}>
            <div className="tournament-archive-info"><strong>{formatClubDate(archived.eventDate)}</strong><span>{archived.participants.length} spillere · {status}</span>
              {pendingDeleteDate === archived.eventDate && <div className="tournament-delete-confirmation" role="alert"><span>Slette turneringen fra {formatClubDate(archived.eventDate)}? Alle resultater og kampframdrift slettes permanent. {matchInProgress ? 'En pågående kamp avbrytes og kan ikke gjenopptas. ' : ''}Dette kan ikke angres.</span><button className="tournament-delete-button" type="button" disabled={deleting} onClick={() => onDeleteTournament(archived.eventDate)}>{deleting ? 'Sletter …' : 'Ja, slett'}</button><button type="button" disabled={deleting} onClick={onCancelDelete}>Avbryt</button></div>}
            </div>
            <div className="tournament-archive-actions"><button type="button" disabled={archived.eventDate === eventDate} aria-pressed={archived.eventDate === eventDate} onClick={() => onEventDateChange(archived.eventDate)}>{archived.eventDate === eventDate ? 'Valgt' : 'Åpne ark'}</button><button className="tournament-delete-button" type="button" disabled={deleting || pendingDeleteDate !== null} onClick={() => onRequestDeleteTournament(archived.eventDate)}>Slett</button></div>
          </li>
        })}</ul>
      </section>}
      {isAdmin && <div className="tournament-print-content">
        <header className="tournament-print-header">
          <p>STEINKJER DART-X · TURNERING</p>
          <h1>{formatClubDate(tournament.eventDate)}</h1>
          <span>Puljespill: best av 3 legg · Cup: best av 5 legg · Semifinale: best av 7 legg · Finale: best av 9 legg</span>
        </header>
        {tournamentPools.map((poolNumber) => {
          const matches = poolMatches.filter((match) => match.poolNumber === poolNumber)
          const poolStandings = getPoolStandings(tournament, poolNumber)
          const poolIsComplete = matches.every((match) => match.winnerSignupId !== null)
          const poolParticipants = tournament.participants.filter((participant) => participant.poolNumber === poolNumber)
          const advancingPlayers = poolParticipants.filter((participant) => participant.advances)
          return <section className={`tournament-print-sheet tournament-print-pool${poolParticipants.length <= 4 ? ' tournament-print-pool-small' : ''}`} key={`print-pool-${poolNumber}`}>
            <div className="tournament-print-pool-heading"><h2>Pulje {poolNumber}</h2><p>{formatClubDate(tournament.eventDate)} <span>Bane nr. __________</span></p></div>
            {poolParticipants.length === 3 && <p className="tournament-print-pool-repeat-note">Alle møter hverandre to ganger. Første resultat står over returoppgjøret.</p>}
            <table className="tournament-print-standings">
              <thead><tr><th>Nr</th><th>Navn</th><th>Klubb</th>{poolParticipants.map((_, index) => <th key={index}>{index + 1}</th>)}<th>Sum seire</th><th>Legg diff.</th><th>Plass</th></tr></thead>
              <tbody>{poolStandings.map((participant) => {
                const participantIndex = poolParticipants.findIndex((item) => item.signupId === participant.signupId)
                return <tr key={participant.signupId}>
                  <td className="tournament-print-rank">{participantIndex + 1}</td>
                  <td>{participant.playerName}{participant.seed !== null && <small>Seed {participant.seed}</small>}</td>
                  <td />
                  {poolParticipants.map((opponent) => {
                    if (opponent.signupId === participant.signupId) return <td className="tournament-print-matrix-diagonal" key={opponent.signupId} />
                    const opponentMatches = matches.filter((candidate) => (
                      candidate.playerOneSignupId === participant.signupId && candidate.playerTwoSignupId === opponent.signupId
                    ) || (
                      candidate.playerTwoSignupId === participant.signupId && candidate.playerOneSignupId === opponent.signupId
                    )).sort((first, second) => (first.poolMeeting ?? 1) - (second.poolMeeting ?? 1))
                    if (opponentMatches.length === 0) {
                      return <td key={opponent.signupId} />
                    }
                    return <td className="tournament-print-matrix-score" key={opponent.signupId}>{opponentMatches.map((match) => {
                      if (match.playerOneLegs === null || match.playerTwoLegs === null) return <span key={match.id}>·</span>
                      const score = match.playerOneSignupId === participant.signupId
                        ? `${match.playerOneLegs}–${match.playerTwoLegs}`
                        : `${match.playerTwoLegs}–${match.playerOneLegs}`
                      return <span key={match.id}>{score}</span>
                    })}</td>
                  })}
                  <td className="tournament-print-stat">{participant.wins}</td>
                  <td className="tournament-print-stat">{participant.legDifference > 0 ? `+${participant.legDifference}` : participant.legDifference}</td>
                  <td className="tournament-print-stat">{poolIsComplete ? poolStandings.findIndex((item) => item.signupId === participant.signupId) + 1 : ''}</td>
                </tr>
              })}</tbody>
            </table>
            <div className="tournament-print-pool-footer">
              <div><h3>Går videre til sluttspillet</h3>{advancingPlayers.length > 0 ? <ol>{advancingPlayers.map((participant) => <li key={participant.signupId}>{participant.playerName}</li>)}</ol> : <p>________________________________</p>}</div>
              <div className="tournament-print-records"><p>Raskeste legg: __________________</p><p>Høyeste utgang: ________________</p></div>
              <p className="tournament-print-pool-status">{poolIsComplete ? 'Puljen er ferdigspilt' : 'Puljespill · best av 3 legg'}</p>
            </div>
          </section>
        })}
        <section className="tournament-print-sheet tournament-print-stats" key="print-player-statistics">
          <div className="tournament-print-pool-heading"><h2>Turneringsstatistikk</h2><p>{formatClubDate(tournament.eventDate)}</p></div>
          <p className="tournament-print-stats-note">Statistikken fylles inn automatisk når turneringskampene lagres. Raskeste checkout måles i spillerens piler.</p>
          <table className="tournament-print-statistics">
            <thead><tr><th>#</th><th>Spiller</th><th>Pulje</th><th>Tons (100+)</th><th>180-ere</th><th>Raskeste legg (piler)</th><th>Høyeste utgang</th></tr></thead>
            <tbody>{tournament.participants.map((participant, index) => <tr key={participant.signupId}>
              <td>{index + 1}</td>
              <th scope="row">{participant.playerName}</th>
              <td>{participant.poolNumber ?? ''}</td>
              <td>{tournamentPlayerStats.get(participant.signupId)?.tons ?? 0}</td>
              <td>{tournamentPlayerStats.get(participant.signupId)?.oneEighties ?? 0}</td>
              <td>{tournamentPlayerStats.get(participant.signupId)?.fastestCheckoutDarts ?? '–'}</td>
              <td>{(tournamentPlayerStats.get(participant.signupId)?.highestCheckout ?? 0) || '–'}</td>
            </tr>)}</tbody>
          </table>
        </section>
        {cupMatches.length > 0 && (() => {
          const firstRoundMatches = cupMatches.filter((match) => match.roundNumber === 1)
            .sort((first, second) => first.bracketPosition - second.bracketPosition)
          const firstRoundCount = firstRoundMatches.length
          const roundCount = Math.ceil(Math.log2(firstRoundCount)) + 1
          const getMatchNumber = (round: number, position: number) => firstRoundCount * 2 * (1 - 1 / 2 ** (round - 1)) + position + 1
          const roundTitle = (matchCount: number, round: number) => matchCount === 1
            ? 'Finale'
            : matchCount === 2 ? 'Semifinale'
              : matchCount === 4 ? 'Kvartfinale'
                : matchCount === 8 ? 'Åttedelsfinale' : `Runde ${round}`
          return <section className="tournament-print-sheet tournament-print-cup" key="print-cup-bracket">
            <div className="tournament-print-pool-heading"><h2>Sluttspill · cup</h2><p>{formatClubDate(tournament.eventDate)}</p></div>
            <div className="tournament-print-bracket-headings" style={{ gridTemplateColumns: `repeat(${roundCount}, minmax(0, 1fr))` }}>{Array.from({ length: roundCount }, (_, roundIndex) => {
              const count = Math.max(1, firstRoundCount / 2 ** roundIndex)
              return <h3 key={roundIndex} style={{ gridColumn: roundIndex + 1 }}>{roundTitle(count, roundIndex + 1)}</h3>
            })}</div>
            <div className="tournament-print-bracket" style={{
              gridTemplateColumns: `repeat(${roundCount}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${firstRoundCount * 2}, minmax(0, 1fr))`,
            }}>
              {Array.from({ length: roundCount }, (_, roundIndex) => {
                const round = roundIndex + 1
                const roundMatches = cupMatches.filter((match) => match.roundNumber === round)
                  .sort((first, second) => first.bracketPosition - second.bracketPosition)
                const roundMatchCount = Math.max(1, firstRoundCount / 2 ** roundIndex)
                const previousRoundMatches = cupMatches.filter((match) => match.roundNumber === round - 1)
                  .sort((first, second) => first.bracketPosition - second.bracketPosition)
                return Array.from({ length: roundMatchCount }, (_, index) => {
                  const match = roundMatches[index]
                  const sourceMatches = previousRoundMatches.slice(index * 2, index * 2 + 2)
                  const playerOne = match
                    ? participantName(match.playerOneSignupId)
                    : round === 1 ? '' : sourceMatches[0]?.winnerSignupId
                      ? participantName(sourceMatches[0].winnerSignupId)
                      : `Vinner kamp ${getMatchNumber(round - 1, index * 2)}`
                  const playerTwo = match?.playerTwoSignupId
                    ? participantName(match.playerTwoSignupId)
                    : match ? 'Walkover'
                      : round === 1 ? '' : sourceMatches[1]?.winnerSignupId
                        ? participantName(sourceMatches[1].winnerSignupId)
                        : `Vinner kamp ${getMatchNumber(round - 1, index * 2 + 1)}`
                  const refereeSignupId = match ? getTournamentMatchRefereeSignupId(tournament, match) : null
                  const refereeName = refereeSignupId ? participantName(refereeSignupId) : 'Ikke tildelt'
                  const rowStart = 1 + index * 2 ** (roundIndex + 1)
                  const rowSpan = 2 ** (roundIndex + 1)
                  return <div className="tournament-print-bracket-match" key={match?.id ?? `cup-${round}-${index}`} style={{
                    gridColumn: roundIndex + 1,
                    gridRow: `${rowStart} / span ${rowSpan}`,
                  }} data-match-number={getMatchNumber(round, index)}>
                    <span>{playerOne}</span><span>{match?.playerOneLegs ?? ''}</span>
                    <span>{playerTwo}</span><span>{match?.playerTwoLegs ?? ''}</span>
                    <span className="tournament-print-bracket-referee">Dommer: {refereeName}</span>
                  </div>
                })
              })}
            </div>
            <div className="tournament-print-cup-footer"><span>Raskeste legg: __________________</span><span>Høyeste utgang: ________________</span><strong>Finale · best av 9 legg</strong></div>
          </section>
        })()}
      </div>}
    </>}
  </section>
}

type TournamentMatchRowProps = {
  match: TournamentMatch
  tournament: ClubTournament
  isAdmin: boolean
  busy: boolean
  canPlayMatch: boolean
  canResumeMatch: boolean
  onPlayMatch: (match: TournamentMatch) => void
}

function TournamentMatchRow({ match, tournament, isAdmin, busy, canPlayMatch, canResumeMatch, onPlayMatch }: TournamentMatchRowProps) {
  const playerOne = tournament.participants.find((participant) => participant.signupId === match.playerOneSignupId)?.playerName ?? 'Ukjent spiller'
  const playerTwo = match.playerTwoSignupId
    ? tournament.participants.find((participant) => participant.signupId === match.playerTwoSignupId)?.playerName ?? 'Ukjent spiller'
    : 'Walkover'
  const completed = match.winnerSignupId !== null
  const refereeSignupId = getTournamentMatchRefereeSignupId(tournament, match)
  const refereeName = refereeSignupId
    ? tournament.participants.find((participant) => participant.signupId === refereeSignupId)?.playerName
    : null
  const progressScore = match.inProgress
    ? `${match.inProgress.legsWon[match.inProgress.players[0]?.id ?? ''] ?? 0}–${match.inProgress.legsWon[match.inProgress.players[1]?.id ?? ''] ?? 0}`
    : ''
  return <li className="tournament-match">
    <div className="tournament-match-info"><span>{playerOne}</span><b>–</b><span>{playerTwo}</span><small>Best av {match.bestOfLegs}{match.phase === 'pool' && match.poolMeeting ? ` · ${match.poolMeeting === 2 ? 'returoppgjør' : 'første møte'}` : ''}</small><small className="tournament-referee">{refereeName ? `Dommer: ${refereeName}` : 'Dommer ikke tildelt'}</small></div>
    {completed ? <strong className="tournament-match-result">{match.playerOneLegs !== null && match.playerTwoLegs !== null ? `${match.playerOneLegs}–${match.playerTwoLegs}` : 'Videre på walkover'} · {tournament.participants.find((participant) => participant.signupId === match.winnerSignupId)?.playerName}</strong>
      : isAdmin && match.playerTwoSignupId && match.inProgress ? <button className="tournament-play-button" type="button" disabled={busy || !canResumeMatch} onClick={() => onPlayMatch(match)}>Fortsett kampen · {progressScore} legg</button>
        : isAdmin && match.playerTwoSignupId ? <button className="tournament-play-button" type="button" disabled={busy || !canPlayMatch} onClick={() => onPlayMatch(match)}>Spill kamp på poengtavla</button>
        : <span className="tournament-match-pending">{isAdmin && !canPlayMatch ? 'Avslutt pågående kamp først' : 'Venter på resultat'}</span>}
  </li>
}

const DART_OPTION_GROUPS = [
  { label: 'Bom og bull', options: [
    { value: 'MISS', label: 'Miss / bom · 0 poeng' },
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
      return `Lag ${teamId} (${members.map((player) => player.name).join(' + ')}): ${wins} legg`
    }).filter(Boolean).join(' · ')
  }
  return match.players.map((player) => player.legsWon === undefined
    ? `${player.name}: ${player.score} poeng`
    : `${player.name}: ${player.legsWon} ${match.gameMode === '121' ? player.legsWon === 1 ? 'runde' : 'runder' : 'legg'}`).join(' · ')
}

function formatSavedVisit(visit: SavedData['matches'][number]['players'][number]['visits'][number]): string {
  if (visit.cricketDarts?.length) {
    return visit.cricketDarts.map((dart) => {
      if (dart.target === null) return 'Bom'
      const target = dart.target === 25 ? 'Bull' : String(dart.target)
      return dart.marks > 1 ? `${target} ×${dart.marks}` : target
    }).join(' · ')
  }
  return visit.darts ? visit.darts.join(' + ') : `${visit.total} poeng · manuelt`
}

function getUpcomingClubDates(): string[] {
  const dates: string[] = []
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  for (let offset = 0; offset < 42 && dates.length < 8; offset += 1) {
    const weekday = date.getDay()
    if (weekday === 1 || weekday === 4) {
      dates.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`)
    }
    date.setDate(date.getDate() + 1)
  }
  return dates
}

function formatClubDate(date: string): string {
  const formattedDate = new Intl.DateTimeFormat('nb-NO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(`${date}T12:00:00`))
  return `${formattedDate.charAt(0).toLocaleUpperCase('nb-NO')}${formattedDate.slice(1)}`
}

function downloadClubSignupCsv(signups: ClubSignup[], eventDate: string) {
  const csvCell = (value: string) => {
    const safeValue = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
    return `"${safeValue.replace(/"/g, '""')}"`
  }
  const rows = [
    ['Dato', 'Navn'],
    ...signups.map((signup) => [formatClubDate(signup.eventDate), signup.playerName]),
  ]
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(';')).join('\r\n')}`
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `steinkjer-dartx-pameldinger-${eventDate || 'alle'}.csv`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function summarizeCareer(matches: SavedData['matches'], playerId: string) {
  const playerNameKey = playerId.trim().toLowerCase()
  const appearances = matches.flatMap((match) => {
    const player = match.players.find((candidate) => candidate.name.trim().toLowerCase() === playerNameKey)
    return player ? [{ match, player }] : []
  })
  const wins = appearances.filter(({ match, player }) => {
    if (match.winnerName === player.name) return true
    if (!player.teamId) return false
    const teamName = match.players
      .filter((teammate) => teammate.teamId === player.teamId)
      .map((teammate) => teammate.name)
      .join(' + ')
    return teamName !== '' && match.winnerName === teamName
  }).length
  const dartsThrown = appearances.reduce((total, { player }) => total + (player.dartsThrown ?? 0), 0)
  const pointsScored = appearances.reduce((total, { player }) => total + (player.pointsScored ?? 0), 0)
  const tons = appearances.reduce((total, { player }) => total + (player.tons ?? 0), 0)
  const oneEighties = appearances.reduce((total, { player }) => total + (player.oneEighties ?? 0), 0)
  const highestVisit = Math.max(0, ...appearances.map(({ player }) => player.highestVisit ?? 0))

  return {
    matches: appearances.length,
    wins,
    average3: dartsThrown > 0 ? (pointsScored / dartsThrown) * 3 : 0,
    dartsThrown,
    tons,
    oneEighties,
    highestVisit,
  }
}

function formatDocumentSize(size: number): string {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function isCourtNumber(value: number): value is CourtNumber {
  return Number.isInteger(value) && value >= 1 && value <= 5
}

function App() {
  const [appSection, setAppSection] = useState<AppSection>('scoreboard')
  const [playerCount, setPlayerCount] = useState(2)
  const [gameMode, setGameMode] = useState<GameMode>('501')
  const [teamMode, setTeamMode] = useState(false)
  const teamPreviousPlayerCount = useRef(2)
  const [courtNumber, setCourtNumber] = useState<CourtNumber>(getSavedCourtNumber)
  const [bestOfLegs, setBestOfLegs] = useState<3 | 5 | 7 | 9>(3)
  const [playerNames, setPlayerNames] = useState<string[]>(['', ''])
  const [newRosterName, setNewRosterName] = useState('')
  const [rosterSlot, setRosterSlot] = useState(0)
  const [playerPendingDeleteId, setPlayerPendingDeleteId] = useState<string | null>(null)
  const [coinResult, setCoinResult] = useState<CoinSide | null>(null)
  const [coinFlipping, setCoinFlipping] = useState(false)
  const [coinLandingSide, setCoinLandingSide] = useState<CoinSide | null>(null)
  const [useCoinToss, setUseCoinToss] = useState(true)
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
  const [manualBust, setManualBust] = useState(false)
  const [checkoutTableOpen, setCheckoutTableOpen] = useState(false)
  const [historySearch, setHistorySearch] = useState('')
  const [historyGameMode, setHistoryGameMode] = useState<GameMode | 'all'>('all')
  const [historyCourt, setHistoryCourt] = useState<CourtNumber | 'all'>('all')
  const [matchPendingDeleteId, setMatchPendingDeleteId] = useState<string | null>(null)
  const [selectedMatch, setSelectedMatch] = useState<SavedData['matches'][number] | null>(null)
  const [scoreEditPlayerId, setScoreEditPlayerId] = useState<string | null>(null)
  const [scoreEditInput, setScoreEditInput] = useState('')
  const [scoreEditLastDartDouble, setScoreEditLastDartDouble] = useState(false)
  const [scoreEditError, setScoreEditError] = useState('')
  const [message, setMessage] = useState('')
  const [savedData, setSavedData] = useState<SavedData>({ players: [], matches: [] })
  const [databaseMessage, setDatabaseMessage] = useState('')
  const [session, setSession] = useState<Session | null>(null)
  const [guestName, setGuestName] = useState<string | null>(null)
  const [registeredPlayerNames, setRegisteredPlayerNames] = useState<string[]>([])
  const [playerDirectoryMessage, setPlayerDirectoryMessage] = useState('')
  const [authLoading, setAuthLoading] = useState(Boolean(supabase))
  const [authMode, setAuthMode] = useState<'login' | 'signup' | 'reset' | 'update-password'>('login')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authDisplayName, setAuthDisplayName] = useState('')
  const [guestNameInput, setGuestNameInput] = useState('')
  const [authMessage, setAuthMessage] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [emailReportMessage, setEmailReportMessage] = useState('')
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)
  const [reopenedMatchId, setReopenedMatchId] = useState<string | null>(null)
  const [clubSignups, setClubSignups] = useState<ClubSignup[]>([])
  const [clubSignupDate, setClubSignupDate] = useState(() => getUpcomingClubDates()[0])
  const [clubSignupName, setClubSignupName] = useState('')
  const [clubSignupMessage, setClubSignupMessage] = useState('')
  const [clubSignupBusy, setClubSignupBusy] = useState(false)
  const [isClubAdmin, setIsClubAdmin] = useState(false)
  const [adminMessage, setAdminMessage] = useState('')
  const [adminSignupsBusy, setAdminSignupsBusy] = useState(false)
  const [adminEditingSignupId, setAdminEditingSignupId] = useState<string | null>(null)
  const [adminPendingDeleteId, setAdminPendingDeleteId] = useState<string | null>(null)
  const [adminEditDate, setAdminEditDate] = useState('')
  const [adminEditName, setAdminEditName] = useState('')
  const [adminGuestSignupDate, setAdminGuestSignupDate] = useState(() => getUpcomingClubDates()[0] ?? '')
  const [adminGuestSignupName, setAdminGuestSignupName] = useState('')
  const [adminExportDate, setAdminExportDate] = useState('all')
  const [adminDocuments, setAdminDocuments] = useState<ClubDocument[]>([])
  const [adminDocumentsLoading, setAdminDocumentsLoading] = useState(false)
  const [adminDocumentsBusy, setAdminDocumentsBusy] = useState(false)
  const [adminDocumentsMessage, setAdminDocumentsMessage] = useState('')
  const [adminDocumentsMessageIsError, setAdminDocumentsMessageIsError] = useState(false)
  const [adminDocumentAction, setAdminDocumentAction] = useState<string | null>(null)
  const [adminDocumentPendingDelete, setAdminDocumentPendingDelete] = useState<string | null>(null)
  const [clubAdmins, setClubAdmins] = useState<ClubAdmin[]>([])
  const [adminEmail, setAdminEmail] = useState('')
  const [adminRoleBusy, setAdminRoleBusy] = useState(false)
  const [adminNewPlayerName, setAdminNewPlayerName] = useState('')
  const [adminPlayersBusy, setAdminPlayersBusy] = useState(false)
  const [adminPlayersMessage, setAdminPlayersMessage] = useState('')
  const [adminPlayersMessageIsError, setAdminPlayersMessageIsError] = useState(false)
  const [clubTournaments, setClubTournaments] = useState<ClubTournament[]>([])
  const clubTournamentsRef = useRef<ClubTournament[]>([])
  const autoCupAttemptedRef = useRef('')
  const tournamentProgressSaveQueue = useRef<Promise<void>>(Promise.resolve())
  const [tournamentDate, setTournamentDate] = useState(() => getUpcomingClubDates()[0] ?? '')
  const [tournamentSeedRanks, setTournamentSeedRanks] = useState<Record<string, string>>({})
  const [tournamentBusy, setTournamentBusy] = useState(false)
  const [tournamentMessage, setTournamentMessage] = useState('')
  const [tournamentMessageIsError, setTournamentMessageIsError] = useState(false)
  const [pendingTournamentDeleteDate, setPendingTournamentDeleteDate] = useState<string | null>(null)
  const [confirmDeleteAllTournaments, setConfirmDeleteAllTournaments] = useState(false)
  const [tournamentDeleting, setTournamentDeleting] = useState(false)
  const [activeTournamentMatch, setActiveTournamentMatch] = useState<ActiveTournamentMatch | null>(null)
  const [savedTournamentResultDate, setSavedTournamentResultDate] = useState<string | null>(null)
  const [tournamentMatchMessage, setTournamentMatchMessage] = useState('')
  const [linkedPlayerId, setLinkedPlayerId] = useState<string | null>(null)
  const [profilePlayerId, setProfilePlayerId] = useState('')
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileMessage, setProfileMessage] = useState('')
  const [profileAvatarUrl, setProfileAvatarUrl] = useState<string | null>(null)
  const [profileAvatarBusy, setProfileAvatarBusy] = useState(false)

  useEffect(() => {
    clubTournamentsRef.current = clubTournaments
  }, [clubTournaments])

  const upcomingClubDates = getUpcomingClubDates()
  const todayDate = new Date()
  todayDate.setHours(0, 0, 0, 0)
  const todayDateKey = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, '0')}-${String(todayDate.getDate()).padStart(2, '0')}`
  const adminUpcomingSignups = clubSignups.filter((signup) => signup.eventDate >= todayDateKey)
  const adminEventDates = Array.from(new Set([
    ...upcomingClubDates,
    ...adminUpcomingSignups.map((signup) => signup.eventDate),
  ])).sort()
  const adminExportSignups = adminExportDate === 'all'
    ? adminUpcomingSignups
    : adminUpcomingSignups.filter((signup) => signup.eventDate === adminExportDate)
  const currentTournamentSignups = clubSignups.filter((signup) => signup.eventDate === tournamentDate)
  const selectedTournament = clubTournaments.find((tournament) => tournament.eventDate === tournamentDate) ?? null
  const savedTournament = savedTournamentResultDate
    ? clubTournaments.find((tournament) => tournament.eventDate === savedTournamentResultDate) ?? null
    : null
  const savedTournamentNextMatch = savedTournament ? getNextQueuedTournamentMatch(savedTournament) : null
  const activeTournament = activeTournamentMatch
    ? clubTournaments.find((tournament) => tournament.eventDate === activeTournamentMatch.eventDate) ?? null
    : null
  const activeTournamentMatchRecord = activeTournamentMatch
    ? activeTournament?.matches.find((match) => match.id === activeTournamentMatch.matchId) ?? null
    : null
  const activeTournamentRefereeId = activeTournament && activeTournamentMatchRecord
    ? getTournamentMatchRefereeSignupId(activeTournament, activeTournamentMatchRecord)
    : null
  const activeTournamentRefereeName = activeTournamentRefereeId
    ? activeTournament?.participants.find((participant) => participant.signupId === activeTournamentRefereeId)?.playerName ?? null
    : null
  const tournamentEventDates = Array.from(new Set([
    ...adminEventDates,
    ...clubTournaments.map((tournament) => tournament.eventDate),
  ])).sort()
  const profilePlayers = Array.from(new Map([
    ...savedData.players,
    ...savedData.matches.flatMap((match) => match.players.map((player) => ({
      id: player.name.trim().toLowerCase(),
      name: player.name,
      lastPlayedAt: match.playedAt,
    }))),
  ].map((player) => [player.id, player])).values())
    .sort((first, second) => first.name.localeCompare(second.name, 'nb'))
  const rosterPlayerNames = Array.from(new Map<string, string>([
    ...registeredPlayerNames,
    ...savedData.players.map((player) => player.name),
    ...(guestName ? [guestName] : []),
  ].map((name) => name.trim()).filter(Boolean).map((name) => [name.toLocaleLowerCase('nb-NO'), name] as const)).values())
    .sort((first, second) => first.localeCompare(second, 'nb'))
  const accountNameKeys = new Set(registeredPlayerNames.map((name) => name.toLocaleLowerCase('nb-NO')))
  const additionalSavedPlayers = savedData.players.filter((player) => !accountNameKeys.has(player.name.toLocaleLowerCase('nb-NO')))
  const linkedPlayer = profilePlayers.find((player) => player.id === linkedPlayerId)
  const careerStats = linkedPlayerId ? summarizeCareer(savedData.matches, linkedPlayerId) : null
  const currentClubSignup = clubSignups.find((signup) => signup.eventDate === clubSignupDate && (
    supabase ? signup.signedUpBy === session?.user.id : signup.playerName.toLocaleLowerCase('nb-NO') === clubSignupName.trim().toLocaleLowerCase('nb-NO')
  ))

  useEffect(() => {
    try {
      window.localStorage.setItem('darttavla-court-number', String(courtNumber))
    } catch {
      return
    }
  }, [courtNumber])

  useEffect(() => {
    if (!supabase) return
    let mounted = true
    try {
      setGuestName(getGuestDisplayName())
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : 'Gjesteøkten kunne ikke leses.')
    }
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
      if (nextSession) {
        try {
          endGuestSession()
        } catch {
          setDatabaseMessage('Gjesteøkten kunne ikke slettes fra denne fanen.')
        }
        setGuestName(null)
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
    if (!supabase || !isOnline) return
    let mounted = true
    void loadRegisteredPlayerNames().then((names) => {
      if (mounted) {
        setRegisteredPlayerNames(names)
        setPlayerDirectoryMessage('')
      }
    }).catch(() => {
      if (mounted) setPlayerDirectoryMessage('Kunne ikke hente listen over registrerte brukere. Oppdater Supabase-oppsettet og prøv igjen.')
    })
    return () => { mounted = false }
  }, [session, guestName, isOnline])

  useEffect(() => {
    let mounted = true
    setIsClubAdmin(false)
    if (!session) {
      setClubAdmins([])
      return () => { mounted = false }
    }

    void loadClubAdminStatus().then((isAdmin) => {
      if (mounted) setIsClubAdmin(isAdmin)
    }).catch(() => {
      if (mounted) setDatabaseMessage('Kunne ikke kontrollere administratorrollen. Last siden på nytt, eller kontakt en administrator.')
    })
    return () => { mounted = false }
  }, [session])

  useEffect(() => {
    if (supabase && !session && !guestName) {
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
  }, [session, guestName])

  useEffect(() => {
    if (appSection !== 'profile' || !supabase || !session) return
    let mounted = true
    setProfileLoading(true)
    setProfileMessage('')
    void loadLinkedPlayerProfile(session.user.id).then((profile) => {
      if (mounted) {
        setLinkedPlayerId(profile.playerId)
        setProfilePlayerId(profile.playerId ?? '')
        setProfileAvatarUrl(profile.avatarUrl)
      }
    }).catch(() => {
      if (mounted) setProfileMessage('Kunne ikke hente profilen. Kontroller at profiltabellen er satt opp i Supabase.')
    }).finally(() => {
      if (mounted) setProfileLoading(false)
    })
    return () => { mounted = false }
  }, [appSection, session])

  useEffect(() => {
    if ((appSection !== 'club-evenings' && appSection !== 'admin') || (supabase && !session)) return
    let mounted = true
    void loadClubSignups().then((signups) => {
      if (mounted) {
        setClubSignups(signups)
        setClubSignupMessage('')
      }
    }).catch(() => {
      if (mounted) {
        if (appSection === 'admin') setAdminMessage('Kunne ikke hente påmeldingene. Kontroller at påmeldingstabellen og administratorpolicyene er satt opp i Supabase.')
        else setClubSignupMessage('Kunne ikke hente påmeldingene. Kontroller at påmeldingstabellen er satt opp i Supabase, og prøv igjen.')
      }
    })
    return () => { mounted = false }
  }, [appSection, session, isOnline])

  useEffect(() => {
    if (appSection !== 'admin' || !isClubAdmin) return
    let mounted = true
    setAdminMessage('')
    void loadClubAdmins().then((admins) => {
      if (mounted) setClubAdmins(admins)
    }).catch(() => {
      if (mounted) setAdminMessage('Kunne ikke hente administratorlisten. Kontroller at Supabase-oppsettet er oppdatert.')
    })
    return () => { mounted = false }
  }, [appSection, isClubAdmin])

  useEffect(() => {
    if (appSection !== 'admin' || !isClubAdmin) return
    let mounted = true
    setAdminDocumentsLoading(true)
    setAdminDocumentsMessage('')
    setAdminDocumentsMessageIsError(false)
    void loadClubDocuments().then((documents) => {
      if (mounted) setAdminDocuments(documents)
    }).catch((error: unknown) => {
      if (mounted) {
        setAdminDocumentsMessage(error instanceof Error
          ? `Kunne ikke hente dokumentene: ${error.message}`
          : 'Kunne ikke hente dokumentene. Kontroller Supabase-oppsettet.')
        setAdminDocumentsMessageIsError(true)
      }
    }).finally(() => {
      if (mounted) setAdminDocumentsLoading(false)
    })
    return () => { mounted = false }
  }, [appSection, isClubAdmin, isOnline])

  useEffect(() => {
    if (appSection !== 'admin' && appSection !== 'tournament') return
    if (!session) return
    let mounted = true
    setTournamentMessage('')
    void loadClubTournaments().then((tournaments) => {
      if (mounted) setClubTournaments(tournaments)
    }).catch((error: unknown) => {
      if (mounted) {
        showTournamentError(error instanceof Error
          ? `Kunne ikke hente turneringene: ${error.message}`
          : 'Kunne ikke hente turneringene. Kontroller tilkoblingen og Supabase-oppsettet.')
      }
    })
    return () => { mounted = false }
  }, [appSection, session, isOnline])

  useEffect(() => {
    if ((appSection !== 'admin' && appSection !== 'tournament') || !session || !isOnline) return
    let mounted = true
    const refreshTournaments = async () => {
      try {
        const tournaments = await loadClubTournaments()
        if (!mounted) return
        clubTournamentsRef.current = tournaments
        setClubTournaments(tournaments)
      } catch (error) {
        console.error('Could not refresh tournament matches:', error)
      }
    }
    const interval = window.setInterval(() => { void refreshTournaments() }, 5000)
    return () => {
      mounted = false
      window.clearInterval(interval)
    }
  }, [appSection, isOnline, session])

  useEffect(() => {
    const handleOffline = () => {
      setIsOnline(false)
      setDatabaseMessage(guestName
        ? 'Du er offline. Gjesteøkten lagres midlertidig i denne fanen.'
        : supabase
          ? 'Du er offline. Endringer lagres på enheten og synkroniseres når nettet er tilbake.'
        : 'Du er offline. Kampdata lagres i denne nettleseren.')
    }

    const handleOnline = () => {
      setIsOnline(true)
      if (!supabase || !session) {
        setDatabaseMessage('')
        return
      }
      void syncPendingChanges().then(async ({ synced, pending, issues }) => {
        setSavedData(await loadSavedData())
        const pendingIssues = issues.filter((issue) => issue.kind !== 'send-email')
        const issueLabels: Record<PendingSyncIssue['kind'], string> = {
          'save-players': 'Spillerliste',
          'delete-player': 'Sletting av spiller',
          'save-match': 'Kampresultat',
          'delete-match': 'Sletting av kamp',
          'send-email': 'E-postrapport',
        }
        const details = issues.map((issue) => `${issueLabels[issue.kind]}: ${issue.message}`).join(' ')
        setDatabaseMessage(pending > 0
          ? `${pending} ${pending === 1 ? 'endring venter' : 'endringer venter'} fortsatt på synkronisering.${pendingIssues.length > 0 ? ` ${pendingIssues.map((issue) => `${issueLabels[issue.kind]}: ${issue.message}`).join(' ')}` : ''}`
          : synced > 0
            ? `${synced} ${synced === 1 ? 'endring ble' : 'endringer ble'} synkronisert.${details ? ` ${details}` : ''}`
            : details ? `Noen e-postrapporter venter fortsatt. ${details}` : '')
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
  }, [session, guestName])

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
  const roundWordPlural = gameMode === '121' ? 'runder' : 'legg'
  const checkoutHint = currentPlayer && gameMode !== 'cricket' ? getCheckoutHint(currentPlayer.score) : null
  const dartLimitBullOff = gameMode === '501'
    && players.length > 1
    && !teamMode
    && players.every((player) => getLegDartsThrown(players, legNumber, player.id) >= 42)
  const names = Array.from({ length: playerCount }, (_, index) => playerNames[index] ?? '')
  const normalizedHistorySearch = historySearch.trim().toLocaleLowerCase('nb-NO')
  const filteredSavedMatches = savedData.matches.filter((match) => {
    const matchesMode = historyGameMode === 'all' || (match.gameMode ?? '501') === historyGameMode
    const matchesCourt = historyCourt === 'all' || (match.courtNumber ?? 1) === historyCourt
    const searchableText = [match.winnerName, ...match.players.map((player) => player.name), `bane ${match.courtNumber ?? 1}`]
      .join(' ')
      .toLocaleLowerCase('nb-NO')
    return matchesMode && matchesCourt && (!normalizedHistorySearch || searchableText.includes(normalizedHistorySearch))
  })
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
    if (playerCount > 1 && useCoinToss && (coinResult === null || coinStarterIndex === null)) return
    const roster = names.map((name, index) => ({
      id: `${Date.now()}-${index}`,
      name: name.trim() || `Spiller ${index + 1}`,
      score: gameMode === '121' ? 121 : gameMode === '501' ? 501 : 0,
      visits: [],
      ...(teamMode ? { teamId: index % 2 === 0 ? 'A' as const : 'B' as const } : {}),
      ...(gameMode === 'cricket' ? { cricketMarks: Object.fromEntries(CRICKET_TARGETS.map((target) => [target, 0])) } : {}),
    }))
    setPlayers(roster)
    setCoinStarterIndex(playerCount > 1 ? useCoinToss ? coinStarterIndex : 0 : null)
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
    setManualBust(false)
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

  async function removeSavedMatch(matchId: string) {
    if (!savedData.matches.some((match) => match.id === matchId)) return
    try {
      await deleteSavedMatch(matchId)
      setSavedData((current) => ({ ...current, matches: current.matches.filter((match) => match.id !== matchId) }))
      setSelectedMatch((current) => current?.id === matchId ? null : current)
      setMatchPendingDeleteId(null)
    } catch {
      setDatabaseMessage('Kampen kunne ikke slettes fra arkivet.')
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
        const displayName = authDisplayName.trim().replace(/\s+/g, ' ')
        if (displayName.length < 1 || displayName.length > 24) {
          throw new Error('Visningsnavnet må være mellom 1 og 24 tegn.')
        }
        const { data, error } = await supabase.auth.signUp({
          email: authEmail.trim(),
          password: authPassword,
          options: { data: { display_name: displayName } },
        })
        if (error) throw error
        if (!data.session) setAuthMessage('Kontoen er opprettet. Bekreft e-postadressen; deretter vises visningsnavnet i spillerlisten.')
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

  function startGuest() {
    try {
      const displayName = beginGuestSession(guestNameInput)
      setGuestName(displayName)
      setGuestNameInput(displayName)
      setPlayerNames([displayName, ''])
      setSavedData({ players: [], matches: [] })
      setAppSection('scoreboard')
      newGame()
      setAuthMessage('')
      setDatabaseMessage('')
      setEmailReportMessage('')
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : 'Kunne ikke starte gjesteøkten. Prøv igjen.')
    }
  }

  function exitGuest() {
    try {
      endGuestSession()
      setGuestName(null)
      setSavedData({ players: [], matches: [] })
      setPlayerNames(['', ''])
      setAppSection('scoreboard')
      newGame()
      setDatabaseMessage('')
      setEmailReportMessage('')
    } catch {
      setDatabaseMessage('Gjesteøkten kunne ikke avsluttes. Prøv igjen.')
    }
  }

  function persistCurrentTournamentProgress(
    overrides: Partial<TournamentMatchProgress> = {},
    previousState: TournamentGameHistory | null = history.at(-1) ?? null,
  ) {
    if (!activeTournamentMatch) return
    const progress: TournamentMatchProgress = {
      progressId: activeTournamentMatch.progressId,
      players,
      activePlayer,
      legsWon,
      matchWinnerId,
      legStarterIndex,
      gamePhase: gamePhase === 'setup' ? 'bull-off' : gamePhase,
      coinStarterIndex,
      bullWinnerId,
      winnerId,
      previousState,
      ...overrides,
    }
    void persistTournamentMatchProgress(activeTournamentMatch, progress).catch(() => undefined)
  }

  function startGame() {
    const startingPlayer = players.findIndex((player) => player.id === bullWinnerId)
    if (startingPlayer < 0 || (useCoinToss && coinStarterIndex === null)) return
    setActivePlayer(startingPlayer)
    setLegStarterIndex(startingPlayer)
    setGamePhase('playing')
    persistCurrentTournamentProgress({
      activePlayer: startingPlayer,
      legStarterIndex: startingPlayer,
      gamePhase: 'playing',
    })
  }

  function finishLeg(
    legWinnerId: string,
    completedPlayers: Player[],
    finishMethod: 'checkout' | 'bull-off',
    nextActivePlayer = activePlayer,
    previousState: TournamentGameHistory | null = null,
  ) {
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
        courtNumber,
        gameMode,
        bestOfLegs,
        finishMethod,
        legStarterName: players[legStarterIndex]?.name,
        players: completedPlayers.map((player) => summarizePlayer(player, nextLegsWon[player.id] ?? 0)),
      }
      void saveFinishedMatch(match).then(() => loadSavedData()).then(setSavedData).catch(() => {
        setDatabaseMessage('Kampen er avgjort, men resultatet kunne ikke lagres.')
      })
      if (supabase && session && !guestName) {
        void sendMatchReport(match).then((delivery) => {
          setEmailReportMessage(delivery === 'sent'
            ? 'Kampresultatet er sendt til de registrerte spillerne i kampen.'
            : delivery === 'no-recipients'
              ? 'Ingen av spillerne i kampen har en bekreftet e-postadresse knyttet til spillerprofilen sin.'
              : 'E-postrapporten er lagret og sendes når nettet og e-posttjenesten er tilgjengelige.')
        }).catch(() => {
          setEmailReportMessage('Kampen er lagret, men e-postrapporten kunne ikke sendes. Kontroller e-postoppsettet i Supabase.')
        })
      } else if (!guestName) {
        setEmailReportMessage('E-postrapport krever Supabase-innlogging.')
      }
      if (activeTournamentMatch) void saveFinishedTournamentMatch(activeTournamentMatch, nextLegsWon, completedPlayers)
    } else {
      persistCurrentTournamentProgress({
        players: completedPlayers,
        activePlayer: nextActivePlayer,
        legsWon: nextLegsWon,
        winnerId: legWinnerId,
        matchWinnerId: null,
        gamePhase: 'playing',
        previousState,
      }, previousState)
    }
  }

  function finishLegBullOff(legWinnerId: string) {
    const legWinner = players.find((player) => player.id === legWinnerId)
    if (!legWinner || gamePhase !== 'leg-bull-off' || (!dartLimitBullOff && !players.some((player) => player.score === 42))) return
    const nextHistory = [...history, { players, activePlayer, winnerId, legsWon, matchWinnerId }]
    setHistory(nextHistory)
    setBullWinnerId(legWinner.id)
    finishLeg(legWinner.id, players, 'bull-off', activePlayer, nextHistory.at(-1) ?? null)
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

      const nextHistory = [...history, { players, activePlayer, winnerId, legsWon, matchWinnerId }]
      const nextActivePlayer = (activePlayer + 1) % players.length
      setHistory(nextHistory)
      setPlayers(nextPlayers)
      setActivePlayer(nextActivePlayer)
      if (cricketWinner) finishLeg(currentPlayer.id, nextPlayers, 'checkout', nextActivePlayer, nextHistory.at(-1) ?? null)
      else {
        setWinnerId(null)
        persistCurrentTournamentProgress({
          players: nextPlayers,
          activePlayer: nextActivePlayer,
          winnerId: null,
        }, nextHistory.at(-1) ?? null)
      }
      setDarts(['', '', ''])
      setManualTotal('')
      setManualBust(false)
      setMessage(cricketWinner ? 'Alle feltene er lukket. Kampen er avgjort.' : `${visitPoints > 0 ? `${visitPoints} poeng lagt til.` : 'Treffene er registrert.'}`)
      return
    }

    const remaining = currentPlayer.score - total
    const bust = manualBust || remaining < 0 || remaining === 1 || (remaining === 0 && !lastDartIsDouble)
    const checkout = !bust && remaining === 0 && lastDartIsDouble
    const nextPlayers = players.map((player, index) => {
      const isCurrentPlayer = index === activePlayer
      const sharesTeam = teamMode && player.teamId === currentPlayer.teamId
      return isCurrentPlayer || sharesTeam
        ? { ...player, score: bust ? currentPlayer.score : remaining, visits: isCurrentPlayer ? [...player.visits, { darts: scores, total, bust, checkout, dartsThrown, legNumber }] : player.visits }
        : player
    })

    const nextHistory = [...history, { players, activePlayer, winnerId, legsWon, matchWinnerId }]
    const nextActivePlayer = (activePlayer + 1) % players.length
    const nextLegNumber = legScorePlayers.reduce((total, player) => total + (legsWon[player.id] ?? 0), 0) + 1
    const shouldStartDartLimitBullOff = !checkout
      && gameMode === '501'
      && !teamMode
      && players.length > 1
      && nextPlayers.every((player) => getLegDartsThrown(nextPlayers, nextLegNumber, player.id) >= 42)
    setHistory(nextHistory)
    setPlayers(nextPlayers)
    setActivePlayer(nextActivePlayer)
    if (checkout) finishLeg(currentPlayer.id, nextPlayers, 'checkout', nextActivePlayer, nextHistory.at(-1) ?? null)
    else {
      setWinnerId(null)
      if (shouldStartDartLimitBullOff) {
        setGamePhase('leg-bull-off')
        setBullWinnerId('')
        setMessage('Alle spillerne har brukt 42 piler uten avgjørelse. Velg den som kom nærmest bull.')
      }
      persistCurrentTournamentProgress({
        players: nextPlayers,
        activePlayer: nextActivePlayer,
        winnerId: null,
        gamePhase: shouldStartDartLimitBullOff ? 'leg-bull-off' : 'playing',
        bullWinnerId: shouldStartDartLimitBullOff ? '' : bullWinnerId,
      }, nextHistory.at(-1) ?? null)
    }
    setDarts(['', '', ''])
    setManualTotal('')
    setManualDartsThrown(3)
    setManualLastDartDouble(false)
    setManualBust(false)
    if (!shouldStartDartLimitBullOff) setMessage(bust ? `${currentPlayer.name} gikk bust. Poengsummen står.` : '')
  }

  function undoVisit() {
    const previous = history.at(-1)
    if (!previous) return
    setPlayers(previous.players)
    setActivePlayer(previous.activePlayer)
    setWinnerId(previous.winnerId)
    setLegsWon(previous.legsWon)
    setMatchWinnerId(previous.matchWinnerId)
    const restoredDartLimitBullOff = gameMode === '501'
      && !teamMode
      && players.length > 1
      && previous.players.every((player) => getLegDartsThrown(previous.players, legNumber, player.id) >= 42)
    setGamePhase(restoredDartLimitBullOff ? 'leg-bull-off' : 'playing')
    const nextHistory = history.slice(0, -1)
    setHistory(nextHistory)
    setDarts(['', '', ''])
    setManualTotal('')
    setManualDartsThrown(3)
    setManualLastDartDouble(false)
    setManualBust(false)
    setMessage('Siste tur er angret.')
    persistCurrentTournamentProgress({
      players: previous.players,
      activePlayer: previous.activePlayer,
      winnerId: previous.winnerId,
      legsWon: previous.legsWon,
      matchWinnerId: previous.matchWinnerId,
      gamePhase: restoredDartLimitBullOff ? 'leg-bull-off' : 'playing',
      previousState: nextHistory.at(-1) ?? null,
    }, nextHistory.at(-1) ?? null)
  }

  function resetCurrentGame() {
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
    setManualBust(false)
    setMessage('')
    setActiveTournamentMatch(null)
    setSavedTournamentResultDate(null)
    setTournamentMatchMessage('')
  }

  function newGame() {
    if (activeTournamentMatch && matchWinnerId) return
    resetCurrentGame()
  }

  function startNextLeg() {
    if (!winnerId || matchWinnerId) return
    const nextStarter = (legStarterIndex + 1) % players.length
    const nextPlayers = players.map((player) => ({
      ...player,
      score: gameMode === '121' ? 121 : gameMode === '501' ? 501 : 0,
      ...(gameMode === 'cricket' ? { cricketMarks: Object.fromEntries(CRICKET_TARGETS.map((target) => [target, 0])) } : {}),
      scoreCorrected: false,
    }))
    setPlayers(nextPlayers)
    setWinnerId(null)
    setActivePlayer(nextStarter)
    setLegStarterIndex(nextStarter)
    setHistory([])
    setDarts(['', '', ''])
    setManualTotal('')
    setManualDartsThrown(3)
    setManualLastDartDouble(false)
    setManualBust(false)
    setBullWinnerId('')
    setCoinStarterIndex(null)
    setCoinResult(null)
    setMessage('')
    setEmailReportMessage('')
    persistCurrentTournamentProgress({
      players: nextPlayers,
      activePlayer: nextStarter,
      winnerId: null,
      matchWinnerId: null,
      legStarterIndex: nextStarter,
      gamePhase: 'playing',
      coinStarterIndex: null,
      bullWinnerId: '',
      previousState: null,
    })
  }

  function reopenSavedMatch(match: SavedData['matches'][number]) {
    if (!match.finishMethod || match.players.length === 0) return
    setSelectedMatch(null)
    const isCricket = match.gameMode === 'cricket'
    const reopenedPlayers = match.players.map((savedPlayer) => {
      const marksVisits = savedPlayer.teamId
        ? match.players.filter((player) => player.teamId === savedPlayer.teamId).flatMap((player) => player.visits ?? [])
        : savedPlayer.visits ?? []
      return {
        id: savedPlayer.name.trim().toLowerCase(),
        name: savedPlayer.name,
        score: savedPlayer.score,
        visits: (savedPlayer.visits ?? []).map((visit) => ({ ...visit })),
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
    setCourtNumber(match.courtNumber ?? 1)
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

    const nextHistory = [...history, { players, activePlayer, winnerId, legsWon, matchWinnerId }]
    setHistory(nextHistory)
    const correctedPlayers = players.map((item) => item.id === player.id || (teamMode && item.teamId === player.teamId)
      ? { ...item, score: correctedScore, scoreCorrected: true }
      : item)
    closeScoreEditor()

    if (correctedScore === 0) finishLeg(player.id, correctedPlayers, 'checkout', activePlayer, nextHistory.at(-1) ?? null)
    else {
      setPlayers(correctedPlayers)
      setMessage(`${player.name}s poengsum er korrigert.`)
      persistCurrentTournamentProgress({
        players: correctedPlayers,
        previousState: nextHistory.at(-1) ?? null,
      }, nextHistory.at(-1) ?? null)
    }
  }

  function changeDart(index: number, value: string) {
    setDarts((current) => current.map((dart, dartIndex) => dartIndex === index ? value : dart) as DartInputs)
    setMessage('')
  }

  function setManualVisitTotal(value: string, dartsThrown: 1 | 2 | 3 = manualDartsThrown) {
    setManualTotal(value)
    setManualLastDartDouble(
      value.trim() !== ''
      && Number(value) === currentPlayer?.score
      && checkoutHint !== null
      && checkoutHint.split('→').length <= dartsThrown,
    )
    setMessage('')
  }

  async function addAdminGuestClubSignup() {
    if (adminSignupsBusy) return
    const guestName = adminGuestSignupName.trim().replace(/\s+/g, ' ')
    setAdminSignupsBusy(true)
    setAdminMessage('')
    try {
      await addAdminGuestSignup(adminGuestSignupDate, guestName)
      setClubSignups(await loadClubSignups())
      setAdminGuestSignupName('')
      setAdminMessage(`${guestName} er lagt til på klubbkvelden.`)
    } catch (error) {
      setAdminMessage(error instanceof Error ? error.message : 'Gjestepåmeldingen kunne ikke legges til.')
    } finally {
      setAdminSignupsBusy(false)
    }
  }

  async function saveAdminSignup(signupId: string) {
    setAdminSignupsBusy(true)
    setAdminMessage('')
    try {
      await updateClubSignup(signupId, adminEditDate, adminEditName)
      setClubSignups(await loadClubSignups())
      setAdminEditingSignupId(null)
      setAdminMessage('Påmeldingen er oppdatert.')
    } catch (error) {
      setAdminMessage(error instanceof Error ? error.message : 'Påmeldingen kunne ikke oppdateres.')
    } finally {
      setAdminSignupsBusy(false)
    }
  }

  async function removeAdminSignup(signupId: string) {
    setAdminSignupsBusy(true)
    setAdminMessage('')
    try {
      await deleteClubSignup(signupId)
      setClubSignups(await loadClubSignups())
      setAdminPendingDeleteId(null)
      setAdminMessage('Påmeldingen er slettet.')
    } catch (error) {
      setAdminMessage(error instanceof Error ? error.message : 'Påmeldingen kunne ikke slettes.')
    } finally {
      setAdminSignupsBusy(false)
    }
  }

  async function changeClubAdminRole(email: string, makeAdmin: boolean) {
    setAdminRoleBusy(true)
    setAdminMessage('')
    try {
      await setClubAdminRole(email, makeAdmin)
      setClubAdmins(await loadClubAdmins())
      setAdminEmail('')
      setAdminMessage(makeAdmin ? 'Administratorrollen er gitt.' : 'Administratorrollen er fjernet.')
    } catch (error) {
      setAdminMessage(error instanceof Error ? error.message : 'Administratorrollen kunne ikke endres.')
    } finally {
      setAdminRoleBusy(false)
    }
  }

  async function addAdminPlayer() {
    const name = adminNewPlayerName.trim()
    if (!name || adminPlayersBusy) return
    if (name.length > 24) {
      setAdminPlayersMessage('Spillernavnet kan ikke være lengre enn 24 tegn.')
      setAdminPlayersMessageIsError(true)
      return
    }
    if (savedData.players.some((player) => player.name.toLocaleLowerCase('nb-NO') === name.toLocaleLowerCase('nb-NO'))) {
      setAdminPlayersMessage('Spilleren finnes allerede i spillerlisten.')
      setAdminPlayersMessageIsError(true)
      return
    }

    setAdminPlayersBusy(true)
    setAdminPlayersMessage('')
    setAdminPlayersMessageIsError(false)
    try {
      await savePlayers([name])
      setSavedData(await loadSavedData())
      setAdminNewPlayerName('')
      setAdminPlayersMessage(`${name} er lagt til i spillerlisten.`)
    } catch (error) {
      setAdminPlayersMessage(error instanceof Error ? error.message : 'Spilleren kunne ikke legges til.')
      setAdminPlayersMessageIsError(true)
    } finally {
      setAdminPlayersBusy(false)
    }
  }

  async function uploadAdminDocuments(files: File[]) {
    if (files.length === 0) return
    setAdminDocumentsBusy(true)
    setAdminDocumentsMessage('')
    setAdminDocumentsMessageIsError(false)
    let uploadedCount = 0
    const failures: string[] = []
    try {
      for (const file of files) {
        try {
          await uploadClubDocument(file)
          uploadedCount += 1
        } catch (error) {
          failures.push(`${file.name}: ${error instanceof Error ? error.message : 'Opplastingen mislyktes.'}`)
        }
      }
      try {
        setAdminDocuments(await loadClubDocuments())
      } catch (error) {
        failures.push(error instanceof Error ? `Listen kunne ikke oppdateres: ${error.message}` : 'Dokumentlisten kunne ikke oppdateres.')
      }
      setAdminDocumentsMessageIsError(failures.length > 0)
      setAdminDocumentsMessage(failures.length > 0
        ? `${uploadedCount} dokument(er) lastet opp. ${failures.join(' ')}`
        : `${uploadedCount} dokument(er) lastet opp.`)
    } finally {
      setAdminDocumentsBusy(false)
    }
  }

  async function downloadAdminDocument(document: ClubDocument) {
    setAdminDocumentAction(document.path)
    setAdminDocumentsMessage('')
    setAdminDocumentsMessageIsError(false)
    try {
      const blob = await downloadClubDocument(document.path)
      const url = URL.createObjectURL(blob)
      const link = window.document.createElement('a')
      link.href = url
      link.download = document.name
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      setAdminDocumentsMessage(error instanceof Error ? `Kunne ikke laste ned dokumentet: ${error.message}` : 'Dokumentet kunne ikke lastes ned.')
      setAdminDocumentsMessageIsError(true)
    } finally {
      setAdminDocumentAction(null)
    }
  }

  async function removeAdminDocument(document: ClubDocument) {
    setAdminDocumentAction(document.path)
    setAdminDocumentsMessage('')
    setAdminDocumentsMessageIsError(false)
    try {
      await deleteClubDocument(document.path)
      setAdminDocumentPendingDelete(null)
      try {
        setAdminDocuments(await loadClubDocuments())
        setAdminDocumentsMessage('Dokumentet er slettet.')
      } catch (error) {
        setAdminDocumentsMessage(error instanceof Error
          ? `Dokumentet er slettet, men listen kunne ikke oppdateres: ${error.message}`
          : 'Dokumentet er slettet, men dokumentlisten kunne ikke oppdateres.')
        setAdminDocumentsMessageIsError(true)
      }
    } catch (error) {
      setAdminDocumentsMessage(error instanceof Error ? `Kunne ikke slette dokumentet: ${error.message}` : 'Dokumentet kunne ikke slettes.')
      setAdminDocumentsMessageIsError(true)
    } finally {
      setAdminDocumentAction(null)
    }
  }

  function showTournamentError(errorMessage: string) {
    setTournamentMessage(errorMessage)
    setTournamentMessageIsError(true)
  }

  async function assignTournamentBoard(match: TournamentMatch, assignedCourt: CourtNumber) {
    if (!isClubAdmin || !selectedTournament || !match.inProgress) return
    if (selectedTournament.matches.some((item) => item.id !== match.id && item.inProgress?.courtNumber === assignedCourt)) {
      showTournamentError(`Bane ${assignedCourt} er allerede tildelt en pågående kamp.`)
      return
    }
    setTournamentBusy(true)
    setTournamentMessage('')
    setTournamentMessageIsError(false)
    try {
      const updatedTournament = await saveTournamentMatchProgress(selectedTournament.eventDate, match.id, {
        ...match.inProgress,
        courtNumber: assignedCourt,
      })
      const updatedTournaments = [...clubTournamentsRef.current.filter((item) => item.eventDate !== updatedTournament.eventDate), updatedTournament]
        .sort((first, second) => first.eventDate.localeCompare(second.eventDate))
      clubTournamentsRef.current = updatedTournaments
      setClubTournaments(updatedTournaments)
      setTournamentMessage(`Kampen er tildelt bane ${assignedCourt}.`)
    } catch (error) {
      showTournamentError(tournamentErrorMessage(error, 'Banen kunne ikke tildeles kampen.'))
    } finally {
      setTournamentBusy(false)
    }
  }

  function requestTournamentDelete(eventDate: string) {
    setPendingTournamentDeleteDate(eventDate)
    setConfirmDeleteAllTournaments(false)
    setTournamentMessage('')
    setTournamentMessageIsError(false)
  }

  async function removeTournament(eventDate: string) {
    if (!isClubAdmin) return
    setTournamentDeleting(true)
    setTournamentMessage('')
    setTournamentMessageIsError(false)
    try {
      if (activeTournamentMatch?.eventDate === eventDate) {
        await tournamentProgressSaveQueue.current
      }
      await deleteClubTournament(eventDate)
      if (activeTournamentMatch?.eventDate === eventDate) resetCurrentGame()
      setClubTournaments((current) => current.filter((tournament) => tournament.eventDate !== eventDate))
      setPendingTournamentDeleteDate(null)
      setTournamentMessage('Turneringen er slettet.')
      setTournamentMessageIsError(false)
    } catch (error) {
      showTournamentError(error instanceof Error ? error.message : 'Turneringen kunne ikke slettes.')
    } finally {
      setTournamentDeleting(false)
    }
  }

  async function removeAllTournaments() {
    if (!isClubAdmin) return
    if (activeTournamentMatch || clubTournamentsRef.current.some((tournament) => tournament.matches.some((match) => match.inProgress))) {
      showTournamentError('Avslutt turneringskampen før du sletter alle turneringene.')
      return
    }
    setTournamentDeleting(true)
    setTournamentMessage('')
    setTournamentMessageIsError(false)
    try {
      await deleteAllClubTournaments()
      setClubTournaments([])
      setPendingTournamentDeleteDate(null)
      setConfirmDeleteAllTournaments(false)
      setTournamentMessage('Alle turneringene er slettet.')
      setTournamentMessageIsError(false)
    } catch (error) {
      showTournamentError(error instanceof Error ? error.message : 'Turneringene kunne ikke slettes.')
    } finally {
      setTournamentDeleting(false)
    }
  }

  async function persistTournament(tournament: ClubTournament, successMessage: string) {
    if (!isClubAdmin) return
    setTournamentBusy(true)
    setTournamentMessage('')
    setTournamentMessageIsError(false)
    try {
      await saveClubTournament(tournament)
      setClubTournaments((current) => [...current.filter((item) => item.eventDate !== tournament.eventDate), tournament]
        .sort((first, second) => first.eventDate.localeCompare(second.eventDate)))
      setTournamentMessage(successMessage)
    } catch (error) {
      showTournamentError(error instanceof Error ? error.message : 'Turneringen kunne ikke lagres.')
    } finally {
      setTournamentBusy(false)
    }
  }

  function persistTournamentMatchProgress(
    activeMatch: ActiveTournamentMatch,
    progress: TournamentMatchProgress,
  ): Promise<void> {
    const saveOperation = tournamentProgressSaveQueue.current.catch(() => undefined).then(async () => {
      const updatedTournament = await saveTournamentMatchProgress(activeMatch.eventDate, activeMatch.matchId, progress)
      const updatedTournaments = [...clubTournamentsRef.current.filter((item) => item.eventDate !== updatedTournament.eventDate), updatedTournament]
        .sort((first, second) => first.eventDate.localeCompare(second.eventDate))
      clubTournamentsRef.current = updatedTournaments
      setClubTournaments(updatedTournaments)
      setTournamentMatchMessage('Kampen lagres automatisk mens dere spiller.')
    })
    tournamentProgressSaveQueue.current = saveOperation.catch((error: unknown) => {
      setTournamentMatchMessage(`Kampen kunne ikke lagres for gjenopptakelse: ${tournamentErrorMessage(error, 'Ukjent lagringsfeil.')}`)
    })
    return saveOperation
  }

  async function saveFinishedTournamentMatch(
    activeMatch: ActiveTournamentMatch,
    completedLegs: Record<string, number>,
    completedPlayers: Player[],
  ) {
    await tournamentProgressSaveQueue.current
    if (!isClubAdmin) {
      setTournamentMatchMessage('Du må være klubbadministrator for å lagre turneringsresultatet.')
      return
    }
    const tournament = clubTournamentsRef.current.find((item) => item.eventDate === activeMatch.eventDate)
    if (!tournament) {
      setTournamentMatchMessage('Turneringen ble ikke funnet. Resultatet er ikke lagret i turneringen.')
      return
    }
    const match = tournament.matches.find((item) => item.id === activeMatch.matchId)
    if (!match) {
      setTournamentMatchMessage('Turneringskampen ble ikke funnet. Resultatet er ikke lagret i turneringen.')
      return
    }
    const playerOneLegs = completedLegs[activeMatch.playerOneId]
    const playerTwoLegs = completedLegs[activeMatch.playerTwoId]
    if (playerOneLegs === undefined || playerTwoLegs === undefined) {
      setTournamentMatchMessage('Kampens leggresultat mangler. Turneringsresultatet er ikke lagret.')
      return
    }
    if (!match.playerTwoSignupId) {
      setTournamentMatchMessage('Kampens spillerliste er ugyldig. Turneringsresultatet er ikke lagret.')
      return
    }
    const playerOne = completedPlayers.find((player) => player.id === activeMatch.playerOneId)
    const playerTwo = completedPlayers.find((player) => player.id === activeMatch.playerTwoId)
    if (!playerOne || !playerTwo) {
      setTournamentMatchMessage('Kampens spillerstatistikk mangler. Turneringsresultatet er ikke lagret.')
      return
    }
    const playerStats = [
      summarizeTournamentPlayer(match.playerOneSignupId, playerOne.visits),
      summarizeTournamentPlayer(match.playerTwoSignupId, playerTwo.visits),
    ]
    setTournamentBusy(true)
    setTournamentMessage('')
    setTournamentMessageIsError(false)
    setTournamentMatchMessage('Lagrer turneringsresultatet …')
    try {
      let updatedTournament = await finishTournamentMatch(
        activeMatch.eventDate,
        activeMatch.matchId,
        activeMatch.progressId,
        playerOneLegs,
        playerTwoLegs,
        playerStats,
      )
      if (match.phase === 'cup') {
        const currentRoundMatches = updatedTournament.matches.filter((item) =>
          item.phase === 'cup' && item.roundNumber === match.roundNumber)
        const nextRoundAlreadyExists = updatedTournament.matches.some((item) =>
          item.phase === 'cup' && item.roundNumber === match.roundNumber + 1)
        if (currentRoundMatches.length > 1
          && currentRoundMatches.every((item) => item.winnerSignupId !== null)
          && !nextRoundAlreadyExists) {
          const nextRoundTournament = createNextCupRound(updatedTournament)
          const nextRoundMatches = nextRoundTournament.matches.filter((item) => item.roundNumber === match.roundNumber + 1)
          updatedTournament = await addTournamentCupRound(
            activeMatch.eventDate,
            match.roundNumber + 1,
            nextRoundMatches,
          )
        }
      }
      const updatedTournaments = [...clubTournamentsRef.current.filter((item) => item.eventDate !== updatedTournament.eventDate), updatedTournament]
        .sort((first, second) => first.eventDate.localeCompare(second.eventDate))
      clubTournamentsRef.current = updatedTournaments
      setClubTournaments(updatedTournaments)
      setTournamentDate(activeMatch.eventDate)
      setActiveTournamentMatch(null)
      setSavedTournamentResultDate(activeMatch.eventDate)
      setTournamentMatchMessage('Turneringsresultatet er registrert automatisk.')
    } catch (error) {
      const details = tournamentErrorMessage(error, 'Ukjent lagringsfeil.')
      setTournamentMatchMessage(`Kampen er ferdig, men turneringsresultatet eller neste cuprunde kunne ikke lagres. ${details}`)
    } finally {
      setTournamentBusy(false)
    }
  }

  function restoreTournamentMatch(match: TournamentMatch) {
    if (!selectedTournament || !match.inProgress || !isClubAdmin) return
    if (!match.inProgress.courtNumber) {
      showTournamentError('Tildel en bane til kampen i kampoversikten før du fortsetter den.')
      return
    }
    const progress = {
      ...match.inProgress,
      progressId: match.inProgress.progressId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    }
    if (progress.players.length !== 2 || progress.activePlayer < 0 || progress.activePlayer > 1) {
      showTournamentError('Den lagrede kampstillingen er ugyldig og kan ikke gjenopptas.')
      return
    }
    setActiveTournamentMatch({
      eventDate: selectedTournament.eventDate,
      matchId: match.id,
      playerOneId: progress.players[0].id,
      playerTwoId: progress.players[1].id,
      progressId: progress.progressId,
    })
    setSavedTournamentResultDate(null)
    setPlayers(progress.players)
    setPlayerNames(progress.players.map((player) => player.name))
    setPlayerCount(2)
    setTeamMode(false)
    setGameMode('501')
    setBestOfLegs(match.bestOfLegs)
    setCourtNumber(match.inProgress.courtNumber)
    setUseCoinToss(false)
    setActivePlayer(progress.activePlayer)
    setLegsWon(progress.legsWon)
    setMatchWinnerId(progress.matchWinnerId)
    setLegStarterIndex(progress.legStarterIndex)
    setGamePhase(progress.gamePhase)
    setCoinStarterIndex(progress.coinStarterIndex)
    setCoinResult(null)
    setBullWinnerId(progress.bullWinnerId)
    setWinnerId(progress.winnerId)
    setHistory(progress.previousState ? [progress.previousState] : [])
    setDarts(['', '', ''])
    setManualTotal('')
    setManualDartsThrown(3)
    setManualLastDartDouble(false)
    setManualBust(false)
    setMessage('Kampen er gjenopptatt fra sist lagrede stilling.')
    setTournamentMatchMessage('Kampen lagres automatisk mens dere spiller.')
    setDatabaseMessage('')
    setEmailReportMessage('')
    setReopenedMatchId(null)
    setAppSection('scoreboard')
  }

  async function startTournamentMatch(match: TournamentMatch, tournamentOverride?: ClubTournament) {
    const tournament = tournamentOverride ?? selectedTournament
    if (!isClubAdmin || !tournament || !match.playerTwoSignupId || match.winnerSignupId !== null || activeTournamentMatch) return
    if (match.inProgress) {
      restoreTournamentMatch(match)
      return
    }
    if (tournament.matches.some((item) => item.inProgress && !item.inProgress.courtNumber)) {
      const errorMessage = 'Tildel bane til alle pågående kamper før du starter en ny kamp.'
      showTournamentError(errorMessage)
      if (tournamentOverride) setTournamentMatchMessage(errorMessage)
      return
    }
    const occupiedCourts = new Set(tournament.matches.flatMap((item) => item.inProgress?.courtNumber ? [item.inProgress.courtNumber] : []))
    const availableCourts = ([1, 2, 3, 4, 5] as const).filter((court) => !occupiedCourts.has(court))
    const assignedCourt = availableCourts.includes(courtNumber) ? courtNumber : availableCourts[0]
    if (!assignedCourt) {
      const errorMessage = 'Alle fem banene er i bruk. Vent til en kamp er ferdig.'
      showTournamentError(errorMessage)
      if (tournamentOverride) setTournamentMatchMessage(errorMessage)
      return
    }
    const participantOne = tournament.participants.find((participant) => participant.signupId === match.playerOneSignupId)
    const participantTwo = tournament.participants.find((participant) => participant.signupId === match.playerTwoSignupId)
    if (!participantOne || !participantTwo) {
      const errorMessage = 'Spillerne i denne turneringskampen ble ikke funnet.'
      showTournamentError(errorMessage)
      if (tournamentOverride) setTournamentMatchMessage(errorMessage)
      return
    }
    const playerOneId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-1`
    const playerTwoId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-2`
    const matchPlayers: Player[] = [
      { id: playerOneId, name: participantOne.playerName, score: 501, visits: [] },
      { id: playerTwoId, name: participantTwo.playerName, score: 501, visits: [] },
    ]
    const activeMatch = {
      eventDate: tournament.eventDate,
      matchId: match.id,
      playerOneId,
      playerTwoId,
      progressId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    }
    const initialProgress: TournamentMatchProgress = {
      progressId: activeMatch.progressId,
      courtNumber: assignedCourt,
      refereeSignupId: getTournamentMatchRefereeSignupId(tournament, match) ?? undefined,
      players: matchPlayers,
      activePlayer: 0,
      legsWon: { [playerOneId]: 0, [playerTwoId]: 0 },
      winnerId: null,
      matchWinnerId: null,
      legStarterIndex: 0,
      gamePhase: 'bull-off',
      coinStarterIndex: 0,
      bullWinnerId: '',
      previousState: null,
    }
    setTournamentBusy(true)
    setTournamentMessage('')
    setTournamentMessageIsError(false)
    try {
      await persistTournamentMatchProgress(activeMatch, initialProgress)
    } catch (error) {
      const errorMessage = `Kampen kunne ikke startes fordi stillingen ikke ble lagret: ${tournamentErrorMessage(error, 'Ukjent lagringsfeil.')}`
      showTournamentError(errorMessage)
      if (tournamentOverride) setTournamentMatchMessage(errorMessage)
      return
    } finally {
      setTournamentBusy(false)
    }
    setActiveTournamentMatch({
      eventDate: tournament.eventDate,
      matchId: match.id,
      playerOneId,
      playerTwoId,
      progressId: activeMatch.progressId,
    })
    setSavedTournamentResultDate(null)
    setTournamentDate(tournament.eventDate)
    setTournamentMatchMessage('')
    setPlayers(matchPlayers)
    setPlayerNames(matchPlayers.map((player) => player.name))
    setPlayerCount(2)
    setTeamMode(false)
    setGameMode('501')
    setBestOfLegs(match.bestOfLegs)
    setCourtNumber(assignedCourt)
    setUseCoinToss(false)
    setActivePlayer(0)
    setLegsWon({ [playerOneId]: 0, [playerTwoId]: 0 })
    setMatchWinnerId(null)
    setLegStarterIndex(0)
    setGamePhase('bull-off')
    setCoinStarterIndex(0)
    setCoinResult(null)
    setBullWinnerId('')
    setWinnerId(null)
    setHistory([])
    setDarts(['', '', ''])
    setManualTotal('')
    setManualLastDartDouble(false)
    setManualBust(false)
    setMessage('')
    setDatabaseMessage('')
    setEmailReportMessage('')
    setReopenedMatchId(null)
    setAppSection('scoreboard')
    void savePlayers(matchPlayers.map((player) => player.name)).then(() => loadSavedData()).then(setSavedData).catch(() => {
      setDatabaseMessage('Turneringskampen startet, men spillerne kunne ikke lagres i spillerlisten.')
    })
  }

  function goToNextTournamentMatch() {
    if (!savedTournament) {
      setAppSection('tournament')
      return
    }
    setTournamentDate(savedTournament.eventDate)
    if (savedTournamentNextMatch) {
      setTournamentMatchMessage('Klargjør neste turneringskamp …')
      void startTournamentMatch(savedTournamentNextMatch, savedTournament)
      return
    }
    setAppSection('tournament')
  }

  function retryTournamentMatchSave() {
    if (activeTournamentMatch && matchWinnerId) {
      void saveFinishedTournamentMatch(activeTournamentMatch, legsWon, players)
    }
  }

  function retryTournamentProgressSave() {
    if (activeTournamentMatch && !matchWinnerId) {
      setTournamentMatchMessage('Lagrer kampstillingen på nytt …')
      persistCurrentTournamentProgress()
    }
  }

  async function drawTournamentPools() {
    if (!isClubAdmin || currentTournamentSignups.length < 2) return
    const seedRanks = new Map<string, number>()
    for (const [signupId, rawRank] of Object.entries(tournamentSeedRanks)) {
      if (!rawRank) continue
      const seedRank = Number(rawRank)
      if (!Number.isInteger(seedRank) || seedRank < 1 || seedRank > currentTournamentSignups.length) {
        showTournamentError('Seedingsnummeret må være mellom 1 og antall påmeldte.')
        return
      }
      seedRanks.set(signupId, seedRank)
    }
    try {
      const tournament = drawClubPools(tournamentDate, currentTournamentSignups, seedRanks)
      await persistTournament(tournament, 'Puljene og kampoppsettet er trukket.')
    } catch (error) {
      showTournamentError(error instanceof Error ? error.message : 'Puljene kunne ikke trekkes.')
    }
  }

  function toggleTournamentAdvancement(signupId: string, advances: boolean) {
    setClubTournaments((current) => current.map((tournament) => tournament.eventDate !== tournamentDate ? tournament : {
      ...tournament,
      participants: tournament.participants.map((participant) => participant.signupId === signupId
        ? { ...participant, advances }
        : participant),
    }))
  }

  function updateTournamentReadiness(signupId: string, availability: 'not-arrived' | 'ready' | 'pause') {
    if (!isClubAdmin || !selectedTournament || tournamentBusy) return
    if (selectedTournament.matches.some((match) => match.inProgress
      && (match.playerOneSignupId === signupId || match.playerTwoSignupId === signupId))) return
    const selectedParticipant = selectedTournament.participants.find((participant) => participant.signupId === signupId)
    if (!selectedParticipant || (selectedParticipant.availability ?? 'ready') === availability) return
    const statusMessage = availability === 'ready'
      ? 'Spilleren er meldt inn og markert klar.'
      : availability === 'pause' ? 'Spilleren er satt på pause.' : 'Spilleren er markert som ikke møtt.'
    setTournamentBusy(true)
    setTournamentMessage('')
    setTournamentMessageIsError(false)
    void updateTournamentParticipantAvailability(selectedTournament.eventDate, signupId, availability)
      .then((updatedTournament) => {
        const updatedTournaments = [...clubTournamentsRef.current.filter((item) => item.eventDate !== updatedTournament.eventDate), updatedTournament]
          .sort((first, second) => first.eventDate.localeCompare(second.eventDate))
        clubTournamentsRef.current = updatedTournaments
        setClubTournaments(updatedTournaments)
        setTournamentMessage(statusMessage)
      })
      .catch((error: unknown) => {
        showTournamentError(error instanceof Error ? error.message : 'Spillerstatusen kunne ikke lagres.')
      })
      .finally(() => setTournamentBusy(false))
  }

  async function createTournamentCup() {
    if (!isClubAdmin || !selectedTournament) return
    try {
      const advancingIds = new Set(selectedTournament.participants.filter((participant) => participant.advances).map((participant) => participant.signupId))
      await persistTournament(setTournamentAdvancement(selectedTournament, advancingIds), 'Cup-oppsettet er laget.')
    } catch (error) {
      showTournamentError(error instanceof Error ? error.message : 'Cup-oppsettet kunne ikke lages.')
    }
  }

  // Med inntil 16 spillere går alle automatisk videre fra pulje til cup.
  useEffect(() => {
    if (!isClubAdmin || !selectedTournament || tournamentBusy) return
    const poolMatches = selectedTournament.matches.filter((match) => match.phase === 'pool')
    if (selectedTournament.cupRound > 0
      || poolMatches.length === 0
      || poolMatches.some((match) => !match.winnerSignupId)
      || selectedTournament.participants.length > 16
      || autoCupAttemptedRef.current === selectedTournament.eventDate) return
    autoCupAttemptedRef.current = selectedTournament.eventDate
    const allIds = new Set(selectedTournament.participants.map((participant) => participant.signupId))
    void persistTournament(setTournamentAdvancement(selectedTournament, allIds), 'Alle spillere er automatisk videre til cup.')
  }, [isClubAdmin, selectedTournament, tournamentBusy])

  function applyCheckoutSuggestion() {
    if (!currentPlayer || !checkoutHint) return
    if (entryMode === 'total') {
      setManualTotal(String(currentPlayer.score))
      setManualLastDartDouble(true)
      setManualBust(false)
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

  if (supabase && ((!session && !guestName) || authMode === 'update-password')) {
    const isPasswordReset = authMode === 'reset'
    const isPasswordUpdate = authMode === 'update-password'
    return <main className="app-shell auth-shell">
      <header className="topbar"><span className="brand"><img className="brand-logo" src="/logo.png" alt="" /><span>STEINKJER <span className="brand-dot">DART-X</span></span></span><div className="topbar-meta">FELLES KLUBBTAVLE</div></header>
      <section className="auth-layout">
        <div className="auth-copy"><p className="eyebrow">STEINKJER DART-X / KLUBB</p><h1>501<span className="title-period">.</span></h1><p className="intro">{isPasswordUpdate ? 'Velg et nytt passord for å få tilgang til klubbens poengtavle.' : isPasswordReset ? 'Skriv inn e-postadressen til kontoen din, så sender vi deg en tilbakestillingslenke.' : 'Logg inn for å se spillerlisten og kampene til klubben.'}</p></div>
        <form className="auth-panel" onSubmit={submitAuth}>
          <p className="eyebrow">{authMode === 'signup' ? 'NY BRUKER' : isPasswordReset || isPasswordUpdate ? 'GJENOPPRETT TILGANG' : 'KLUBBTILGANG'}</p>
          <h2>{authMode === 'signup' ? 'Opprett konto' : isPasswordReset ? 'Glemt passord' : isPasswordUpdate ? 'Nytt passord' : 'Logg inn'}</h2>
          {authMode === 'signup' && <label className="auth-field"><span>VISNINGSNAVN</span><input type="text" autoComplete="nickname" maxLength={24} required value={authDisplayName} onChange={(event) => setAuthDisplayName(event.target.value)} placeholder="Navnet ditt i spillerlisten" /><small>Vises for andre på spillerlisten.</small></label>}
          {!isPasswordUpdate && <label className="auth-field"><span>E-POSTADRESSE</span><input type="email" autoComplete="email" required value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="navn@eksempel.no" /></label>}
          {!isPasswordReset && <label className="auth-field"><span>{isPasswordUpdate ? 'NYTT PASSORD' : 'PASSORD'}</span><input type="password" autoComplete={authMode === 'signup' || isPasswordUpdate ? 'new-password' : 'current-password'} minLength={6} required value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="Minst 6 tegn" /></label>}
          {authMessage && <p className="auth-message" role="status">{authMessage}</p>}
          <button className="primary-button auth-submit" type="submit" disabled={authBusy}>{authBusy ? 'VENT LITT …' : authMode === 'signup' ? 'Opprett konto' : isPasswordReset ? 'Send tilbakestillingslenke' : isPasswordUpdate ? 'Lagre nytt passord' : 'Logg inn'}</button>
          {authMode === 'login' && <><button className="auth-mode-toggle" type="button" onClick={() => { setAuthMode('reset'); setAuthMessage('') }}>Glemt passord?</button><button className="auth-mode-toggle" type="button" onClick={() => { setAuthMode('signup'); setAuthMessage('') }}>Ny bruker? Opprett konto</button></>}
          {authMode === 'login' && <div className="guest-entry"><p>ELLER SPILL UTEN KONTO</p><label className="auth-field"><span>VISNINGSNAVN</span><input type="text" autoComplete="nickname" maxLength={24} value={guestNameInput} onChange={(event) => setGuestNameInput(event.target.value)} placeholder="Skriv inn et navn" /></label><button className="primary-button auth-submit" type="button" disabled={!guestNameInput.trim() || authBusy} onClick={startGuest}>Fortsett som gjest</button><small>Gjestespill lagres bare i denne fanen og slettes når du avslutter økten eller lukker fanen.</small></div>}
          {authMode === 'signup' && <button className="auth-mode-toggle" type="button" onClick={() => { setAuthMode('login'); setAuthMessage('') }}>Har du allerede konto? Logg inn</button>}
          {authMode === 'reset' && <button className="auth-mode-toggle" type="button" onClick={() => { setAuthMode('login'); setAuthMessage('') }}>Tilbake til innlogging</button>}
        </form>
      </section>
    </main>
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Steinkjer DART-X, tilbake til start" onClick={(event) => { event.preventDefault(); setAppSection('scoreboard'); newGame() }}>
          <img className="brand-logo" src="/logo.png" alt="" />
          <span>STEINKJER <span className="brand-dot">DART-X</span></span>
        </a>
        <nav className="topbar-nav" aria-label="Hovedmeny">
          <div className="topbar-nav-group" aria-label="Klubb">
            <button className="topbar-nav-link" type="button" aria-current={appSection === 'players' ? 'page' : undefined} onClick={() => setAppSection(appSection === 'players' ? 'scoreboard' : 'players')}>Spillere</button>
            {(!guestName || session) && <button className="topbar-nav-link" type="button" aria-current={appSection === 'club-evenings' ? 'page' : undefined} onClick={() => setAppSection(appSection === 'club-evenings' ? 'scoreboard' : 'club-evenings')}>{appSection === 'club-evenings' ? 'Poengtavle' : 'Påmelding'}</button>}
          </div>
          {session && <div className="topbar-nav-group" aria-label="Konto og turnering">
            <button className="topbar-nav-link" type="button" aria-current={appSection === 'profile' ? 'page' : undefined} onClick={() => setAppSection(appSection === 'profile' ? 'scoreboard' : 'profile')}>Min statistikk</button>
            <button className="topbar-nav-link" type="button" aria-current={appSection === 'tournament' ? 'page' : undefined} onClick={() => setAppSection(appSection === 'tournament' ? 'scoreboard' : 'tournament')}>Turnering</button>
            {isClubAdmin && <button className="topbar-nav-link" type="button" aria-current={appSection === 'admin' ? 'page' : undefined} onClick={() => setAppSection(appSection === 'admin' ? 'scoreboard' : 'admin')}>Administrasjon</button>}
          </div>}
        </nav>
        <div className="topbar-actions">
          <div className="topbar-meta">{isOnline ? <span className="live-dot" /> : <span className="offline-dot" />} {isOnline ? gameMode === 'cricket' ? 'CRICKET' : `${gameMode} / DOBBEL UT` : 'OFFLINE'} <span className="court-indicator">BANE {courtNumber}</span>{(guestName || !supabase) && <span className="local-mode-tag">{guestName ? `GJEST: ${guestName}` : 'LOKAL MODUS'}</span>}</div>
          {session && <button className="sign-out-button" type="button" onClick={signOut}>Logg ut</button>}
          {guestName && <button className="sign-out-button" type="button" onClick={exitGuest}>Avslutt gjesteøkt</button>}
        </div>
      </header>
      {databaseMessage && <div className="database-message" role="status"><span>{databaseMessage}</span><button type="button" aria-label="Skjul varsel" onClick={() => setDatabaseMessage('')}>Lukk</button></div>}

      {appSection === 'players' ? (
        <section className="player-directory-page">
          <div className="club-evenings-heading">
            <p className="eyebrow">STEINKJER DART-X / SPILLERLISTE</p>
            <h1>Spillere<span className="title-period">.</span></h1>
            <p className="intro">Kontoer vises med visningsnavn. Velg en spiller her eller i spillerfeltene når du setter opp en kamp.</p>
          </div>
          <section className="player-directory-card" aria-label="Registrerte spillere">
            <div className="admin-section-heading"><div><p className="eyebrow">KONTOER</p><h2>Registrerte brukere</h2></div><span className="player-library-count">{registeredPlayerNames.length}</span></div>
            {playerDirectoryMessage && <p className="auth-message" role="alert">{playerDirectoryMessage}</p>}
            {registeredPlayerNames.length > 0 ? <ul className="player-directory-list">{registeredPlayerNames.map((name) => <li key={name}><span>{name}</span><span className="player-directory-tag">KONTO</span></li>)}</ul> : <p className="player-library-empty">{supabase ? 'Ingen bekreftede kontoer i spillerlisten ennå.' : 'Kontoer krever Supabase-oppsett.'}</p>}
            {guestName && <div className="player-directory-guest"><p className="eyebrow">GJEST I DENNE FANEN</p><p>{guestName} <span className="player-directory-tag">GJEST</span></p><small>Gjestens navn er midlertidig og vises ikke for andre.</small></div>}
            {additionalSavedPlayers.length > 0 && <div className="player-directory-guest"><p className="eyebrow">SPILLERE FRA KAMPER</p><ul className="player-directory-list">{additionalSavedPlayers.map((player) => <li key={player.id}><span>{player.name}</span><span className="player-directory-tag">SPILLER</span></li>)}</ul></div>}
          </section>
        </section>
      ) : appSection === 'admin' && session && isClubAdmin ? (
        <section className="admin-page">
          <div className="club-evenings-heading">
            <p className="eyebrow">STEINKJER DART-X / ADMINISTRASJON</p>
            <h1>Påmeldinger<span className="title-period">.</span></h1>
            <p className="intro">Samlet oversikt over klubbkveldene. Rett navn eller dato, fjern feilpåmeldinger og last ned deltakerlisten.</p>
          </div>
          <section className="admin-panel">
            <div className="admin-section-heading">
              <div><p className="eyebrow">KOMMENDE KLUBBKVELDER</p><h2>Deltakerlister</h2></div>
              <label className="admin-export-select"><span>LAST NED</span><select value={adminExportDate} onChange={(event) => setAdminExportDate(event.target.value)}><option value="all">Alle kommende kvelder</option>{adminEventDates.map((date) => <option key={date} value={date}>{formatClubDate(date)}</option>)}</select></label>
              <button className="primary-button admin-export-button" type="button" disabled={adminExportSignups.length === 0} onClick={() => downloadClubSignupCsv(adminExportSignups, adminExportDate === 'all' ? 'alle' : adminExportDate)}>Last ned CSV</button>
            </div>
            <form className="admin-guest-signup-form" onSubmit={(event) => { event.preventDefault(); void addAdminGuestClubSignup() }}>
              <div><p className="eyebrow">MANUELL PÅMELDING</p><p>Legg til en spiller som ikke har registrert konto.</p></div>
              <label><span>KLUBBKVELD</span><select required value={adminGuestSignupDate} onChange={(event) => setAdminGuestSignupDate(event.target.value)}>{adminEventDates.map((date) => <option key={date} value={date}>{formatClubDate(date)}</option>)}</select></label>
              <label><span>SPILLERNAVN</span><input autoComplete="off" maxLength={24} required value={adminGuestSignupName} onChange={(event) => setAdminGuestSignupName(event.target.value)} placeholder="Skriv inn navn" /></label>
              <button className="primary-button" type="submit" disabled={adminSignupsBusy || !adminGuestSignupName.trim() || !adminGuestSignupDate}>{adminSignupsBusy ? 'MELDER PÅ …' : 'Legg til påmelding'}</button>
            </form>
            {adminMessage && <p className="admin-message" role="status">{adminMessage}</p>}
            {adminEventDates.length === 0 ? <p className="admin-empty">Ingen kommende klubbkvelder.</p> : adminEventDates.map((date) => {
              const attendees = adminUpcomingSignups.filter((signup) => signup.eventDate === date)
              return <section className="admin-event" key={date}>
                <h3>{formatClubDate(date)} <span>{attendees.length} {attendees.length === 1 ? 'påmeldt' : 'påmeldte'}</span></h3>
                {attendees.length > 0 ? <ul className="admin-signup-list">{attendees.map((signup) => {
                  const isEditing = adminEditingSignupId === signup.id
                  const isConfirmingDelete = adminPendingDeleteId === signup.id
                  return <li key={signup.id}>
                    {isEditing ? <form className="admin-signup-edit" onSubmit={(event) => { event.preventDefault(); void saveAdminSignup(signup.id) }}>
                      <label><span>DATO</span><select required value={adminEditDate} onChange={(event) => setAdminEditDate(event.target.value)}>{adminEventDates.map((eventDate) => <option key={eventDate} value={eventDate}>{formatClubDate(eventDate)}</option>)}</select></label>
                      <label><span>NAVN</span><input autoFocus required maxLength={24} value={adminEditName} onChange={(event) => setAdminEditName(event.target.value)} /></label>
                      <div className="admin-signup-actions"><button className="primary-button" type="submit" disabled={adminSignupsBusy}>{adminSignupsBusy ? 'LAGRER …' : 'Lagre'}</button><button type="button" disabled={adminSignupsBusy} onClick={() => setAdminEditingSignupId(null)}>Avbryt</button></div>
                    </form> : <>
                      <span className="admin-signup-name">{signup.playerName}{!signup.signedUpBy && <small className="admin-guest-signup-tag">MANUELT PÅMELDT</small>}</span>
                      {isConfirmingDelete ? <div className="admin-signup-actions"><span>Fjerne påmeldingen?</span><button className="admin-delete-confirm" type="button" disabled={adminSignupsBusy} onClick={() => void removeAdminSignup(signup.id)}>Ja, slett</button><button type="button" disabled={adminSignupsBusy} onClick={() => setAdminPendingDeleteId(null)}>Avbryt</button></div> : <div className="admin-signup-actions"><button type="button" disabled={adminSignupsBusy} onClick={() => { setAdminEditingSignupId(signup.id); setAdminPendingDeleteId(null); setAdminEditDate(signup.eventDate); setAdminEditName(signup.playerName) }}>Rediger</button><button className="admin-delete-button" type="button" disabled={adminSignupsBusy} onClick={() => { setAdminPendingDeleteId(signup.id); setAdminEditingSignupId(null) }}>Slett</button></div>}
                    </>}
                  </li>
                })}</ul> : <p className="admin-empty">Ingen er påmeldt ennå. Legg til en gjest ovenfor ved behov.</p>}
              </section>
            })}
          </section>
          <section className="admin-panel admin-players-panel">
            <div><p className="eyebrow">SPILLERLISTE</p><h2>Legg til spiller manuelt</h2><p>Legg inn spillere som ikke har registrert en konto. De blir tilgjengelige i spillerlisten når kamper settes opp.</p></div>
            <form className="admin-role-form" onSubmit={(event) => { event.preventDefault(); void addAdminPlayer() }}>
              <label><span>SPILLERNAVN</span><input autoComplete="off" maxLength={24} required value={adminNewPlayerName} onChange={(event) => { setAdminNewPlayerName(event.target.value); setAdminPlayersMessage('') }} placeholder="Skriv inn spillernavn" /></label>
              <button className="primary-button" type="submit" disabled={adminPlayersBusy || !adminNewPlayerName.trim()}>{adminPlayersBusy ? 'LAGRER …' : 'Legg til spiller'}</button>
            </form>
            {adminPlayersMessage && <p className={`admin-message${adminPlayersMessageIsError ? ' is-error' : ''}`} role={adminPlayersMessageIsError ? 'alert' : 'status'}>{adminPlayersMessage}</p>}
          </section>
          <section className="admin-panel admin-documents-panel">
            <div className="admin-section-heading">
              <div><p className="eyebrow">FILER</p><h2>Dokumenter</h2></div>
              <label className={`primary-button admin-document-upload${adminDocumentsBusy ? ' is-disabled' : ''}`}>
                {adminDocumentsBusy ? 'LASTER OPP …' : 'Last opp dokumenter'}
                <input
                  type="file"
                  multiple
                  disabled={adminDocumentsBusy || adminDocumentsLoading}
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files ?? [])
                    event.currentTarget.value = ''
                    void uploadAdminDocuments(files)
                  }}
                />
              </label>
            </div>
            <p className="admin-document-note">Privat lagring for administratorer. Maks 25 MB per fil.</p>
            {adminDocumentsMessage && <p className={`admin-message${adminDocumentsMessageIsError ? ' is-error' : ''}`} role={adminDocumentsMessageIsError ? 'alert' : 'status'}>{adminDocumentsMessage}</p>}
            {adminDocumentsLoading ? <p className="admin-empty">Henter dokumenter …</p>
              : adminDocuments.length === 0 ? <p className="admin-empty">Ingen dokumenter lastet opp ennå.</p>
                : <ul className="admin-document-list">{adminDocuments.map((document) => {
                  const isConfirmingDelete = adminDocumentPendingDelete === document.path
                  const isBusy = adminDocumentAction === document.path
                  const createdAt = document.createdAt ? new Date(document.createdAt).toLocaleDateString('nb-NO') : null
                  return <li key={document.path}>
                    <div className="admin-document-details">
                      <span className="admin-document-name">{document.name}</span>
                      <span>{formatDocumentSize(document.size)}{createdAt ? ` · ${createdAt}` : ''}</span>
                    </div>
                    {isConfirmingDelete
                      ? <div className="admin-signup-actions"><span>Slette dokumentet?</span><button className="admin-delete-confirm" type="button" disabled={isBusy} onClick={() => void removeAdminDocument(document)}>Ja, slett</button><button type="button" disabled={isBusy} onClick={() => setAdminDocumentPendingDelete(null)}>Avbryt</button></div>
                      : <div className="admin-signup-actions"><button type="button" disabled={isBusy} onClick={() => void downloadAdminDocument(document)}>{isBusy ? 'VENT …' : 'Last ned'}</button><button className="admin-delete-button" type="button" disabled={isBusy} onClick={() => setAdminDocumentPendingDelete(document.path)}>Slett</button></div>}
                  </li>
                })}</ul>}
          </section>
          <TournamentBoard
            tournament={selectedTournament}
            eventDate={tournamentDate}
            eventDates={tournamentEventDates}
            archivedTournaments={clubTournaments}
            signups={currentTournamentSignups}
            seedRanks={tournamentSeedRanks}
            busy={tournamentBusy}
            canPlayMatch={(players.length === 0 || matchWinnerId !== null) && !activeTournamentMatch && (selectedTournament?.matches.filter((match) => match.inProgress).length ?? 0) < 5}
            canResumeMatch={(players.length === 0 || matchWinnerId !== null) && !activeTournamentMatch}
            onAssignBoard={(match, assignedCourt) => void assignTournamentBoard(match, assignedCourt)}
            isAdmin
            message={tournamentMessage}
            messageIsError={tournamentMessageIsError}
            pendingDeleteDate={pendingTournamentDeleteDate}
            confirmDeleteAll={confirmDeleteAllTournaments}
            deleting={tournamentDeleting}
            activeTournamentDate={activeTournamentMatch?.eventDate ?? null}
            onDeleteTournament={removeTournament}
            onRequestDeleteTournament={requestTournamentDelete}
            onConfirmDeleteAll={() => { setConfirmDeleteAllTournaments(true); setPendingTournamentDeleteDate(null); setTournamentMessage(''); setTournamentMessageIsError(false) }}
            onCancelDelete={() => { setPendingTournamentDeleteDate(null); setConfirmDeleteAllTournaments(false) }}
            onDeleteAll={removeAllTournaments}
            onEventDateChange={(date) => { setTournamentDate(date); setTournamentMessage(''); setTournamentMessageIsError(false); setTournamentSeedRanks({}); setPendingTournamentDeleteDate(null); setConfirmDeleteAllTournaments(false) }}
            onSeedChange={(signupId, rank) => setTournamentSeedRanks((current) => ({ ...current, [signupId]: rank }))}
            onDraw={() => void drawTournamentPools()}
            onPlayMatch={startTournamentMatch}
            onReadinessChange={updateTournamentReadiness}
            onToggleAdvancement={toggleTournamentAdvancement}
            onCreateCup={() => void createTournamentCup()}
          />
          <section className="admin-panel admin-roles-panel">
            <div><p className="eyebrow">TILGANG</p><h2>Administratorer</h2><p>Legg til eller fjern administratorer. Personen må allerede ha opprettet konto med denne e-postadressen.</p></div>
            <form className="admin-role-form" onSubmit={(event) => { event.preventDefault(); void changeClubAdminRole(adminEmail, true) }}>
              <label><span>E-POSTADRESSE</span><input type="email" autoComplete="email" required maxLength={320} value={adminEmail} onChange={(event) => setAdminEmail(event.target.value)} placeholder="navn@eksempel.no" /></label>
              <button className="primary-button" type="submit" disabled={adminRoleBusy || !adminEmail.trim()}>{adminRoleBusy ? 'LAGRER …' : 'Gi administratorrolle'}</button>
            </form>
            <ul className="admin-list">{clubAdmins.map((admin) => <li key={admin.email}><span>{admin.email}</span><button className="admin-delete-button" type="button" disabled={adminRoleBusy || admin.email.toLocaleLowerCase() === session.user.email?.toLocaleLowerCase()} onClick={() => void changeClubAdminRole(admin.email, false)}>{admin.email.toLocaleLowerCase() === session.user.email?.toLocaleLowerCase() ? 'Du' : 'Fjern rolle'}</button></li>)}</ul>
            <p className="admin-role-note">Din egen administratorrolle kan ikke fjernes her. Sørg for å beholde minst én aktiv administrator.</p>
          </section>
        </section>
      ) : appSection === 'tournament' && session ? (
        <section className="admin-page">
          <div className="club-evenings-heading">
            <p className="eyebrow">STEINKJER DART-X / KLUBB</p>
            <h1>Turnering<span className="title-period">.</span></h1>
            <p className="intro">Se puljene, kampene og cup-oppsettet for klubbkvelden.</p>
          </div>
          <TournamentBoard
            tournament={selectedTournament}
            eventDate={tournamentDate}
            eventDates={tournamentEventDates}
            archivedTournaments={clubTournaments}
            signups={currentTournamentSignups}
            seedRanks={tournamentSeedRanks}
            busy={tournamentBusy}
            canPlayMatch={(players.length === 0 || matchWinnerId !== null) && !activeTournamentMatch && (selectedTournament?.matches.filter((match) => match.inProgress).length ?? 0) < 5}
            canResumeMatch={(players.length === 0 || matchWinnerId !== null) && !activeTournamentMatch}
            onAssignBoard={(match, assignedCourt) => void assignTournamentBoard(match, assignedCourt)}
            isAdmin={isClubAdmin}
            message={tournamentMessage}
            messageIsError={tournamentMessageIsError}
            pendingDeleteDate={pendingTournamentDeleteDate}
            confirmDeleteAll={confirmDeleteAllTournaments}
            deleting={tournamentDeleting}
            activeTournamentDate={activeTournamentMatch?.eventDate ?? null}
            onDeleteTournament={removeTournament}
            onRequestDeleteTournament={requestTournamentDelete}
            onConfirmDeleteAll={() => { setConfirmDeleteAllTournaments(true); setPendingTournamentDeleteDate(null); setTournamentMessage(''); setTournamentMessageIsError(false) }}
            onCancelDelete={() => { setPendingTournamentDeleteDate(null); setConfirmDeleteAllTournaments(false) }}
            onDeleteAll={removeAllTournaments}
            onEventDateChange={(date) => { setTournamentDate(date); setTournamentMessage(''); setTournamentMessageIsError(false); setTournamentSeedRanks({}); setPendingTournamentDeleteDate(null); setConfirmDeleteAllTournaments(false) }}
            onSeedChange={(signupId, rank) => setTournamentSeedRanks((current) => ({ ...current, [signupId]: rank }))}
            onDraw={() => void drawTournamentPools()}
            onPlayMatch={startTournamentMatch}
            onReadinessChange={updateTournamentReadiness}
            onToggleAdvancement={toggleTournamentAdvancement}
            onCreateCup={() => void createTournamentCup()}
          />
        </section>
      ) : appSection === 'profile' && session ? (
        <section className="player-profile-page">
          <div className="club-evenings-heading">
            <p className="eyebrow">STEINKJER DART-X / SPILLERPROFIL</p>
            <h1>Min statistikk<span className="title-period">.</span></h1>
            <p className="intro">Samlet oversikt over kampene og kastene dine.</p>
          </div>
          <section className="player-profile-card">
            <p className="eyebrow">KNYTT INNLOGGING TIL SPILLER</p>
            <div className="profile-identity">
              {profileAvatarUrl
                ? <img className="profile-avatar" src={profileAvatarUrl} alt={`Profilbilde for ${linkedPlayer?.name ?? 'din profil'}`} />
                : <div className="profile-avatar profile-avatar-placeholder" aria-hidden="true">{linkedPlayer?.name.slice(0, 1).toLocaleUpperCase('nb-NO') ?? '?'}</div>}
              <h2>{linkedPlayer?.name ?? 'Velg spillerprofil'}</h2>
            </div>
            <p className="profile-account-label">{session.user.email}</p>
            {profileLoading ? <p role="status">Henter spillerprofil …</p> : <>
              <label className="club-signup-field"><span>SPILLERNAVN</span><select value={profilePlayerId} onChange={(event) => { setProfilePlayerId(event.target.value); setProfileMessage('') }}><option value="">Velg navnet ditt</option>{profilePlayers.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}</select></label>
              <button className="primary-button profile-save-button" type="button" disabled={!profilePlayerId || profileSaving || (Boolean(supabase) && !isOnline)} onClick={() => {
                if (!session || !profilePlayerId) return
                setProfileSaving(true)
                setProfileMessage('')
                void saveLinkedPlayerId(session.user.id, profilePlayerId).then(() => {
                  setLinkedPlayerId(profilePlayerId)
                  setProfileMessage('Spillerprofilen er lagret.')
                }).catch((error: unknown) => {
                  setProfileMessage(error instanceof Error ? error.message : 'Spillerprofilen kunne ikke lagres.')
                }).finally(() => setProfileSaving(false))
              }}>{profileSaving ? 'LAGRER …' : linkedPlayerId ? 'Lagre spillerprofil' : 'Knytt til spillerprofil'}<span aria-hidden="true">↗</span></button>
              <label className={`profile-avatar-upload${!linkedPlayerId || profileAvatarBusy || !isOnline ? ' is-disabled' : ''}`}>
                <span>{profileAvatarBusy ? 'LASTER OPP …' : profileAvatarUrl ? 'Bytt profilbilde' : 'Last opp profilbilde'}</span>
                <input type="file" accept="image/jpeg,image/png,image/webp" disabled={!linkedPlayerId || profileAvatarBusy || !isOnline} onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (!file || !session) return
                  setProfileAvatarBusy(true)
                  setProfileMessage('')
                  void uploadProfileAvatar(session.user.id, file).then((avatarUrl) => {
                    setProfileAvatarUrl(avatarUrl)
                    setProfileMessage('Profilbildet er lastet opp.')
                  }).catch((error: unknown) => {
                    setProfileMessage(error instanceof Error ? error.message : 'Profilbildet kunne ikke lastes opp.')
                  }).finally(() => setProfileAvatarBusy(false))
                }} />
              </label>
              <p className="profile-avatar-note">JPG, PNG eller WebP · maks 2 MB. Bildet er privat for kontoen din.</p>
              {profilePlayers.length === 0 && <p>Det er ingen spillerprofiler i arkivet ennå. Legg til spilleren i spillerlisten eller registrer en kamp først.</p>}
              {profileMessage && <p className="profile-message" role="status">{profileMessage}</p>}
              {supabase && !isOnline && <p className="profile-message">Du må være på nett for å lagre profilkoblingen eller laste opp bilde.</p>}
            </>}
            {careerStats && linkedPlayer && <div className="career-stats" aria-label={`Samlet statistikk for ${linkedPlayer.name}`}>
              <div><strong>{careerStats.matches}</strong><span>KAMPER</span></div>
              <div><strong>{careerStats.wins}</strong><span>SEIERE</span></div>
              <div><strong>{careerStats.average3.toFixed(1)}</strong><span>3-PILSSNITT</span></div>
              <div><strong>{careerStats.tons}</strong><span>100+</span></div>
              <div><strong>{careerStats.oneEighties}</strong><span>180-ERE</span></div>
              <div><strong>{careerStats.highestVisit}</strong><span>HØYESTE TUR</span></div>
              <p>{careerStats.dartsThrown} piler registrert i kamparkivet.</p>
            </div>}
          </section>
        </section>
      ) : appSection === 'club-evenings' ? (
        <section className="club-evenings-page">
          <div className="club-evenings-heading">
            <p className="eyebrow">STEINKJER DART-X / KLUBB</p>
            <h1>Påmelding<span className="title-period">.</span></h1>
            <p className="intro">Meld deg på klubbkvelden og se hvem som blir med.</p>
          </div>
          <section className="club-registration-card">
            <p className="eyebrow">MANDAG OG TORSDAG</p>
            <h2>Velg klubbkveld</h2>
            <label className="club-signup-field"><span>DATO</span><select value={clubSignupDate} onChange={(event) => { setClubSignupDate(event.target.value); setClubSignupMessage('') }}>{upcomingClubDates.map((date) => <option key={date} value={date}>{formatClubDate(date)}</option>)}</select></label>
            <form className="club-signup-form" onSubmit={(event) => {
              event.preventDefault()
              setClubSignupBusy(true)
              setClubSignupMessage('')
              void saveClubSignup(clubSignupDate, clubSignupName, session?.user.id).then(() => loadClubSignups()).then((signups) => {
                setClubSignups(signups)
                setClubSignupName('')
                setClubSignupMessage('Du er påmeldt.')
              }).catch((error: unknown) => {
                setClubSignupMessage(error instanceof Error ? error.message : 'Påmeldingen kunne ikke lagres. Prøv igjen.')
              }).finally(() => setClubSignupBusy(false))
            }}>
              <label className="club-signup-field"><span>NAVN</span><input autoComplete="name" maxLength={24} required value={clubSignupName} onChange={(event) => setClubSignupName(event.target.value)} placeholder="Skriv inn navnet ditt" /></label>
              <button className="primary-button club-signup-submit" type="submit" disabled={clubSignupBusy || !clubSignupName.trim() || (Boolean(supabase) && !isOnline)}>{clubSignupBusy ? 'LAGRER …' : currentClubSignup ? 'Oppdater påmelding' : 'Meld meg på'}<span aria-hidden="true">↗</span></button>
            </form>
            {currentClubSignup && <button className="club-cancel-button" type="button" disabled={clubSignupBusy || (Boolean(supabase) && !isOnline)} onClick={() => {
              setClubSignupBusy(true)
              setClubSignupMessage('')
              void deleteClubSignup(currentClubSignup.id).then(() => loadClubSignups()).then(setClubSignups).then(() => {
                setClubSignupMessage('Du er meldt av.')
              }).catch((error: unknown) => {
                setClubSignupMessage(error instanceof Error ? error.message : 'Avmeldingen kunne ikke lagres. Prøv igjen.')
              }).finally(() => setClubSignupBusy(false))
            }}>Meld meg av</button>}
            {clubSignupMessage && <p className="club-signup-message" role="status">{clubSignupMessage}</p>}
            {supabase && !isOnline && <p className="club-signup-message">Du må være på nett for å endre påmeldingen.</p>}
            <div className="club-attendees"><h3>Påmeldte <span>{clubSignups.filter((signup) => signup.eventDate === clubSignupDate).length}</span></h3>
              {clubSignups.some((signup) => signup.eventDate === clubSignupDate)
                ? <ul>{clubSignups.filter((signup) => signup.eventDate === clubSignupDate).map((signup) => <li key={signup.id}>{signup.playerName}{!supabase && <button type="button" aria-label={`Meld ${signup.playerName} av`} disabled={clubSignupBusy} onClick={() => {
                  setClubSignupBusy(true)
                  setClubSignupMessage('')
                  void deleteClubSignup(signup.id).then(() => loadClubSignups()).then(setClubSignups).catch((error: unknown) => {
                    setClubSignupMessage(error instanceof Error ? error.message : 'Avmeldingen kunne ikke lagres. Prøv igjen.')
                  }).finally(() => setClubSignupBusy(false))
                }}>Meld av</button>}</li>)}</ul>
                : <p>Ingen er påmeldt ennå.</p>}
            </div>
            {!supabase && <p className="club-local-note">Påmeldingene lagres bare på denne enheten i lokal modus.</p>}
          </section>
        </section>
      ) : players.length === 0 ? (
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
              <p>{gameMode === 'cricket' ? 'Tre treff lukker 15–20 og bull. Treff på lukkede felt gir poeng så lenge motstanderen har feltet åpent.' : gameMode === '121' ? 'Hver runde starter på 121. Dobbel ut gjelder.' : 'Først til valgt antall legg vinner kampen.'}</p>
            </fieldset>
            <fieldset className="match-format">
              <legend>KAMPFORMAT</legend>
              <div className="format-options">{([3, 5, 7, 9] as const).map((format) => <button key={format} type="button" aria-pressed={bestOfLegs === format} className={bestOfLegs === format ? 'format-option selected' : 'format-option'} onClick={() => setBestOfLegs(format)}>Best av {format}</button>)}</div>
              <p>Først til {Math.ceil(bestOfLegs / 2)} {gameMode === '121' ? Math.ceil(bestOfLegs / 2) === 1 ? 'runde' : roundWordPlural : Math.ceil(bestOfLegs / 2) === 1 ? 'legg' : roundWordPlural} vinner kampen.</p>
            </fieldset>
            <fieldset className="court-select">
              <legend>BANE</legend>
              <div className="count-options court-options">{([1, 2, 3, 4, 5] as const).map((court) => <button key={court} type="button" aria-pressed={courtNumber === court} className={courtNumber === court ? 'count-option selected' : 'count-option'} onClick={() => setCourtNumber(court)}>{court}</button>)}</div>
            </fieldset>
            <div className="name-fields">{names.map((name, index) => (
              <label className="name-field" key={index}>
                <span>{teamMode ? `LAG ${index % 2 === 0 ? 'A' : 'B'} · SPILLER ${Math.floor(index / 2) + 1}` : `SPILLER ${String(index + 1).padStart(2, '0')}`}</span>
                <input list="registered-player-options" autoComplete="off" maxLength={24} placeholder={teamMode ? `Lag ${index % 2 === 0 ? 'A' : 'B'} spiller ${Math.floor(index / 2) + 1}` : `Spiller ${index + 1}`} value={name} onChange={(event) => { cancelCoinFlip(); setPlayerNames((items) => { const next = [...items]; next[index] = event.target.value; return next }); setCoinResult(null); setCoinStarterIndex(null) }} />
              </label>
            ))}</div>
            <datalist id="registered-player-options">{rosterPlayerNames.map((name) => <option key={name} value={name} />)}</datalist>
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
              <label className="manual-double-toggle"><input type="checkbox" checked={useCoinToss} onChange={(event) => { cancelCoinFlip(); setUseCoinToss(event.target.checked); setCoinResult(null); setCoinStarterIndex(null) }} /><span className="custom-check" aria-hidden="true" />Bruk myntkast</label>
              {useCoinToss ? <><p className="coin-choice-label">KAST MYNTEN FOR Å TREKKE FØRSTE KASTER</p>
                <CoinTossButton disabled={false} flipping={coinFlipping} landingSide={coinLandingSide} result={coinResult} onClick={tossCoin} />
                <p role="status">{coinFlipping ? 'Mynten snurrer …' : coinResult === null ? 'Mynten trekker tilfeldig hvem som kaster først mot bull.' : `${coinResult === 'kron' ? 'Kron' : 'Mynt'} kom opp. ${coinStarterIndex === null ? 'Første kaster er trukket.' : names[coinStarterIndex] || `Spiller ${coinStarterIndex + 1}`} kaster først mot bull.`}</p></> : <p role="status">Myntkast er av. {names[0] || 'Spiller 1'} kaster først mot bull.</p>}
            </div>}
            <button className="primary-button start-button" type="submit" disabled={playerCount > 1 && useCoinToss && coinStarterIndex === null}>{playerCount > 1 ? 'Start bullkast' : 'Start kamp'} <span aria-hidden="true">↗</span></button>
            <p className="form-note">{playerCount > 1 ? useCoinToss ? 'Myntkastet bestemmer rekkefølgen for bullkastet. ' : 'Uten myntkast følger rekkefølgen spillerlisten. ' : ''}Spillernavn lagres automatisk.</p>
          </form>
          {savedData.matches.length > 0 && <section className="saved-history" aria-label="Kamphistorikk">
            <div className="saved-history-heading"><div><p className="eyebrow">LAGRET HISTORIKK</p><h2>Kamparkiv</h2></div><span>{filteredSavedMatches.length} / {savedData.matches.length} KAMPER</span></div>
            <div className="history-filters">
              <label className="history-filter-search"><span>SØK SPILLER ELLER LAG</span><input type="search" value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="Navn" /></label>
              <label><span>SPILLTYPE</span><select value={historyGameMode} onChange={(event) => setHistoryGameMode(event.target.value as GameMode | 'all')}><option value="all">Alle</option><option value="501">501</option><option value="cricket">Cricket</option><option value="121">121 utgang</option></select></label>
              <label><span>BANE</span><select value={historyCourt} onChange={(event) => setHistoryCourt(event.target.value === 'all' ? 'all' : Number(event.target.value) as CourtNumber)}><option value="all">Alle</option>{([1, 2, 3, 4, 5] as const).map((court) => <option key={court} value={court}>Bane {court}</option>)}</select></label>
            </div>
            {filteredSavedMatches.length > 0 ? <ul className="saved-history-list">{filteredSavedMatches.map((match) => <li key={match.id}>
              <div className="history-match-main"><time dateTime={match.playedAt}>{new Intl.DateTimeFormat('nb-NO', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(match.playedAt))}</time><strong>{match.winnerName} vant</strong></div>
              <span className="history-match-summary">Bane {match.courtNumber ?? 1} · {match.gameMode === 'cricket' ? 'Cricket' : match.gameMode === '121' ? '121 utgang' : '501'} · {formatSavedMatchPlayers(match)}{match.bestOfLegs ? ` · Best av ${match.bestOfLegs}` : ''}</span>
              <div className="history-match-actions"><button className="history-details-button" type="button" onClick={() => setSelectedMatch(match)}>Vis detaljer</button>{match.finishMethod && <button className="reopen-match-button" type="button" onClick={() => reopenSavedMatch(match)}>Åpne kampen igjen</button>}{matchPendingDeleteId === match.id ? <><span className="history-delete-prompt" role="status">Slette kampen?</span><button className="history-delete-confirm" type="button" onClick={() => void removeSavedMatch(match.id)}>Ja, slett</button><button className="history-delete-cancel" type="button" onClick={() => setMatchPendingDeleteId(null)}>Avbryt</button></> : <button className="history-delete-button" type="button" aria-label={`Slett kamp vunnet av ${match.winnerName}`} onClick={() => setMatchPendingDeleteId(match.id)}>Slett</button>}</div>
            </li>)}</ul> : <p className="saved-history-empty">Ingen kamper passer til søket.</p>}
          </section>}
          <div className="setup-stamp" aria-hidden="true">NORSK<br />DART<br /><b>501</b></div>
        </section>
      ) : gamePhase === 'bull-off' ? (
        <section className="bull-off-layout">
          <div className="bull-off-copy">
            <p className="eyebrow">FØR KAMP / BULLKAST</p>
            <h1>BULL<span className="title-period">.</span></h1>
            <p className="intro">Kast mot midten. Spilleren som kommer nærmest bull, starter {gameMode === 'cricket' ? 'kampen' : `på ${gameMode}`}.</p>
            <div className="rules-line"><span>{useCoinToss ? 'MYNTKAST' : 'SPILLERREKKEFØLGE'}</span><i /> BESTEMMER KASTEREKKEFØLGEN</div>
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
            <p className="eyebrow">42-PILERSREGEL / AVGJØR LEGG</p>
            <h1>BULL<span className="title-period">.</span></h1>
            <p className="intro">{dartLimitBullOff ? 'Ingen har avgjort 501-legget etter 42 piler hver. Kast mot bull, og velg spilleren som kom nærmest.' : 'Legget avgjøres med et bullkast. Trykk på spilleren som kom nærmest bull.'}</p>
            <div className="rules-line"><span>42 PILER HVER</span><i /> BULLKAST AVGJØR LEGGVINNEREN</div>
          </div>
          <div className="bull-off-panel">
            <div className="panel-heading"><div><p className="eyebrow">BULL-OFF</p><h2>Trykk på den som kom nærmest</h2></div><span className="panel-index">BULL / 42</span></div>
            <p className="bull-toss-note" role={dartLimitBullOff ? 'alert' : 'status'}>{dartLimitBullOff ? 'Varsel: Alle spillerne har kastet 42 piler uten å avgjøre legget.' : 'Kast mot bull for å avgjøre legget.'}</p>
            <div className="bull-winner-choices" role="group" aria-label="Velg spilleren som kom nærmest bull">{players.map((player) => <button key={player.id} type="button" onClick={() => finishLegBullOff(player.id)}>{player.name}</button>)}</div>
            <button className="text-button bull-undo-button" type="button" onClick={undoVisit}>Angre siste tur</button>
          </div>
        </section>
      ) : (
        <section className="game-layout">
          <div className="game-heading">
            <div><p className="eyebrow">{matchWinnerId ? <>KAMPEN ER AVGJORT <span className="heading-slash">/</span> BEST AV {bestOfLegs}</> : <>KAMPROM / 01 <span className="heading-slash">/</span> {roundWord} {String(legNumber).padStart(2, '0')} <span className="heading-slash">/</span> BEST AV {bestOfLegs}</>}</p><h1>{gameMode === 'cricket' ? 'Cricket' : gameMode}<span className="title-period">.</span></h1></div>
            <div className="game-actions">
              <button className="text-button" type="button" disabled={!history.length || matchWinnerId !== null} onClick={undoVisit}><span aria-hidden="true">↶</span> Angre</button>
              {!savedTournamentResultDate && <button className="text-button new-game-button" type="button" disabled={Boolean(activeTournamentMatch && matchWinnerId)} onClick={newGame}>Ny kamp <span aria-hidden="true">↗</span></button>}
            </div>
          </div>
          {activeTournamentMatch && <div className={`tournament-resume-status${tournamentMatchMessage.includes('ikke') ? ' is-error' : ''}`} role={tournamentMatchMessage.includes('ikke') ? 'alert' : 'status'}><span>{tournamentMatchMessage || 'Turneringskampen lagres automatisk, så den kan fortsettes senere.'}{activeTournamentRefereeName && <strong>Dommer: {activeTournamentRefereeName}</strong>}</span>{tournamentMatchMessage.includes('gjenopptakelse') && !matchWinnerId && <button className="text-button" type="button" onClick={retryTournamentProgressSave}>Prøv lagring på nytt</button>}</div>}
          {gameMode === '501' && dartLimitBullOff && !winnerId && <div className="bull-trigger" role="alert"><div><span>42 PILER HVER BRUKT</span><strong>Leggen er ikke avgjort. Kast mot bull, og trykk på navnet til den som kom nærmest.</strong></div></div>}
          <div className={`player-grid players-${players.length}`}>
            {players.map((player, index) => {
              const isActive = index === activePlayer && !winnerId
              const visibleLeg = winnerId ? legNumber - 1 : legNumber
              const legVisits = player.visits.filter((visit) => visit.legNumber === visibleLeg)
              const legDartsThrown = legVisits.reduce((total, visit) => total + visit.dartsThrown, 0)
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
                  <div className="player-card-bottom"><span>{gameMode === '501' ? `${legDartsThrown} PILER` : `${legVisits.length} ${legVisits.length === 1 ? 'TUR' : 'TURER'} I ${roundWord}`}</span>{player.scoreCorrected ? <span className="last-visit">POENGSUM RETTET</span> : lastVisit && <span className={lastVisit.bust ? 'last-visit bust-label' : 'last-visit'}>{lastVisit.bust ? 'SISTE TUR: BUST' : lastVisit.checkout ? 'UTGANG' : `SISTE TUR: ${lastVisit.total}`}</span>}</div>
                </article>
              )
            })}
          </div>
          {winner ? (
            <div className="winner-banner" role="status"><div><p className="eyebrow">{matchWinnerId ? 'KAMPEN ER AVGJORT' : `${roundWord} ${legNumber - 1} ER FERDIG`}</p><h2>{matchWinnerId ? `${winnerDisplayName} vant kampen.` : `${winnerDisplayName} vant ${roundWordLower}en.`}</h2><p className="match-scoreline">{scorePlayers.map((player) => `${teamMode ? `Lag ${player.teamId} (${teamMembers(players, player).map((member) => member.name).join(' + ')})` : player.name} ${legsWon[player.id] ?? 0}`).join('  ·  ')} <span>BEST AV {bestOfLegs}</span></p>{matchWinnerId && emailReportMessage && <p className="email-report-status" role="status">{emailReportMessage}</p>}{matchWinnerId && tournamentMatchMessage && <p className="email-report-status" role={activeTournamentMatch ? 'alert' : 'status'}>{tournamentMatchMessage}</p>}{matchWinnerId && activeTournamentMatch && <button className="text-button" type="button" disabled={tournamentBusy} onClick={retryTournamentMatchSave}>Prøv å lagre turneringsresultatet på nytt</button>}</div><button className="primary-button" type="button" disabled={Boolean(activeTournamentMatch && matchWinnerId) || Boolean(savedTournamentResultDate && tournamentBusy)} onClick={matchWinnerId ? savedTournamentResultDate ? goToNextTournamentMatch : newGame : startNextLeg}>{matchWinnerId ? activeTournamentMatch ? 'Lagre resultatet først' : savedTournamentResultDate ? savedTournamentNextMatch ? 'Klar til neste kamp' : 'Til turneringen' : 'Ny kamp' : `Neste ${roundWordLower}`} <span aria-hidden="true">↗</span></button></div>
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
                <label className="manual-score-field"><span>TOTALSUM · 0–180</span><input aria-label="Totalsum for turen" autoComplete="off" inputMode="numeric" type="number" min="0" max="180" step="1" required value={manualTotal} onChange={(event) => setManualVisitTotal(event.target.value)} placeholder="0" /></label>
                <label className="manual-darts-field"><span>PILER BRUKT</span><select aria-label="Antall piler brukt" value={manualDartsThrown} onChange={(event) => { const dartsThrown = Number(event.target.value) as 1 | 2 | 3; setManualDartsThrown(dartsThrown); setManualVisitTotal(manualTotal, dartsThrown) }}><option value={1}>1 pil</option><option value={2}>2 piler</option><option value={3}>3 piler</option></select></label>
                <label className="manual-double-toggle"><input type="checkbox" checked={manualLastDartDouble} onChange={(event) => setManualLastDartDouble(event.target.checked)} /><span className="custom-check" aria-hidden="true" />Siste pil var dobbel</label>
                <button className="primary-button submit-score" type="submit">Før poeng <span aria-hidden="true">↗</span></button>
              </div>}
              <div className="entry-bottom">
                {gameMode !== 'cricket' && <><div className="quick-scores" aria-label="Hurtigvalg for besøket"><button type="button" onClick={() => { if (entryMode === 'total') { setManualDartsThrown(3); setManualVisitTotal('0', 3) } else setDarts(['MISS', 'MISS', 'MISS']); setManualBust(false); setMessage('') }}>MISS</button>{Object.entries(QUICK_VISITS).map(([score, values]) => <button key={score} type="button" onClick={() => { if (entryMode === 'total') { setManualDartsThrown(3); setManualVisitTotal(score, 3) } else setDarts(values); setManualBust(false); setMessage('') }}>{score}</button>)}</div><label className="manual-double-toggle"><input type="checkbox" checked={manualBust} onChange={(event) => setManualBust(event.target.checked)} /><span className="custom-check" aria-hidden="true" />Registrer som bust</label></>}
              </div>
              <p className="entry-message" aria-live="polite">{message || (gameMode === 'cricket' ? 'Lukk alle feltene og ha minst like mange poeng som motstanderen.' : entryMode === 'total' ? 'Ved totalsum lik poengene du har igjen, markeres dobbel automatisk. Du kan endre avhukingen ved behov.' : 'Velg enkel, dobbel, trippel eller miss (bom) for hver pil.')}</p>
            </form>
          )}
          <div className="game-footer"><span>{gameMode === 'cricket' ? <>15–20 + BULL <i /> TRE TREFF</> : <>{gameMode} <i /> DOBBEL UT</>}</span><span>ANGRE RULLER TILBAKE SISTE TUR</span></div>
        </section>
      )}
      {selectedMatch && <div className="history-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedMatch(null) }}><section className="history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-dialog-title" tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape') setSelectedMatch(null) }}>
        <header className="history-dialog-heading"><div><p className="eyebrow">ARKIVERT KAMP · BANE {selectedMatch.courtNumber ?? 1}</p><h2 id="history-dialog-title">{selectedMatch.winnerName} vant</h2><p>{new Intl.DateTimeFormat('nb-NO', { dateStyle: 'full', timeStyle: 'short' }).format(new Date(selectedMatch.playedAt))} · {selectedMatch.gameMode === 'cricket' ? 'Cricket' : selectedMatch.gameMode === '121' ? '121 utgang' : '501'}{selectedMatch.bestOfLegs ? ` · Best av ${selectedMatch.bestOfLegs}` : ''}{selectedMatch.finishMethod ? ` · ${selectedMatch.finishMethod === 'bull-off' ? 'Bullkast' : 'Dobbel ut'}` : ''}</p></div><button className="text-button" type="button" onClick={() => setSelectedMatch(null)}>Lukk</button></header>
        {selectedMatch.legStarterName && <p className="history-dialog-starter">Startet på {selectedMatch.legStarterName}</p>}
        <div className="history-player-details">{selectedMatch.players.map((player) => <article className="history-player-detail" key={player.name}>
          <div className="history-player-heading"><h3>{player.teamId && <span>LAG {player.teamId} · </span>}{player.name}</h3><strong>{player.legsWon ?? 0} {selectedMatch.gameMode === '121' ? (player.legsWon === 1 ? 'runde' : 'runder') : 'legg'}</strong></div>
          <dl className="history-player-stats"><div><dt>SLUTTPOENG</dt><dd>{player.score}</dd></div><div><dt>3-PILSSNITT</dt><dd>{(player.average3 ?? 0).toFixed(1)}</dd></div><div><dt>PILER</dt><dd>{player.dartsThrown ?? 0}</dd></div><div><dt>HØYESTE</dt><dd>{player.highestVisit ?? 0}</dd></div><div><dt>180</dt><dd>{player.oneEighties ?? 0}</dd></div><div><dt>RASK UTGANG</dt><dd>{player.fastestCheckoutDarts ?? '—'}</dd></div></dl>
          <h4>TURER</h4>
          {(player.visits ?? []).length > 0 ? <ol className="history-visits">{(player.visits ?? []).map((visit, index) => <li key={`${visit.legNumber}-${index}`}><span>{selectedMatch.gameMode === '121' ? 'RUNDE' : 'LEGG'} {visit.legNumber} · TUR {index + 1}</span><strong>{formatSavedVisit(visit)}</strong><span>{visit.bust ? 'BUST' : visit.checkout ? 'UTGANG' : `${visit.total} POENG`} · {visit.dartsThrown ?? 3} PILER</span></li>)}</ol> : <p className="history-no-visits">Ingen turer ble lagret for denne kampen.</p>}
        </article>)}</div>
      </section></div>}
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
