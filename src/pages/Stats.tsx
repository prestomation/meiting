import { getStreakDays, getSessionHistory, getSeenIds } from '../lib/storage'
import hsk1Data from '../data/hsk1.json'
import hsk2Data from '../data/hsk2.json'
import './Stats.css'

const HSK_TOTALS: Record<number, number> = {
  1: (hsk1Data as { id: string }[]).length,
  2: (hsk2Data as { id: string }[]).length,
}

export default function Stats() {
  const streak = getStreakDays()
  const history = getSessionHistory()

  // Level progress data
  const levelProgressEntries = Object.entries(HSK_TOTALS).map(([levelStr, total]) => {
    const level = Number(levelStr)
    const seenCount = getSeenIds(level).size
    return { level, seenCount, total }
  }).filter(({ seenCount }) => seenCount > 0)

  // Derived data
  const totalSessions = history.length
  const totalCorrect = history.reduce((sum, s) => sum + s.correct, 0)
  const totalQuestions = history.reduce((sum, s) => sum + s.total, 0)
  const overallAccuracy =
    totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : null

  // Accuracy by HSK level
  const byLevel: Record<number, { correct: number; total: number }> = {}
  for (const s of history) {
    if (!byLevel[s.hskLevel]) byLevel[s.hskLevel] = { correct: 0, total: 0 }
    byLevel[s.hskLevel].correct += s.correct
    byLevel[s.hskLevel].total += s.total
  }

  // Activity calendar — last 30 days
  const activityMap: Record<string, number> = {}
  for (const s of history) {
    activityMap[s.date] = (activityMap[s.date] ?? 0) + 1
  }

  const toLocalDateKey = (d: Date): string => {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
  const now = new Date()
  const last30: Array<{ date: string; count: number }> = []
  for (let i = 29; i >= 0; i--) {
    // Use local-time date constructor to correctly cross month/year boundaries
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = toLocalDateKey(d)
    last30.push({ date: key, count: activityMap[key] ?? 0 })
  }

  if (totalSessions === 0) {
    return (
      <div className="stats-container">
        <h1 className="stats-title">统计 Stats</h1>
        <div className="stats-empty">
          <p>No sessions yet.</p>
          <p>Complete a session to see your stats here.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="stats-container">
      <h1 className="stats-title">统计 Stats</h1>

      {/* Streak */}
      <div className="stats-card streak-card">
        <span className="streak-flame">🔥</span>
        <div>
          <div className="streak-number">{streak}</div>
          <div className="streak-label">day streak</div>
        </div>
      </div>

      {/* Level Progress */}
      {levelProgressEntries.length > 0 && (
        <div className="stats-card">
          <div className="stats-card-title">Level Progress</div>
          {levelProgressEntries.map(({ level, seenCount, total }) => {
            const seenPct = total > 0 ? (seenCount / total) * 100 : 0
            // Accuracy from session history for this level
            const levelHistory = history.filter((s) => s.hskLevel === level)
            const lCorrect = levelHistory.reduce((sum, s) => sum + s.correct, 0)
            const lTotal = levelHistory.reduce((sum, s) => sum + s.total, 0)
            const accuracy = lTotal > 0 ? Math.round((lCorrect / lTotal) * 100) : null
            return (
              <div key={level} className="level-progress-row">
                <div className="level-progress-header">
                  <span className="level-progress-name">HSK {level}</span>
                  <span className="level-progress-counts">
                    {seenCount} / {total} seen
                    {accuracy !== null && <span className="level-progress-accuracy">  •  {accuracy}% accuracy</span>}
                  </span>
                </div>
                <div className="level-bar-bg">
                  <div className="level-bar-fill" style={{ width: `${seenPct}%` }} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Overall accuracy */}
      <div className="stats-card">
        <div className="stats-card-title">Overall Accuracy</div>
        <div className="stats-accuracy-big">
          {overallAccuracy !== null ? `${overallAccuracy}%` : '—'}
        </div>
        <div className="stats-subtitle">
          {totalSessions} session{totalSessions !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Activity calendar */}
      <div className="stats-card">
        <div className="stats-card-title">Last 30 Days</div>
        <div className="activity-grid">
          {last30.map(({ date, count }) => (
            <div
              key={date}
              className={`activity-day activity-${Math.min(count, 3)}`}
              title={`${date}: ${count} session${count !== 1 ? 's' : ''}`}
            />
          ))}
        </div>
      </div>

      {/* Accuracy by level */}
      {Object.keys(byLevel).length > 0 && (
        <div className="stats-card">
          <div className="stats-card-title">By HSK Level</div>
          {Object.entries(byLevel)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([level, { correct, total }]) => {
              const pct = total > 0 ? Math.round((correct / total) * 100) : 0
              return (
                <div key={level} className="level-row">
                  <div className="level-label">HSK {level}</div>
                  <div className="level-bar-bg">
                    <div className="level-bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="level-pct">{pct}%</div>
                </div>
              )
            })}
        </div>
      )}

      {/* Session history */}
      <div className="stats-card">
        <div className="stats-card-title">Recent Sessions</div>
        <div className="session-list">
          {[...history]
            .reverse()
            .slice(0, 20)
            .map((s, i) => (
              <div key={`${s.date}-${s.hskLevel}-${s.answerMode}-${i}`} className="session-row">
                <span className="session-date">{s.date}</span>
                <span className="session-level">HSK {s.hskLevel}</span>
                <span className="session-score">
                  {s.correct}/{s.total}
                </span>
                <span className="session-pct">
                  {s.total > 0 ? Math.round((s.correct / s.total) * 100) : 0}%
                </span>
                <span className="session-mode">
                  {s.answerMode === 'multiple-choice'
                    ? '🔠'
                    : s.answerMode === 'type'
                      ? '⌨️'
                      : '🎤'}
                </span>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}
