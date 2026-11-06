import { useState } from 'react'

export type Stein5KampScores = [number, number, number, number, number]
export type Stein5KampResult = {
  totals: [number, number]
  gameScores: [Stein5KampScores, Stein5KampScores]
}

type SectorEntry = { triple: string; double: string; single: string }
type BullEntry = { bullseye: string; outerBull: string }
type PlayerEntries = {
  superscore: string[]
  doubleMachine: string[]
  sectors: SectorEntry[]
  finishes: [string[], string[]]
  bullworker: BullEntry[]
}
type GameEvaluation = {
  scores: Stein5KampScores
  complete: boolean
  errors: string[]
}

const SECTORS = [12, 3, 20, 11, 15, 1, 19]
const DOUBLE_TARGETS = ['D16', 'D13', 'D3', 'D20', 'D11', 'D5', 'D10']
const GAME_NAMES = ['Superscore', 'Double Machine', 'Litt her og litt der', 'Utgangenes konge', 'Bullworker']
const GAME_DESCRIPTIONS = [
  'Kast 3 piler i hver av 7 runder. Poeng per runde: 61–99 = 1, 100–130 = 2, 131–159 = 4, 160–180 = 6.',
  'Kast 3 piler på dobbel i hver runde: D16, D13, D3, D20, D11, D5 og D10. Hvert treff gir 2 poeng, maksimalt 3 treff per runde.',
  'Kast mot sektorene 12, 3, 20, 11, 15, 1 og 19. Trippel gir 3 poeng, dobbel 2 og singel 1. Maksimalt 3 treff per sektor.',
  'Start på 170 poeng. Hver spiller får to forsøk på inntil 9 piler. Utgang på 1–3 piler gir 30 poeng, 4–6 gir 15 og 7–9 gir 2. Begge forsøk teller.',
  'Kast 3 piler mot bull i 7 runder. Bullseye gir 2 poeng, ytre bull 1. Maksimalt 3 treff per runde.',
]

function emptyPlayerEntries(): PlayerEntries {
  return {
    superscore: Array(7).fill(''),
    doubleMachine: Array(7).fill(''),
    sectors: SECTORS.map(() => ({ triple: '', double: '', single: '' })),
    finishes: [Array(3).fill(''), Array(3).fill('')],
    bullworker: Array.from({ length: 7 }, () => ({ bullseye: '', outerBull: '' })),
  }
}

function readNumber(value: string, maximum: number): number | null {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null
}

function evaluateFinishAttempt(values: string[]) {
  let remaining = 170
  let dartsUsed = 0
  let points = 0
  let complete = true
  let finished = false
  const rows: { remaining: number | null; bust: boolean }[] = []

  for (let turn = 0; turn < 3; turn += 1) {
    if (finished) {
      rows.push({ remaining: null, bust: false })
      continue
    }

    const visit = readNumber(values[turn], 180)
    if (visit === null) {
      complete = false
      rows.push({ remaining: null, bust: false })
      continue
    }

    dartsUsed += 3
    const nextRemaining = remaining - visit
    const bust = nextRemaining < 0 || nextRemaining === 1
    if (nextRemaining === 0) {
      remaining = 0
      finished = true
      points = dartsUsed <= 3 ? 30 : dartsUsed <= 6 ? 15 : 2
    } else if (!bust) {
      remaining = nextRemaining
    }
    rows.push({ remaining, bust })
  }

  return { complete, finished, points, remaining, rows }
}

