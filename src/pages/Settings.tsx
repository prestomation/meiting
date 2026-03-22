import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getHskLevel,
  setHskLevel,
  getAnswerMode,
  setAnswerMode,
  type AnswerMode,
} from '../lib/storage'
import './Settings.css'

const AVAILABLE_HSK_LEVELS = [1, 2]
const ALL_HSK_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9]

export default function Settings() {
  const navigate = useNavigate()
  const [hskLevel, setHskLevelState] = useState(() => getHskLevel())
  const [answerMode, setAnswerModeState] = useState<AnswerMode>(() => getAnswerMode())
  function handleHskLevel(level: number) {
    setHskLevelState(level)
    setHskLevel(level)
  }

  function handleAnswerMode(mode: AnswerMode) {
    setAnswerModeState(mode)
    setAnswerMode(mode)
  }

  return (
    <div className="settings-container">
      <div className="settings-card">
        <h1 className="settings-title">⚙️ Settings</h1>

        {/* HSK Level */}
        <section className="settings-section">
          <h2 className="settings-label">HSK Level</h2>
          <div className="level-grid">
            {ALL_HSK_LEVELS.map((level) => {
              const available = AVAILABLE_HSK_LEVELS.includes(level)
              return (
                <button
                  key={level}
                  className={`level-btn${hskLevel === level ? ' active' : ''}${!available ? ' unavailable' : ''}`}
                  onClick={() => available && handleHskLevel(level)}
                  disabled={!available}
                  title={available ? `HSK ${level}` : 'Coming soon'}
                >
                  {level}
                </button>
              )
            })}
          </div>
          <p className="settings-hint">Levels 3–9 coming soon</p>
        </section>

        {/* Answer Mode */}
        <section className="settings-section">
          <h2 className="settings-label">Answer Mode</h2>
          <div className="mode-toggle">
            <button
              className={`mode-toggle-btn${answerMode === 'multiple-choice' ? ' active' : ''}`}
              onClick={() => handleAnswerMode('multiple-choice')}
            >
              🔠 Multiple Choice
            </button>
            <button
              className={`mode-toggle-btn${answerMode === 'type' ? ' active' : ''}`}
              onClick={() => handleAnswerMode('type')}
            >
              ⌨️ Type It
            </button>
          </div>
        </section>

        <button className="btn-primary btn-large" onClick={() => navigate('/')}>
          ← Back to Session
        </button>
      </div>
    </div>
  )
}
