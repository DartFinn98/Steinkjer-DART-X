type DartKind = 'single' | 'double' | 'triple' | 'outerBull' | 'bull'

type Dart = {
  points: number
  label: string
  kind: DartKind
  target: number
}

const darts: Dart[] = []
for (let target = 1; target <= 20; target += 1) {
  darts.push({ points: target, label: `S${target}`, kind: 'single', target })
  darts.push({ points: target * 2, label: `D${target}`, kind: 'double', target })
  darts.push({ points: target * 3, label: `T${target}`, kind: 'triple', target })
}
darts.push({ points: 25, label: 'SB', kind: 'outerBull', target: 25 })
darts.push({ points: 50, label: 'Bull', kind: 'bull', target: 25 })

const finishDarts = darts.filter((dart) => dart.kind === 'double' || dart.kind === 'bull')
const preferredDoubles = [20, 16, 18, 12, 10, 8, 14, 15, 9, 6, 4, 2, 1]

function finishRank(dart: Dart): number {
  if (dart.kind === 'bull') return 14
  const preferredIndex = preferredDoubles.indexOf(dart.target)
  return preferredIndex === -1 ? 20 + dart.target : preferredIndex
}

function setupRank(dart: Dart): number {
  if (dart.kind === 'triple') return 0
  if (dart.kind === 'bull' || dart.kind === 'outerBull') return 1
  if (dart.kind === 'double') return 2
  return 3
}

function compareRoutes(first: Dart[], second: Dart[]): number {
  const firstFinishRank = finishRank(first[first.length - 1])
  const secondFinishRank = finishRank(second[second.length - 1])
  if (firstFinishRank !== secondFinishRank) return firstFinishRank - secondFinishRank

  const firstSetupRank = first.slice(0, -1).reduce((sum, dart) => sum + setupRank(dart), 0)
  const secondSetupRank = second.slice(0, -1).reduce((sum, dart) => sum + setupRank(dart), 0)
  if (firstSetupRank !== secondSetupRank) return firstSetupRank - secondSetupRank

  return first.map((dart) => dart.label).join(' ').localeCompare(second.map((dart) => dart.label).join(' '))
}

export function getCheckoutHint(score: number): string | null {
  if (!Number.isInteger(score) || score < 2 || score > 170) return null

  for (let dartCount = 1; dartCount <= 3; dartCount += 1) {
    const routes: Dart[][] = []

    function findRoutes(pointsLeft: number, setup: Dart[]) {
      if (setup.length === dartCount - 1) {
        for (const finish of finishDarts) {
          if (finish.points === pointsLeft) routes.push([...setup, finish])
        }
        return
      }

      for (const dart of darts) {
        if (dart.points < pointsLeft) findRoutes(pointsLeft - dart.points, [...setup, dart])
      }
    }

    findRoutes(score, [])
    if (routes.length > 0) {
      routes.sort(compareRoutes)
      return routes[0].map((dart) => dart.label).join('  →  ')
    }
  }

  return null
}
