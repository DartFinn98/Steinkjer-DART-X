import { useCallback, useEffect, useRef, useState } from 'react'
import { loadLiveBoards } from './database'
import type { LiveBoard } from './database'

export function LiveBoards({ compact = false }: { compact?: boolean }) {
  const [boards, setBoards] = useState<LiveBoard[]>([])
  const [loaded, setLoaded] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const refreshInProgress = useRef(false)
  const isMounted = useRef(true)

  const refresh = useCallback(async (manual = false) => {
    if (refreshInProgress.current) return
    refreshInProgress.current = true
    if (manual) setRefreshing(true)

    try {
      const next = await loadLiveBoards()
      if (isMounted.current) {
        setBoards(next)
        setLoaded(true)
        setLastUpdated(new Date())
        setLoadError(false)
      }
    } catch {
      if (isMounted.current) {
        setLoaded(true)
        setLoadError(true)
      }
    } finally {
      refreshInProgress.current = false
      if (isMounted.current) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    isMounted.current = true
    void refresh()
    const interval = window.setInterval(() => { void refresh() }, 3000)
    return () => {
      isMounted.current = false
      window.clearInterval(interval)
    }
  }, [refresh])

  return <section className={compact ? 'live-boards is-compact' : 'live-boards'} aria-label="Live score" aria-busy={!loaded || refreshing}>
    <div className="live-boards-header">
      <div className="live-boards-heading"><p className="eyebrow"><span className="live-status-dot" aria-hidden="true" />LIVE</p><h2>Pågående kamper</h2></div>
      <div className="live-boards-controls">
        {loadError
          ? <p className="live-boards-error" role="alert">Kunne ikke oppdatere oversikten. Kontroller tilkoblingen.</p>
          : <p className="live-boards-updated">
            {!loaded ? 'Henter kamper …' : `${boards.length} ${boards.length === 1 ? 'kamp' : 'kamper'} · Oppdatert ${lastUpdated ? new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(lastUpdated) : 'nå'}`}
          </p>}
        {!compact && <button className="live-refresh-button" type="button" onClick={() => void refresh(true)} disabled={refreshing}>
          <span aria-hidden="true">↻</span> {refreshing ? 'Oppdaterer …' : 'Oppdater'}
        </button>}
      </div>
    </div>
    {loaded && !loadError && boards.length === 0 && compact ? <p className="live-empty">Ingen kamper pågår akkurat nå.</p> : null}
    {loaded && !loadError && boards.length === 0 && !compact && <p className="live-empty">Ingen kamper pågår akkurat nå. Oversikten oppdateres automatisk.</p>}
    <div className="live-board-grid">
      {boards.map((board) => <article className="live-board" key={board.courtNumber}>
        <header><strong>BANE {board.courtNumber}</strong><span>{board.gameMode === 'cricket' ? 'CRICKET' : board.gameMode} · BEST AV {board.bestOfLegs} · {board.gameMode === '121' ? 'RUNDE' : 'LEGG'} {board.legNumber}</span></header>
        <ul>
          {board.players.map((player, index) => {
            const active = !board.finished && index === board.activeIndex
            const lastVisitIsTon = player.lastVisitIsTon ?? Number(player.lastVisit) >= 100
            return <li key={`${player.name}-${index}`} className={active ? 'is-active' : undefined}>
              <span className="live-player-name">{active && <i aria-label="Kaster nå">▶</i>}{player.name}</span>
              <span className="live-player-legs" aria-label="Vunnet legg">{player.legs}</span>
              <strong className="live-player-score">{player.score}</strong>
              <small>Snitt {player.average.toFixed(1)}{player.lastVisit && <> · Siste <span className={lastVisitIsTon ? 'ton-highlight' : undefined}>{player.lastVisit}</span></>}</small>
            </li>
          })}
        </ul>
        {board.finished && <p className="live-finished">Kampen er ferdig</p>}
      </article>)}
    </div>
  </section>
}
