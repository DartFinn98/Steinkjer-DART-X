export type VisitForStats = {
  legNumber: number
  total: number
  dartsThrown: number
  bust: boolean
  checkout: boolean
  darts: [number, number, number] | null
  cricketDarts?: { target: number | null; marks: number }[]
}

export type PlayerMatchStats = {
  name: string
  score: number
  legsWon: number
  average3: number
  pointsScored: number
  dartsThrown: number
  tons: number
  oneEighties: number
  highestVisit: number
  fastestCheckoutDarts: number | null
  visits: VisitForStats[]
}

type PlayerForStats = {
  id: string
  name: string
  score: number
  visits: VisitForStats[]
}

export function summarizePlayer(player: PlayerForStats, legsWon: number): PlayerMatchStats {
  const pointsScored = player.visits.reduce((total, visit) => total + (visit.bust ? 0 : visit.total), 0)
  const dartsThrown = player.visits.reduce((total, visit) => total + visit.dartsThrown, 0)
  const dartsByLeg = new Map<number, number>()
  let fastestCheckoutDarts: number | null = null

  for (const visit of player.visits) {
    const legDarts = (dartsByLeg.get(visit.legNumber) ?? 0) + visit.dartsThrown
    dartsByLeg.set(visit.legNumber, legDarts)
    if (visit.checkout && (fastestCheckoutDarts === null || legDarts < fastestCheckoutDarts)) {
      fastestCheckoutDarts = legDarts
    }
  }

  return {
    name: player.name,
    score: player.score,
    legsWon,
    average3: dartsThrown > 0 ? (pointsScored / dartsThrown) * 3 : 0,
    pointsScored,
    dartsThrown,
    tons: player.visits.filter((visit) => !visit.bust && visit.total >= 100).length,
    oneEighties: player.visits.filter((visit) => !visit.bust && visit.total === 180).length,
    highestVisit: Math.max(0, ...player.visits.filter((visit) => !visit.bust).map((visit) => visit.total)),
    fastestCheckoutDarts,
    visits: player.visits,
  }
}
