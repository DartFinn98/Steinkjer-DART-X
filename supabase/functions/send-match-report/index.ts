import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type Visit = {
  legNumber: number
  total: number
  dartsThrown: number
  bust: boolean
  checkout: boolean
  darts: [number, number, number] | null
}

type PlayerStats = {
  name: string
  score: number
  legsWon: number
  average3: number
  pointsScored: number
  dartsThrown: number
  tons: number
  oneEighties: number
  highestVisit: number
  visits: Visit[]
}

type MatchReport = {
  playedAt: string
  winnerName: string
  bestOfLegs: 3 | 5 | 7 | 9
  players: PlayerStats[]
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character)
}

function formatPlayer(player: PlayerStats): string {
  const lines = [
    `${player.name}: ${player.legsWon} legg, ${player.score} poeng igjen`,
    `3-pilssnitt: ${player.average3.toFixed(1)} · 100+: ${player.tons} · 180: ${player.oneEighties} · høyeste runde: ${player.highestVisit}`,
    `Poeng: ${player.pointsScored} på ${player.dartsThrown} piler`,
    'Turer:',
    ...player.visits.map((visit) => {
      const dartScores = visit.darts ? ` (${visit.darts.join(' + ')})` : ''
      const outcome = visit.bust ? ' · bust' : visit.checkout ? ' · utgang' : ''
      return `  Legg ${visit.legNumber}: ${visit.total} poeng${dartScores} · ${visit.dartsThrown} piler${outcome}`
    }),
  ]
  return lines.join('\n')
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders })
  }

  const authorization = request.headers.get('Authorization')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const resendApiKey = Deno.env.get('RESEND_API_KEY')
  const fromAddress = Deno.env.get('RESEND_FROM_EMAIL')

  if (!authorization || !supabaseUrl || !supabaseAnonKey) {
    return Response.json({ error: 'Authentication is required.' }, { status: 401, headers: corsHeaders })
  }
  if (!serviceRoleKey || !resendApiKey || !fromAddress) {
    return Response.json({ error: 'Email delivery is not configured.' }, { status: 503, headers: corsHeaders })
  }

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authorization } },
  })
  const { data: { user }, error: authError } = await client.auth.getUser()
  if (authError || !user?.email) {
    return Response.json({ error: 'A signed-in email account is required.' }, { status: 401, headers: corsHeaders })
  }

  let report: MatchReport
  try {
    report = await request.json()
    if (!report.winnerName || !Array.isArray(report.players) || ![3, 5, 7, 9].includes(report.bestOfLegs)) {
      return Response.json({ error: 'Invalid match report.' }, { status: 400, headers: corsHeaders })
    }
  } catch {
    return Response.json({ error: 'Invalid match report.' }, { status: 400, headers: corsHeaders })
  }

  if (!report.players.every((player) => player && typeof player.name === 'string' && player.name.trim())) {
    return Response.json({ error: 'Invalid match report.' }, { status: 400, headers: corsHeaders })
  }

  const playerIds = Array.from(new Set(report.players.map((player) => player.name.trim().toLowerCase())))
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: playerProfiles, error: profilesError } = await adminClient
    .from('member_player_profiles')
    .select('user_id')
    .in('player_id', playerIds)
  if (profilesError) {
    console.error('Could not find registered accounts for match players:', profilesError)
    return Response.json({ error: 'Could not find registered match players.' }, { status: 500, headers: corsHeaders })
  }

  const playerUsers = await Promise.all((playerProfiles ?? []).map(async ({ user_id }) => {
    const { data, error } = await adminClient.auth.admin.getUserById(user_id)
    if (error) throw error
    return data.user
  }))
  const recipients = Array.from(new Set(playerUsers
    .filter((player) => player?.email && player.email_confirmed_at)
    .map((player) => player.email!)))
  if (recipients.length === 0) {
    return Response.json({ sent: false, recipientCount: 0 }, { headers: corsHeaders })
  }

  const playerText = report.players.map(formatPlayer).join('\n\n')
  const safeWinner = escapeHtml(report.winnerName)
  const playerHtml = report.players.map((player) => {
    const visits = player.visits.map((visit) => {
      const throws = visit.darts?.join(' + ') ?? `${visit.dartsThrown} piler`
      const result = visit.bust ? ' · bust' : visit.checkout ? ' · utgang' : ''
      return `<li>Legg ${visit.legNumber}: ${visit.total} poeng (${throws})${result}</li>`
    }).join('')

    return `<section><h2>${escapeHtml(player.name)} · ${player.legsWon} legg</h2><p>3-pilssnitt: ${player.average3.toFixed(1)} · 100+: ${player.tons} · 180: ${player.oneEighties} · høyeste runde: ${player.highestVisit}</p><p>${player.pointsScored} poeng på ${player.dartsThrown} piler · ${player.score} igjen</p><ul>${visits}</ul></section>`
  }).join('')

  for (const recipient of recipients) {
    const emailResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress,
      to: [recipient],
      subject: `Kampresultat: ${report.winnerName} vant · Best av ${report.bestOfLegs}`,
      text: `Steinkjer DART-X · Kampresultat\n\n${report.winnerName} vant kampen, best av ${report.bestOfLegs}.\nDato: ${report.playedAt}\n\n${playerText}`,
      html: `<main style="font-family:Arial,sans-serif;color:#19231e;max-width:680px;margin:auto"><p style="color:#175c45;font-weight:bold;letter-spacing:2px">STEINKJER DART-X</p><h1>Kampresultat</h1><p><strong>${safeWinner}</strong> vant kampen · best av ${report.bestOfLegs}</p><p>${escapeHtml(report.playedAt)}</p>${playerHtml}</main>`,
    }),
  })

    if (!emailResponse.ok) {
      console.error('Email provider rejected match report:', await emailResponse.text())
      return Response.json({ error: 'Could not send the match report.' }, { status: 502, headers: corsHeaders })
    }
  }

  return Response.json({ sent: true, recipientCount: recipients.length }, { headers: corsHeaders })
})
