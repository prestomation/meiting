import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getHskLevel,
  setHskLevel,
  getAnswerMode,
  setAnswerMode,
  getBatchSize,
  setBatchSize,
  resetLevelProgress,
  getVoiceProvider,
  setVoiceProvider,
  VOICE_OPTIONS,
  type AnswerMode,
  type VoiceProvider,
} from '../lib/storage'
import { canUseSpeech } from '../lib/tts'
import './Settings.css'

const AVAILABLE_HSK_LEVELS = [1, 2]
const ALL_HSK_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9]
const BATCH_SIZE_OPTIONS = [10, 20, 30]

export default function Settings() {
  const navigate = useNavigate()
  const [hskLevel, setHskLevelState] = useState(() => getHskLevel())
  const [answerMode, setAnswerModeState] = useState<AnswerMode>(() => getAnswerMode())
  const [batchSize, setBatchSizeState] = useState(() => getBatchSize())
  const [voice, setVoiceState] = useState<VoiceProvider>(() => getVoiceProvider())
  const [resetConfirm, setResetConfirm] = useState(false)

  function handleHskLevel(level: number) {
    setHskLevelState(level)
    setHskLevel(level)
    setResetConfirm(false)
  }

  function handleAnswerMode(mode: AnswerMode) {
    setAnswerModeState(mode)
    setAnswerMode(mode)
  }

  function handleBatchSize(size: number) {
    setBatchSizeState(size)
    setBatchSize(size)
  }

  function handleVoiceChange(v: VoiceProvider) {
    setVoiceState(v)
    setVoiceProvider(v)
  }

  function handleResetConfirm() {
    resetLevelProgress(hskLevel)
    setResetConfirm(false)
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
            {canUseSpeech() && (
              <button
                className={`mode-toggle-btn${answerMode === 'speak' ? ' active' : ''}`}
                onClick={() => handleAnswerMode('speak')}
              >
                🎤 Speak It
              </button>
            )}
          </div>
        </section>

        {/* Batch Size */}
        <section className="settings-section">
          <h2 className="settings-label">Batch Size</h2>
          <div className="mode-toggle">
            {BATCH_SIZE_OPTIONS.map((size) => (
              <button
                key={size}
                className={`mode-toggle-btn${batchSize === size ? ' active' : ''}`}
                onClick={() => handleBatchSize(size)}
              >
                {size}
              </button>
            ))}
          </div>
          <p className="settings-hint">Sentences per session</p>
        </section>

        {/* Voice */}
        <section className="settings-section">
          <h2 className="settings-label">Voice</h2>
          <div className="mode-toggle">
            {VOICE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                className={`mode-toggle-btn${voice === opt.id ? ' active' : ''}`}
                onClick={() => handleVoiceChange(opt.id)}
              >
                {opt.label}
                <br />
                <small>{opt.description}</small>
              </button>
            ))}
          </div>
        </section>

        {/* Reset Level Progress */}
        <section className="settings-section">
          <h2 className="settings-label">Reset Level Progress</h2>
          {!resetConfirm ? (
            <>
              <p className="settings-hint">
                Clear all progress for HSK {hskLevel} (seen items, SRS data).
              </p>
              <button
                className="btn-danger"
                onClick={() => setResetConfirm(true)}
              >
                🗑️ Reset HSK {hskLevel} Progress
              </button>
            </>
          ) : (
            <div className="reset-confirm">
              <p className="reset-confirm-text">
                Are you sure? This will erase all HSK {hskLevel} seen items and review data.
              </p>
              <div className="reset-confirm-actions">
                <button className="btn-secondary" onClick={() => setResetConfirm(false)}>
                  Cancel
                </button>
                <button className="btn-danger" onClick={handleResetConfirm}>
                  Yes, reset
                </button>
              </div>
            </div>
          )}
        </section>

        <button className="btn-primary btn-large" onClick={() => navigate('/')}>
          ← Back to Session
        </button>
      </div>
    </div>
  )
}
