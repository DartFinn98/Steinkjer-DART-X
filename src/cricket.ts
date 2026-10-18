export const CRICKET_TARGETS = [20, 19, 18, 17, 16, 15, 25] as const

export type CricketMarks = Record<number, number>

export type CricketDart = {
  target: number | null
  marks: number
}

export type CricketVisitResult = {
  marks: CricketMarks
  score: number
}

export function applyCricketVisit(
  currentMarks: CricketMarks,
  opponentMarks: CricketMarks[],
  currentScore: number,
  darts: CricketDart[],
): CricketVisitResult {
  const marks = { ...currentMarks }
  let score = currentScore

  for (const dart of darts) {
    if (dart.target === null || !CRICKET_TARGETS.includes(dart.target as typeof CRICKET_TARGETS[number])) continue
    for (let hit = 0; hit < dart.marks; hit += 1) {
      if ((marks[dart.target] ?? 0) < 3) {
        marks[dart.target] = (marks[dart.target] ?? 0) + 1
      } else if (opponentMarks.some((opponent) => (opponent[dart.target as number] ?? 0) < 3)) {
        score += dart.target
      }
    }
  }

  return { marks, score }
}

export function hasWonCricket(marks: CricketMarks, score: number, opponentScores: number[]): boolean {
  const closedAllTargets = CRICKET_TARGETS.every((target) => (marks[target] ?? 0) >= 3)
  return closedAllTargets && opponentScores.every((opponentScore) => score >= opponentScore)
}