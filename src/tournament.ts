import type { ClubTournament, TournamentMatch, TournamentParticipant } from './database'

function shuffle<T>(items: T[]): T[] {
  const shuffled = [...items]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]]
  }
  return shuffled
}

function createPoolMatches(participants: TournamentParticipant[]): TournamentMatch[] {
  const matches: TournamentMatch[] = []
  const poolNumbers = Array.from(new Set(participants.map((participant) => participant.poolNumber).filter((pool): pool is number => pool !== null)))
  for (const poolNumber of poolNumbers) {
    const players = participants.filter((participant) => participant.poolNumber === poolNumber)
    let bracketPosition = 0
    for (let first = 0; first < players.length; first += 1) {
      for (let second = first + 1; second < players.length; second += 1) {
        const playerOne = players[first]
        const playerTwo = players[second]
        matches.push({
          id: `pool:${poolNumber}:${playerOne.signupId}:${playerTwo.signupId}`,
          phase: 'pool',
          roundNumber: 0,
          bracketPosition,
          poolNumber,
          playerOneSignupId: playerOne.signupId,
          playerTwoSignupId: playerTwo.signupId,
          playerOneLegs: null,
          playerTwoLegs: null,
          winnerSignupId: null,
          bestOfLegs: 3,
        })
        bracketPosition += 1
      }
    }
  }
  return matches
}

export function drawClubPools(
  eventDate: string,
  signups: Array<{ id: string; playerName: string }>,
  seedRanks: Map<string, number>,
): ClubTournament {
  if (signups.length < 2) throw new Error('Det må være minst to påmeldte for å trekke puljer.')
  const uniqueSeeds = Array.from(seedRanks.values())
  if (new Set(uniqueSeeds).size !== uniqueSeeds.length) throw new Error('Hvert seedingsnummer må være unikt.')

  const poolCount = Math.ceil(signups.length / 4)
  const poolSizes = Array.from({ length: poolCount }, (_, index) =>
    Math.floor(signups.length / poolCount) + (index < signups.length % poolCount ? 1 : 0))
  const participants: TournamentParticipant[] = signups.map((signup) => ({
    signupId: signup.id,
    playerName: signup.playerName,
    seed: seedRanks.get(signup.id) ?? null,
    poolNumber: null,
    advances: false,
    availability: 'not-arrived',
  }))
  const pools = poolSizes.map((): TournamentParticipant[] => [])
  const seeded = participants.filter((participant) => participant.seed !== null)
    .sort((first, second) => first.seed! - second.seed!)
  const unseeded = shuffle(participants.filter((participant) => participant.seed === null))
  const seedOrder = Array.from({ length: seeded.length }, (_, index) => {
    const round = Math.floor(index / poolCount)
    const position = index % poolCount
    return round % 2 === 0 ? position : poolCount - position - 1
  })
  seeded.forEach((participant, index) => {
    const poolIndex = seedOrder[index]
    pools[poolIndex].push({ ...participant, poolNumber: poolIndex + 1 })
  })

  for (const participant of unseeded) {
    const leastFilledSize = Math.min(...pools.map((pool) => pool.length))
    const eligiblePools = pools.flatMap((pool, index) => pool.length === leastFilledSize ? [index] : [])
    const poolIndex = eligiblePools[Math.floor(Math.random() * eligiblePools.length)]
    pools[poolIndex].push({ ...participant, poolNumber: poolIndex + 1 })
  }

  const drawnParticipants = pools.flat()
  const now = new Date().toISOString()
  return {
    eventDate,
    participants: drawnParticipants,
    matches: createPoolMatches(drawnParticipants),
    cupRound: 0,
    createdAt: now,
    updatedAt: now,
  }
}

export function updateTournamentMatchResult(
  tournament: ClubTournament,
  matchId: string,
  playerOneLegs: number,
  playerTwoLegs: number,
): ClubTournament {
  const match = tournament.matches.find((candidate) => candidate.id === matchId)
  if (!match || !match.playerTwoSignupId) throw new Error('Kampen finnes ikke eller kan ikke spilles.')
  const legsToWin = Math.floor(match.bestOfLegs / 2) + 1
  const validScore = (score: number) => Number.isInteger(score) && score >= 0 && score <= legsToWin
  if (!validScore(playerOneLegs)
    || !validScore(playerTwoLegs)
    || (playerOneLegs !== legsToWin && playerTwoLegs !== legsToWin)
    || playerOneLegs === playerTwoLegs) {
    throw new Error(`Før et gyldig resultat i best av ${match.bestOfLegs} legg (først til ${legsToWin}).`)
  }

  const winnerSignupId = playerOneLegs > playerTwoLegs ? match.playerOneSignupId : match.playerTwoSignupId
  const matches = tournament.matches.map((candidate) => {
    if (candidate.id !== matchId) return candidate
    const completedMatch = { ...candidate }
    delete completedMatch.inProgress
    return { ...completedMatch, playerOneLegs, playerTwoLegs, winnerSignupId }
  })
  return { ...tournament, matches, updatedAt: new Date().toISOString() }
}

