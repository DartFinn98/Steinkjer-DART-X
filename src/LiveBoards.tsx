import { useEffect, useState } from 'react'
import { loadLiveBoards } from './database'
import type { LiveBoard } from './database'

export function LiveBoards() {
  const [boards, setBoards] = useState<LiveBoard[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function refresh() {
      const next = await loadLiveBoards()
      if (!cancelled) {
        setBoards(next)
        setLoaded(true)
      }
    }
    void refresh()
    const interval = window.setInterval(() => { void refresh() }, 3000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])

  return <section className="live-boards" aria-label="Live score">
    <div className="live-boards-heading"><p className="eyebrow">LIVE</p><h2>Pågående kamper</h2></div>
    {loaded && boards.length === 0 && <p className="live-empty">Ingen kamper pågår akkurat nå. Oversikten oppdateres automatisk.</p>}
    <div className="live-board-grid">
      {boards.map((board) => <article className="live-board" key={board.courtNumber}>
        <header><strong>BANE {board.courtNumber}</strong><span>{board.gameMode === 'cricket' ? 'CRICKET' : board.gameMode} · BEST AV {board.bestOfLegs} · {board.gameMode === '121' ? 'RUNDE' : 'LEGG'} {board.legNumber}</span></header>
        <ul>
          {board.players.map((player, index) => {
            const active = !board.finished && index === board.activeIndex
            return <li key={`${player.name}-${index}`} className={active ? 'is-active' : undefined}>
              <span className="live-player-name">{active && <i aria-label="Kaster nå">▶</i>}{player.name}</span>
              <span className="live-player-legs" aria-label="Vunnet legg">{player.legs}</span>
              <strong className="live-player-score">{player.score}</strong>
              <small>Snitt {player.average.toFixed(1)}{player.lastVisit ? ` · Siste ${player.lastVisit}` : ''}</small>
            </li>
          })}
        </ul>
        {board.finished && <p className="live-finished">Kampen er ferdig</p>}
      </article>)}
    </div>
  </section>
}