function evaluatePlayer(entries: PlayerEntries): GameEvaluation {
  let complete = true
  const errors: string[] = []
  const scores: Stein5KampScores = [0, 0, 0, 0, 0]

  entries.superscore.forEach((value) => {
    const score = readNumber(value, 180)
    if (score === null) complete = false
    else scores[0] += score >= 160 ? 6 : score >= 131 ? 4 : score >= 100 ? 2 : score >= 61 ? 1 : 0
  })

  entries.doubleMachine.forEach((value) => {
    const hits = readNumber(value, 3)
    if (hits === null) complete = false
    else scores[1] += hits * 2
  })

  entries.sectors.forEach((entry, index) => {
    const hits = [entry.triple, entry.double, entry.single].map((value) => readNumber(value, 3))
    const totalHits = hits.reduce<number>((sum, hit) => sum + (hit ?? 0), 0)
    if (hits.some((hit) => hit === null)) complete = false
    else if (totalHits > 3) {
      complete = false
      errors.push(`Sektor ${SECTORS[index]}: maksimalt 3 treff.`)
    } else {
      scores[2] += (hits[0] ?? 0) * 3 + (hits[1] ?? 0) * 2 + (hits[2] ?? 0)
    }
  })

  entries.finishes.forEach((attempt) => {
    const result = evaluateFinishAttempt(attempt)
    if (!result.complete) complete = false
    scores[3] += result.points
  })

  entries.bullworker.forEach((entry, index) => {
    const bullseye = readNumber(entry.bullseye, 3)
    const outerBull = readNumber(entry.outerBull, 3)
    if (bullseye === null || outerBull === null) complete = false
    else if (bullseye + outerBull > 3) {
      complete = false
      errors.push(`Bullworker, runde ${index + 1}: maksimalt 3 treff.`)
    } else {
      scores[4] += bullseye * 2 + outerBull
    }
  })

  const boundedEntries: [string, number][] = [
    ...entries.superscore.map((value) => [value, 180] as [string, number]),
    ...entries.doubleMachine.map((value) => [value, 3] as [string, number]),
    ...entries.sectors.flatMap((entry) => [
      [entry.triple, 3] as [string, number],
      [entry.double, 3] as [string, number],
      [entry.single, 3] as [string, number],
    ]),
    ...entries.finishes.flatMap((attempt) => attempt.map((value) => [value, 180] as [string, number])),
    ...entries.bullworker.flatMap((entry) => [
      [entry.bullseye, 3] as [string, number],
      [entry.outerBull, 3] as [string, number],
    ]),
  ]
  if (boundedEntries.some(([value, maximum]) => value.trim() !== '' && readNumber(value, maximum) === null)) {
    complete = false
    errors.push('Bruk hele tall innenfor maksgrensen i hvert felt.')
  }

  return { scores, complete, errors }
}

type NumberFieldProps = {
  value: string
  label: string
  caption?: string
  max: number
  disabled?: boolean
  onChange: (value: string) => void
}

function NumberField({ value, label, caption, max, disabled = false, onChange }: NumberFieldProps) {
  return <label className="five-number-field">
    {caption && <span>{caption}</span>}
    <input
      aria-label={label}
      disabled={disabled}
      inputMode="numeric"
      max={max}
      min="0"
      onChange={(event) => onChange(event.target.value)}
      step="1"
      type="number"
      value={value}
    />
  </label>
}

type Props = {
  players: [string, string]
  onFinish: (result: Stein5KampResult) => Promise<void>
  onExit: () => void
}

