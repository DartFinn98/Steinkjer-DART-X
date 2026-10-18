export type VisitForStats = {
  legNumber: number
  total: number
  dartsThrown: number
  bust: boolean
  checkout: boolean
  darts: [number, number, number] | null
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
    visits: player.visits,
  }
}
