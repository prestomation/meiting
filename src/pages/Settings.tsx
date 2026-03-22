import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getHskLevel,
  setHskLevel,
  getAnswerMode,
  setAnswerMode,
  getPreferredVoice,
  setPreferredVoice,
  type AnswerMode,
} from '../lib/storage'
import './Settings.css'

const AVAILABLE_HSK_LEVELS = [1, 2]
const ALL_HSK_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9]

export default function Settings() {
  const navigate = useNavigate()
  const [hskLevel, setHskLevelState] = useState(() => getHskLevel())
  const [answerMode, setAnswerModeState] = useState<AnswerMode>(() => getAnswerMode())
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [preferredVoice, setPreferredVoiceState] = useState(() => getPreferredVoice() ?? '')

  function handleHskLevel(level: number) {
    setHskLevelState(level)
    setHskLevel(level)
  }

  function handleAnswerMode(mode: AnswerMode) {
    setAnswerModeState(mode)
    setAnswerMode(mode)
  }

  function handleVoiceChange(name: string) {
    setPreferredVoiceState(name)
    setPreferredVoice(name)
  }

  useEffect(() => {
    function loadVoices() {
      const all = window.speechSynthesis.getVoices()
      const zh = all.filter((v) => v.lang.startsWith('zh'))
      setVoices(zh.length > 0 ? zh : all.slice(0, 10))
    }
    loadVoices()
    window.speechSynthesis.onvoiceschanged = loadVoices
    return () => {
      window.speechSynthesis.onvoiceschanged = null
    }
  }, [])

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

        {/* Voice */}
        <section className="settings-section">
          <h2 className="settings-label">Voice (TTS)</h2>
          {voices.length === 0 ? (
            <p className="settings-hint">No voices detected — your browser may not support speech synthesis.</p>
          ) : (
            <select
              className="voice-select"
              value={preferredVoice}
              onChange={(e) => handleVoiceChange(e.target.value)}
            >
              <option value="">System default</option>
              {voices.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
          )}
          <button
            className="btn-secondary voice-test-link"
            onClick={() => navigate('/voice-test')}
          >
            🎙 Voice Test →
          </button>
        </section>

        <button className="btn-primary btn-large" onClick={() => navigate('/')}>
          ← Back to Session
        </button>
      </div>
    </div>
  )
}