export function Stein5KampGame({ players, onFinish, onExit }: Props) {
  const [entries, setEntries] = useState<[PlayerEntries, PlayerEntries]>([emptyPlayerEntries(), emptyPlayerEntries()])
  const [activeGame, setActiveGame] = useState(0)
  const [finished, setFinished] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const evaluations = entries.map(evaluatePlayer) as [GameEvaluation, GameEvaluation]
  const totals: [number, number] = [
    evaluations[0].scores.reduce((sum, score) => sum + score, 0),
    evaluations[1].scores.reduce((sum, score) => sum + score, 0),
  ]
  const allComplete = evaluations.every((evaluation) => evaluation.complete)

  function updatePlayer(index: number, update: (current: PlayerEntries) => PlayerEntries) {
    setEntries((current) => {
      const next = [...current] as [PlayerEntries, PlayerEntries]
      next[index] = update(current[index])
      return next
    })
    setMessage('')
  }

  async function submitResult() {
    if (!allComplete || saving || finished) return
    setSaving(true)
    setMessage('')
    try {
      await onFinish({ totals, gameScores: [evaluations[0].scores, evaluations[1].scores] })
      setFinished(true)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Resultatet kunne ikke lagres. Prøv igjen.')
    } finally {
      setSaving(false)
    }
  }

  function renderGameFields(playerIndex: number) {
    const playerEntries = entries[playerIndex]
    const readOnly = finished || saving
    const setListValue = (key: 'superscore' | 'doubleMachine', index: number, value: string) => {
      updatePlayer(playerIndex, (current) => {
        const values = [...current[key]]
        values[index] = value
        return { ...current, [key]: values }
      })
    }

    if (activeGame === 0 || activeGame === 1) {
      const key = activeGame === 0 ? 'superscore' : 'doubleMachine'
      const max = activeGame === 0 ? 180 : 3
      return <div className="five-round-list">
        {playerEntries[key].map((value, index) => <div className="five-round-row" key={index}>
          <span>{activeGame === 1 ? `Runde ${index + 1} · ${DOUBLE_TARGETS[index]}` : `Runde ${index + 1}`}</span>
          <NumberField
            disabled={readOnly}
            label={`${players[playerIndex]}, runde ${index + 1}${activeGame === 0 ? ', score' : `, treff på ${DOUBLE_TARGETS[index]}`}`}
            max={max}
            onChange={(next) => setListValue(key, index, next)}
            value={value}
          />
          <strong>{evaluations[playerIndex].scores[activeGame] !== undefined
            ? activeGame === 0
              ? (readNumber(value, 180) ?? 0) >= 160 ? 6 : (readNumber(value, 180) ?? 0) >= 131 ? 4 : (readNumber(value, 180) ?? 0) >= 100 ? 2 : (readNumber(value, 180) ?? 0) >= 61 ? 1 : 0
              : (readNumber(value, 3) ?? 0) * 2
            : 0} p</strong>
        </div>)}
      </div>
    }

    if (activeGame === 2) {
      return <div className="five-round-list">
        {playerEntries.sectors.map((sector, index) => {
          const hitCount = Number(sector.triple || 0) + Number(sector.double || 0) + Number(sector.single || 0)
          return <div className="five-round-row five-sector-row" key={SECTORS[index]}>
            <span>Sektor {SECTORS[index]}</span>
            <div className="five-hit-fields">
              {(['triple', 'double', 'single'] as const).map((kind) => <NumberField
                disabled={readOnly}
                key={kind}
                caption={kind === 'triple' ? 'Trippel' : kind === 'double' ? 'Dobbel' : 'Singel'}
                label={`${players[playerIndex]}, sektor ${SECTORS[index]}, ${kind === 'triple' ? 'trippel' : kind === 'double' ? 'dobbel' : 'singel'}`}
                max={3}
                onChange={(value) => updatePlayer(playerIndex, (current) => {
                  const sectors = [...current.sectors]
                  sectors[index] = { ...sectors[index], [kind]: value }
                  return { ...current, sectors }
                })}
                value={sector[kind]}
              />)}
            </div>
            <strong>{hitCount > 3 ? 'Sjekk treff' : (Number(sector.triple || 0) * 3 + Number(sector.double || 0) * 2 + Number(sector.single || 0))} p</strong>
          </div>
        })}
        <p className="five-hint">Feltene viser antall treff i trippel, dobbel og singel. Summen kan ikke overstige 3.</p>
      </div>
    }

    if (activeGame === 3) {
      return <div className="five-finish-attempts">
        {playerEntries.finishes.map((attempt, attemptIndex) => {
          const result = evaluateFinishAttempt(attempt)
          return <section className="five-finish-attempt" key={attemptIndex}>
            <h4>Forsøk {attemptIndex + 1} <span>{result.finished ? `${result.points} poeng` : result.complete ? 'Ingen utgang · 0 poeng' : '170 poeng igjen'}</span></h4>
            {Array.from({ length: 3 }, (_, turn) => {
              const isDisabled = readOnly || result.finished && result.rows[turn].remaining === null
              const turnValue = attempt[turn]
              const turnTotal = readNumber(turnValue, 180)
              const remaining = result.rows[turn].remaining
              return <div className="five-round-row five-finish-row" key={turn}>
                <span>{(turn + 1) * 3} piler</span>
                <NumberField
                  disabled={isDisabled}
                  label={`${players[playerIndex]}, forsøk ${attemptIndex + 1}, tur ${turn + 1} av 3`}
                  max={180}
                  onChange={(value) => updatePlayer(playerIndex, (current) => {
                    const finishes = [...current.finishes] as [string[], string[]]
                    finishes[attemptIndex] = [...finishes[attemptIndex]]
                    finishes[attemptIndex][turn] = value
                    return { ...current, finishes }
                  })}
                  value={turnValue}
                />
                <strong>{remaining === null ? turnTotal === null ? '—' : `${turnTotal} p` : result.rows[turn].bust ? `Bust · ${remaining} igjen` : `${remaining} igjen`}</strong>
              </div>
            })}
          </section>
        })}
      </div>
    }

    return <div className="five-round-list">
      {playerEntries.bullworker.map((entry, index) => <div className="five-round-row five-bull-row" key={index}>
        <span>Runde {index + 1}</span>
        <NumberField
          disabled={readOnly}
          caption="Bullseye"
          label={`${players[playerIndex]}, bullworker runde ${index + 1}, bullseye`}
          max={3}
          onChange={(value) => updatePlayer(playerIndex, (current) => {
            const bullworker = [...current.bullworker]
            bullworker[index] = { ...bullworker[index], bullseye: value }
            return { ...current, bullworker }
          })}
          value={entry.bullseye}
        />
        <NumberField
          disabled={readOnly}
          caption="Ytre bull"
          label={`${players[playerIndex]}, bullworker runde ${index + 1}, ytre bull`}
          max={3}
          onChange={(value) => updatePlayer(playerIndex, (current) => {
            const bullworker = [...current.bullworker]
            bullworker[index] = { ...bullworker[index], outerBull: value }
            return { ...current, bullworker }
          })}
          value={entry.outerBull}
        />
        <strong>{Number(entry.bullseye || 0) + Number(entry.outerBull || 0) > 3
          ? 'Sjekk treff'
          : Number(entry.bullseye || 0) * 2 + Number(entry.outerBull || 0)} p</strong>
      </div>)}
      <p className="five-hint">Bullseye gir 2 poeng. Ytre bull gir 1 poeng. Maksimalt 3 treff per runde.</p>
    </div>
  }

  const leadingPlayer = totals[0] === totals[1] ? null : totals[0] > totals[1] ? 0 : 1

  return <section className="five-kamp-page">
    <header className="five-kamp-heading">
      <div><p className="eyebrow">KAMPROM / POENGARK</p><h1>Steins 5-kamp<span className="title-period">.</span></h1><p className="intro">Før inn resultatene fra de fem spillene. Høyest totalsum vinner.</p></div>
      <button className="text-button" type="button" disabled={saving} onClick={onExit}>Avslutt <span aria-hidden="true">↗</span></button>
    </header>
    <section className="five-totals" aria-label="Sammenlagt poengsum" aria-live="polite">
      {players.map((player, index) => <div className={`five-total${leadingPlayer === index ? ' is-leading' : ''}`} key={index}>
        <span>{player}</span><strong>{totals[index]}</strong><small>POENG SAMMENLAGT</small>
      </div>)}
      {finished && <p className="five-result-message" role="status">{leadingPlayer === null ? 'Kampen endte uavgjort.' : `${players[leadingPlayer]} vant 5-kampen!`}</p>}
    </section>
    <nav className="five-game-tabs" aria-label="Velg spill">
      {GAME_NAMES.map((name, index) => <button
        aria-current={activeGame === index ? 'step' : undefined}
        className={activeGame === index ? 'is-active' : ''}
        key={name}
        onClick={() => setActiveGame(index)}
        type="button"
      ><span>{String(index + 1).padStart(2, '0')}</span>{name}<strong>{evaluations[0].scores[index]}–{evaluations[1].scores[index]}</strong></button>)}
    </nav>
    <section className="five-game-panel" aria-labelledby="five-game-title">
      <header className="five-game-panel-heading"><div><p className="eyebrow">SPILL {activeGame + 1} AV 5</p><h2 id="five-game-title">{GAME_NAMES[activeGame]}</h2><p>{GAME_DESCRIPTIONS[activeGame]}</p></div><strong>{evaluations[0].scores[activeGame]} – {evaluations[1].scores[activeGame]} <span>POENG</span></strong></header>
      {evaluations.some((evaluation) => evaluation.errors.length > 0) && <p className="five-error" role="alert">{evaluations.flatMap((evaluation, index) => evaluation.errors.map((error) => `${players[index]}: ${error}`)).join(' ')}</p>}
      <div className="five-player-columns">
        {players.map((player, index) => <section className="five-player-entry" key={index} aria-label={`Registrering for ${player}`}>
          <h3>{player}</h3>
          {renderGameFields(index)}
          <p className="five-player-total">{GAME_NAMES[activeGame]}: <strong>{evaluations[index].scores[activeGame]} poeng</strong></p>
        </section>)}
      </div>
      <div className="five-game-navigation">
        <button className="text-button" type="button" disabled={activeGame === 0} onClick={() => setActiveGame((game) => Math.max(0, game - 1))}>← Forrige spill</button>
        {activeGame < 4
          ? <button className="primary-button" type="button" onClick={() => setActiveGame((game) => Math.min(4, game + 1))}>Neste spill <span aria-hidden="true">↗</span></button>
          : <button className="primary-button" type="button" disabled={!allComplete || saving || finished} onClick={() => void submitResult()}>{saving ? 'LAGRER …' : finished ? 'Resultatet er lagret' : 'Avslutt og lagre 5-kampen'}<span aria-hidden="true">↗</span></button>}
      </div>
      {activeGame < 4 && allComplete && !finished && <button className="five-finish-early" type="button" disabled={saving} onClick={() => void submitResult()}>Alle resultatene er registrert – avslutt og lagre kampen</button>}
      {!allComplete && !finished && <p className="five-progress-note" role="status">Fyll inn alle feltene i de fem spillene før resultatet kan lagres.</p>}
      {message && <p className="five-error" role="alert">{message}</p>}
      {finished && <button className="primary-button five-new-game" type="button" onClick={onExit}>Til poengtavlen</button>}
    </section>
  </section>
}