export function getPoolStandings(tournament: ClubTournament, poolNumber: number) {
  const wins = new Map<string, number>()
  const legDifference = new Map<string, number>()
  for (const participant of tournament.participants.filter((item) => item.poolNumber === poolNumber)) {
    wins.set(participant.signupId, 0)
    legDifference.set(participant.signupId, 0)
  }
  for (const match of tournament.matches.filter((item) => item.phase === 'pool' && item.poolNumber === poolNumber && item.winnerSignupId)) {
    if (match.playerOneLegs === null || match.playerTwoLegs === null || !match.winnerSignupId) continue
    wins.set(match.winnerSignupId, (wins.get(match.winnerSignupId) ?? 0) + 1)
    legDifference.set(match.playerOneSignupId, (legDifference.get(match.playerOneSignupId) ?? 0) + match.playerOneLegs - match.playerTwoLegs)
    legDifference.set(match.playerTwoSignupId!, (legDifference.get(match.playerTwoSignupId!) ?? 0) + match.playerTwoLegs - match.playerOneLegs)
  }
  return tournament.participants
    .filter((participant) => participant.poolNumber === poolNumber)
    .map((participant) => ({
      ...participant,
      wins: wins.get(participant.signupId) ?? 0,
      legDifference: legDifference.get(participant.signupId) ?? 0,
    }))
    .sort((first, second) => second.wins - first.wins || second.legDifference - first.legDifference || (first.seed ?? Infinity) - (second.seed ?? Infinity) || first.playerName.localeCompare(second.playerName, 'nb'))
}

export function setTournamentAdvancement(tournament: ClubTournament, advancesIds: Set<string>): ClubTournament {
  const poolMatches = tournament.matches.filter((match) => match.phase === 'pool')
  if (poolMatches.some((match) => !match.winnerSignupId)) throw new Error('Registrer alle puljekampene før du velger hvem som går videre.')
  if (advancesIds.size < 2) throw new Error('Velg minst to spillere til cupen.')
  const participants = tournament.participants.map((participant) => ({
    ...participant,
    advances: advancesIds.has(participant.signupId),
  }))
  const cupParticipants = shuffle(participants.filter((participant) => participant.advances && participant.seed === null))
  const seededCupParticipants = participants.filter((participant) => participant.advances && participant.seed !== null)
    .sort((first, second) => first.seed! - second.seed!)
  const entries = [...seededCupParticipants, ...cupParticipants]
  const bracketSize = 2 ** Math.ceil(Math.log2(entries.length))
  const seedOrder = bracketSeedOrder(bracketSize)
  const entriesBySeed = new Map(entries.map((participant, index) => [index + 1, participant]))
  const firstRoundBestOfLegs = entries.length === 2 ? 9 : bracketSize === 4 ? 7 : 5
  const poolMatchesForCup = Array.from({ length: bracketSize / 2 }, (_, index) => {
    const playerOne = entriesBySeed.get(seedOrder[index * 2])
    const playerTwo = entriesBySeed.get(seedOrder[index * 2 + 1])
    if (!playerOne && !playerTwo) throw new Error('Cup-trekningen kunne ikke opprettes.')
    const winnerSignupId = !playerTwo && playerOne ? playerOne.signupId : null
    return {
      id: `cup:1:${index}`,
      phase: 'cup' as const,
      roundNumber: 1,
      bracketPosition: index,
      poolNumber: null,
      playerOneSignupId: playerOne?.signupId ?? playerTwo!.signupId,
      playerTwoSignupId: playerOne && playerTwo ? playerTwo.signupId : null,
      playerOneLegs: null,
      playerTwoLegs: null,
      winnerSignupId,
      bestOfLegs: firstRoundBestOfLegs as 5 | 7 | 9,
    }
  })
  return {
    ...tournament,
    participants,
    matches: [...poolMatches, ...poolMatchesForCup],
    cupRound: 1,
    updatedAt: new Date().toISOString(),
  }
}

function bracketSeedOrder(size: number): number[] {
  let order = [1, 2]
  while (order.length < size) {
    const nextSize = order.length * 2 + 1
    order = order.flatMap((seed) => [seed, nextSize - seed])
  }
  return order
}

