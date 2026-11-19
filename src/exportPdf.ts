import type { ClubTournament, SavedMatch, TournamentMatch } from './database'
import { getPoolStandings } from './tournament'

const modeLabels: Record<string, string> = { '501': '501', cricket: 'Cricket', '121': '121 utgang', stein5kamp: 'Steins 5-kamp' }

function escapeHtml(value: string | number) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}

function openPrintWindow(html: string) {
  const printWindow = window.open('', '_blank')
  if (!printWindow) return false
  printWindow.document.open()
  printWindow.document.write(html)
  printWindow.document.close()
  return true
}

const pageStyle = `body{font-family:Arial,sans-serif;margin:24px;color:#111}h1{margin:0 0 4px}h2{margin:20px 0 6px;font-size:16px}p{margin:0 0 12px;color:#555}
  table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px}th,td{border:1px solid #bbb;padding:6px;text-align:left;vertical-align:top}
  th{background:#eee}tr,section{break-inside:avoid}@page{size:A4;margin:12mm}`

export function exportTournamentPdf(tournament: ClubTournament, dateLabel: string) {
  const names = new Map(tournament.participants.map((participant) => [participant.signupId, participant.playerName]))
  const name = (signupId: string | null) => escapeHtml(signupId ? names.get(signupId) ?? '?' : 'Walkover')
  const result = (match: TournamentMatch) => match.winnerSignupId && match.playerOneLegs !== null && match.playerTwoLegs !== null
    ? `${match.playerOneLegs} – ${match.playerTwoLegs}`
    : ''
  const matchRows = (matches: TournamentMatch[]) => matches.map((match) =>
    `<tr><td>${name(match.playerOneSignupId)} – ${name(match.playerTwoSignupId)}</td><td>Best av ${match.bestOfLegs}</td><td>${result(match) || 'Ikke spilt'}</td><td>${match.winnerSignupId ? name(match.winnerSignupId) : ''}</td></tr>`).join('')
  const matchTable = (matches: TournamentMatch[]) => `<table><thead><tr><th>Kamp</th><th>Format</th><th>Resultat</th><th>Vinner</th></tr></thead><tbody>${matchRows(matches)}</tbody></table>`

  const pools = Array.from(new Set(tournament.participants.flatMap((participant) => participant.poolNumber === null ? [] : [participant.poolNumber]))).sort((first, second) => first - second)
  const poolHtml = pools.map((poolNumber) => {
    const standings = getPoolStandings(tournament, poolNumber).map((participant, index) =>
      `<tr><td>${index + 1}</td><td>${escapeHtml(participant.playerName)}</td><td>${participant.wins}</td><td>${participant.legDifference > 0 ? '+' : ''}${participant.legDifference}</td><td>${participant.advances ? 'Ja' : ''}</td></tr>`).join('')
    const matches = tournament.matches.filter((match) => match.phase === 'pool' && match.poolNumber === poolNumber)
    return `<section><h2>Pulje ${poolNumber}</h2><table><thead><tr><th>Plass</th><th>Navn</th><th>Seire</th><th>Leggdiff.</th><th>Videre</th></tr></thead><tbody>${standings}</tbody></table>${matchTable(matches)}</section>`
  }).join('')

  const cupMatches = tournament.matches.filter((match) => match.phase === 'cup')
  const rounds = Array.from(new Set(cupMatches.map((match) => match.roundNumber))).sort((first, second) => first - second)
  const cupHtml = rounds.map((round) => {
    const matches = cupMatches.filter((match) => match.roundNumber === round).sort((first, second) => first.bracketPosition - second.bracketPosition)
    const label = matches.length === 1 ? 'Finale' : matches.length === 2 ? 'Semifinale' : `Cup · runde ${round}`
    return `<section><h2>${label}</h2>${matchTable(matches)}</section>`
  }).join('')
  const finalMatch = cupMatches.find((match) => match.roundNumber === tournament.cupRound && cupMatches.filter((item) => item.roundNumber === tournament.cupRound).length === 1)
  const champion = finalMatch?.winnerSignupId ? `<h2>Vinner: ${name(finalMatch.winnerSignupId)}</h2>` : ''

  return openPrintWindow(`<!doctype html><html lang="nb"><head><meta charset="utf-8"><title>Turnering ${escapeHtml(dateLabel)}</title><style>${pageStyle}</style></head><body>
  <h1>Steinkjer DART-X – Turnering</h1><p>${escapeHtml(dateLabel)} · ${tournament.participants.length} spillere</p>${champion}${poolHtml}${cupHtml}
  <script>window.onload=function(){window.print()}</script></body></html>`)
}

export function exportMatchesPdf(matches: SavedMatch[], title = 'Kamparkiv') {
  const dateFormat = new Intl.DateTimeFormat('nb-NO', { dateStyle: 'medium', timeStyle: 'short' })
  const rows = matches.map((match) => {
    const players = match.players.map((player) => `${escapeHtml(player.name)} (${match.gameMode === 'stein5kamp' ? player.score : player.legsWon})`).join(' – ')
    const averages = match.gameMode === 'cricket' || match.gameMode === 'stein5kamp'
      ? ''
      : match.players.map((player) => `${escapeHtml(player.name)}: ${player.average3.toFixed(1)}`).join(', ')
    return `<tr><td>${escapeHtml(dateFormat.format(new Date(match.playedAt)))}</td><td>Bane ${match.courtNumber ?? 1}</td><td>${escapeHtml(modeLabels[match.gameMode ?? '501'] ?? '501')}${match.bestOfLegs ? ` · Best av ${match.bestOfLegs}` : ''}</td><td>${players}</td><td>${match.winnerName === 'Uavgjort' ? 'Uavgjort' : escapeHtml(match.winnerName)}</td><td>${averages}</td></tr>`
  }).join('')

  const html = `<!doctype html><html lang="nb"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    body{font-family:Arial,sans-serif;margin:24px;color:#111}h1{margin:0 0 4px}p{margin:0 0 16px;color:#555}
    table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #bbb;padding:6px;text-align:left;vertical-align:top}
    th{background:#eee}tr{break-inside:avoid}@page{size:A4 landscape;margin:12mm}
  </style></head><body><h1>Steinkjer DART-X – ${escapeHtml(title)}</h1><p>${matches.length} kamper · eksportert ${escapeHtml(dateFormat.format(new Date()))}</p>
  <table><thead><tr><th>Dato</th><th>Bane</th><th>Spilltype</th><th>Spillere (legg/poeng)</th><th>Vinner</th><th>Snitt</th></tr></thead><tbody>${rows}</tbody></table>
  <script>window.onload=function(){  window.print()}</script></body></html>`

    return openPrintWindow(html)
  }