export function createNextCupRound(tournament: ClubTournament): ClubTournament {
  const currentRoundMatches = tournament.matches
    .filter((match) => match.phase === 'cup' && match.roundNumber === tournament.cupRound)
    .sort((first, second) => first.bracketPosition - second.bracketPosition)
  if (currentRoundMatches.length === 0 || currentRoundMatches.some((match) => !match.winnerSignupId)) {
    throw new Error('Registrer alle kampene i cuprunden før neste runde trekkes.')
  }
  if (currentRoundMatches.length === 1) throw new Error('Turneringen er ferdig.')

  const winners = currentRoundMatches.map((match) => tournament.participants.find((participant) => participant.signupId === match.winnerSignupId))
    .filter((participant): participant is TournamentParticipant => Boolean(participant))
  const roundNumber = tournament.cupRound + 1
  const finalRound = winners.length === 2
  const semifinalRound = winners.length === 4
  const bestOfLegs = finalRound ? 9 : semifinalRound ? 7 : 5
  const matches: TournamentMatch[] = []
  for (let index = 0; index < winners.length; index += 2) {
    const playerOne = winners[index]
    const playerTwo = winners[index + 1]
    if (!playerOne || !playerTwo) throw new Error('Cup-runden har et ugyldig antall spillere.')
    const parentPositions = new Set([index, index + 1])
    const refereeSignupId = currentRoundMatches
      .filter((match) => parentPositions.has(match.bracketPosition))
      .map((match) => match.winnerSignupId === match.playerOneSignupId
        ? match.playerTwoSignupId
        : match.winnerSignupId === match.playerTwoSignupId
          ? match.playerOneSignupId
          : null)
      .find((signupId): signupId is string => Boolean(signupId))
    matches.push({
      id: `cup:${roundNumber}:${index / 2}`,
      phase: 'cup',
      roundNumber,
      bracketPosition: index / 2,
      poolNumber: null,
      playerOneSignupId: playerOne.signupId,
      playerTwoSignupId: playerTwo.signupId,
      playerOneLegs: null,
      playerTwoLegs: null,
      winnerSignupId: null,
      ...(refereeSignupId ? { refereeSignupId } : {}),
      bestOfLegs: bestOfLegs as 5 | 7 | 9,
    })
  }
  return {
    ...tournament,
    matches: [...tournament.matches, ...matches],
    cupRound: roundNumber,
    updatedAt: new Date().toISOString(),
  }
}

export function getNextQueuedTournamentMatch(tournament: ClubTournament): TournamentMatch | null {
  const matches = tournament.cupRound > 0
    ? tournament.matches.filter((match) => match.phase === 'cup' && match.roundNumber === tournament.cupRound)
    : tournament.matches.filter((match) => match.phase === 'pool')
  return matches
    .filter((match) => match.winnerSignupId === null && !match.inProgress && match.playerTwoSignupId !== null)
    .sort((first, second) => first.poolNumber !== second.poolNumber
      ? (first.poolNumber ?? 0) - (second.poolNumber ?? 0)
      : first.bracketPosition - second.bracketPosition)[0] ?? null
}

export function getTournamentMatchRefereeSignupId(tournament: ClubTournament, match: TournamentMatch): string | null {
  if (match.inProgress) {
    return match.inProgress.refereeSignupId ?? match.refereeSignupId ?? null
  }
  if (match.refereeSignupId) return match.refereeSignupId
  if (match.phase !== 'pool' || match.poolNumber === null || match.winnerSignupId !== null) return null

  const activeSignupIds = new Set(tournament.matches
    .filter((candidate) => candidate.inProgress && candidate.id !== match.id)
    .flatMap((candidate) => [candidate.playerOneSignupId, candidate.playerTwoSignupId ?? '']))
  const nextMatch = tournament.matches
    .filter((candidate) => candidate.phase === 'pool'
      && candidate.poolNumber === match.poolNumber
      && candidate.bracketPosition > match.bracketPosition
      && candidate.winnerSignupId === null
      && !candidate.inProgress
      && candidate.playerTwoSignupId !== null)
    .sort((first, second) => first.bracketPosition - second.bracketPosition)[0]
  if (!nextMatch) return null

  const currentPlayers = new Set<string>([
    match.playerOneSignupId,
    ...(match.playerTwoSignupId ? [match.playerTwoSignupId] : []),
  ])
  return [nextMatch.playerOneSignupId, ...(nextMatch.playerTwoSignupId ? [nextMatch.playerTwoSignupId] : [])]
    .find((signupId): signupId is string => Boolean(signupId)
      && !currentPlayers.has(signupId)
      && !activeSignupIds.has(signupId)) ?? null
}
