import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { canUseSpeech } from '../lib/tts'
import { checkAnswer, scorePhonetic } from '../lib/scoring'
import { startSpeechRecognition } from '../lib/speech'
import {
  getHskLevel,
  getAnswerMode,
  setAnswerMode,
  getStreakDays,
  getPlaybackRate,
  setPlaybackRate,
  saveSessionResult,
  type AnswerMode,
  type SessionResult,
} from '../lib/storage'
import hsk1Data from '../data/hsk1.json'
import hsk2Data from '../data/hsk2.json'
import './Session.css'

interface ContentItem {
  id: string
  hsk: number
  type: 'sentence'
  characters: string
  pinyin: string
  english: string
  audio?: string
  distractors: string[]
}

const HSK_DATA: Record<number, ContentItem[]> = {
  1: hsk1Data as ContentItem[],
  2: hsk2Data as ContentItem[],
}

type Phase = 'start' | 'playing' | 'answered' | 'complete'
type SpeechState = 'idle' | 'listening' | 'processing'

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function stopActiveAudio(audioRef: React.MutableRefObject<HTMLAudioElement | null>) {
  if (audioRef.current) {
    audioRef.current.pause()
    audioRef.current.currentTime = 0
    audioRef.current = null
  }
}

function playItem(
  item: ContentItem,
  audioRef: React.MutableRefObject<HTMLAudioElement | null>,
  rate: number = 1,
) {
  if (!item.audio) return // No audio available — silent skip
  stopActiveAudio(audioRef)
  const audio = new Audio(item.audio)
  audio.playbackRate = rate
  audioRef.current = audio
  audio.play().catch(() => {
    if (audioRef.current === audio) audioRef.current = null
    // No TTS fallback — neural audio only
  })
}

export default function Session() {
  const navigate = useNavigate()

  // Config — read at session start
  const [hskLevel] = useState(() => getHskLevel())
  const [answerMode, setAnswerModeState] = useState<AnswerMode>(() => getAnswerMode())

  function setMode(mode: AnswerMode) {
    setAnswerModeState(mode)
    setAnswerMode(mode)
  }

  const [phase, setPhase] = useState<Phase>('start')
  const [items, setItems] = useState<ContentItem[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [correctCount, setCorrectCount] = useState(0)

  // Audio element ref (per-instance, no module-level state)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // Prefetch cache: pre-load next 2 Audio elements so playback is instant
  const prefetchCache = useRef<Map<string, HTMLAudioElement>>(new Map())

  // Playback speed — keep ref in sync so effects always read the latest value
  const [playbackRate, setPlaybackRateState] = useState<number>(() => getPlaybackRate())
  const playbackRateRef = useRef<number>(playbackRate)
  playbackRateRef.current = playbackRate

  // Multiple-choice state
  const [choices, setChoices] = useState<string[]>([])
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null)

  // Type-it state
  const [typedInput, setTypedInput] = useState('')
  const [typeResult, setTypeResult] = useState<'correct' | 'close' | 'incorrect' | null>(null)
  const [retryUsed, setRetryUsed] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)

  // Speak-it state
  const [speechState, setSpeechState] = useState<SpeechState>('idle')
  const [transcript, setTranscript] = useState('')
  const [phoneticScore, setPhoneticScore] = useState<number | null>(null)
  const stopRecognitionRef = useRef<(() => void) | null>(null)

  const currentItem = items[currentIndex]

  // Cleanup audio, prefetch cache, and speech recognition on component unmount
  useEffect(() => {
    return () => {
      stopActiveAudio(audioRef)
      prefetchCache.current.forEach((audio) => { audio.src = '' })
      prefetchCache.current.clear()
      stopRecognitionRef.current?.()
      stopRecognitionRef.current = null
    }
  }, [])

  // Shuffle choices when item changes
  useEffect(() => {
    if (!currentItem || answerMode !== 'multiple-choice') return
    if (currentItem.distractors.length < 3) {
      console.error(`Item ${currentItem.id} has insufficient distractors`)
      return
    }
    const opts = shuffle([...currentItem.distractors.slice(0, 3), currentItem.characters])
    setChoices(opts)
    setSelectedChoice(null)
  }, [currentItem, answerMode])

  // Prefetch next 2 items' audio whenever index changes
  useEffect(() => {
    if (items.length === 0) return
    const PREFETCH_AHEAD = 2
    const newCache = new Map<string, HTMLAudioElement>()

    for (let i = 1; i <= PREFETCH_AHEAD; i++) {
      const nextItem = items[currentIndex + i]
      if (!nextItem?.audio) continue
      const url = nextItem.audio
      // Reuse existing prefetched element if already loaded
      const existing = prefetchCache.current.get(url)
      if (existing) {
        newCache.set(url, existing)
      } else {
        const audio = new Audio(url)
        audio.preload = 'auto'
        newCache.set(url, audio)
      }
    }

    // Clean up stale entries not needed anymore — but never touch the active audio
    prefetchCache.current.forEach((audio, url) => {
      if (!newCache.has(url) && audio !== audioRef.current) {
        audio.src = ''
      }
    })
    prefetchCache.current = newCache
  }, [currentIndex, items])

  // Auto-play on new item (playing phase only) — use prefetched element if available
  useEffect(() => {
    if (phase !== 'playing' || !currentItem) return
    const t = setTimeout(() => {
      // Use prefetched Audio element if available, otherwise create fresh
      if (currentItem.audio) {
        const cached = prefetchCache.current.get(currentItem.audio)
        if (cached) {
          // Remove from cache before making it the active element
          // so prefetch cleanup never nulls out a playing audio
          prefetchCache.current.delete(currentItem.audio)
          stopActiveAudio(audioRef)
          cached.playbackRate = playbackRateRef.current
          cached.currentTime = 0
          audioRef.current = cached
          cached.play().catch(() => {
            if (audioRef.current === cached) audioRef.current = null
            // No TTS fallback — neural audio only
          })
          return
        }
      }
      playItem(currentItem, audioRef, playbackRateRef.current)
    }, 300)
    return () => clearTimeout(t)
  }, [currentIndex, phase, currentItem])

  // Auto-focus input in type mode
  useEffect(() => {
    if (phase === 'playing' && answerMode === 'type') {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [phase, answerMode, currentIndex])

  // Clean up speech recognition on item change or unmount
  useEffect(() => {
    return () => {
      stopRecognitionRef.current?.()
      stopRecognitionRef.current = null
    }
  }, [currentIndex])

  function startSession() {
    const data = HSK_DATA[hskLevel] ?? []
    if (data.length === 0) return
    setItems(shuffle(data))
    setCurrentIndex(0)
    setCorrectCount(0)
    setSelectedChoice(null)
    setTypedInput('')
    setTypeResult(null)
    setRetryUsed(false)
    setSpeechState('idle')
    setTranscript('')
    setPhoneticScore(null)
    setPhase('playing')
  }

  function advanceToAnswered(correct: boolean) {
    if (correct) setCorrectCount((c) => c + 1)
    setPhase('answered')
  }

  function handleChoiceClick(choice: string) {
    if (selectedChoice !== null) return
    setSelectedChoice(choice)
    advanceToAnswered(choice === currentItem.characters)
  }

  function handleTypeSubmit() {
    if (!currentItem || typeResult === 'correct') return
    const result = checkAnswer(typedInput, currentItem.characters)

    if (result === 'correct') {
      setTypeResult('correct')
      // Only award correct if this is first attempt (no retry)
      advanceToAnswered(!retryUsed)
    } else if (result === 'close' && !retryUsed) {
      // First close attempt — give hint and allow retry
      setTypeResult('close')
      setRetryUsed(true)
      // Stay in 'playing' phase so input stays active
      setTimeout(() => inputRef.current?.focus(), 50)
    } else {
      // close (2nd attempt) or incorrect — show answer
      setTypeResult('incorrect')
      advanceToAnswered(false)
    }
  }

  function handleNext() {
    const nextIndex = currentIndex + 1
    if (nextIndex >= items.length) {
      const correct = correctCount
      const total = items.length
      const sessionResult: SessionResult = {
        date: new Date().toISOString(),
        hskLevel,
        total,
        correct,
        answerMode,
      }
      saveSessionResult(sessionResult)
      setPhase('complete')
    } else {
      setCurrentIndex(nextIndex)
      setSelectedChoice(null)
      setTypedInput('')
      setTypeResult(null)
      setRetryUsed(false)
      setSpeechState('idle')
      setTranscript('')
      setPhoneticScore(null)
      setPhase('playing')
    }
  }

  function handleStartSpeech() {
    if (!canUseSpeech()) return
    if (speechState !== 'idle') return // Prevent multiple concurrent recognitions
    if (!currentItem) return // Guard against undefined item during transitions
    setSpeechState('listening')
    setTranscript('')

    const capturedCharacters = currentItem.characters // Capture at call time to avoid TOCTOU
    stopRecognitionRef.current = startSpeechRecognition((result, error) => {
      if (error || !result) {
        setSpeechState('idle')
        setTranscript(error === 'no-speech' ? '(no speech detected)' : `Error: ${error}`)
        return
      }
      setTranscript(result.transcript)
      setSpeechState('processing')

      const score = scorePhonetic(result.transcript, capturedCharacters)
      const pct = Math.round(score * 100)
      setPhoneticScore(pct)

      if (score >= 1.0) {
        setSpeechState('idle')
        advanceToAnswered(true)
      } else if (!retryUsed) {
        // Always give one retry if not 100% — show score as hint
        setRetryUsed(true)
        setSpeechState('idle')
      } else {
        // Second attempt: accept >=70% as correct, otherwise incorrect
        setSpeechState('idle')
        advanceToAnswered(score >= 0.7)
      }
    })
  }

  function handleStopSpeech() {
    stopRecognitionRef.current?.()
    stopRecognitionRef.current = null
    setSpeechState('idle')
  }

  // ── Render ──────────────────────────────────────────────────────────────

  if (phase === 'start') {
    return (
      <div className="session-container">
        <div className="session-card start-card">
          <h1 className="session-title">美听</h1>
          <p className="start-subtitle">Listening Practice</p>
          <div className="start-meta">
            <span className="meta-badge">HSK {hskLevel}</span>
          </div>
          <div className="mode-toggle">
            <button
              className={`mode-toggle-btn ${answerMode === 'multiple-choice' ? 'active' : ''}`}
              onClick={() => setMode('multiple-choice')}
            >
              🔠 Multiple Choice
            </button>
            <button
              className={`mode-toggle-btn ${answerMode === 'type' ? 'active' : ''}`}
              onClick={() => setMode('type')}
            >
              ⌨️ Type It
            </button>
            {canUseSpeech() && (
              <button
                className={`mode-toggle-btn ${answerMode === 'speak' ? 'active' : ''}`}
                onClick={() => setMode('speak')}
              >
                🎤 Speak It
              </button>
            )}
          </div>
          <p className="start-hint">
            {HSK_DATA[hskLevel]?.length ?? 0} sentences · Audio plays automatically
          </p>
          <button className="btn-primary btn-large" onClick={startSession}>
            Start Session ▶
          </button>
          <button className="btn-secondary" onClick={() => navigate('/settings')}>
            ⚙️ Settings
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'complete') {
    const total = items.length
    const pct = total > 0 ? Math.round((correctCount / total) * 100) : 0
    const streak = getStreakDays()
    return (
      <div className="session-container">
        <div className="session-card complete-card">
          <h1 className="session-title">Session Complete! 🎉</h1>
          <div className="score-display">
            <span className="score-big">{correctCount} / {total} correct ({pct}%)</span>
          </div>
          {streak > 0 && (
            <div className="streak-badge">🔥 {streak} day streak!</div>
          )}
          <button className="btn-primary btn-large" onClick={startSession}>Play Again</button>
          <button className="btn-secondary" onClick={() => navigate('/settings')}>⚙️ Settings</button>
        </div>
      </div>
    )
  }

  // playing or answered
  if (!currentItem) return null

  const isLastItem = currentIndex + 1 >= items.length

  return (
    <div className="session-container">
      <div className="session-card">
        {/* Progress */}
        <div className="progress-bar-wrap">
          <div
            className="progress-bar-fill"
            style={{ width: `${items.length > 0 ? ((currentIndex + 1) / items.length) * 100 : 0}%` }}
          />
        </div>
        <div className="progress-text">{currentIndex + 1} / {items.length}</div>

        {/* Mode hint */}
        <div className="session-mode-hint" onClick={() => navigate('/settings')}>
          {answerMode === 'multiple-choice' ? '🔠 Multiple Choice' : answerMode === 'type' ? '⌨️ Type It' : '🎤 Speak It'} · <span className="change-link">change</span>
        </div>

        {/* Replay */}
        <button className="replay-btn" onClick={() => playItem(currentItem, audioRef, playbackRateRef.current)}>
          ▶ Replay
        </button>

        {/* Characters + pinyin (show in answered phase) */}
        {phase === 'answered' && (
          <div className="characters-answered-block">
            <div className="characters-display">{currentItem.characters}</div>
            <div className="pinyin-reveal">{currentItem.pinyin}</div>
          </div>
        )}

        {/* Answer UI */}
        {answerMode === 'multiple-choice' ? (
          <div className="choices-grid">
            {choices.map((choice) => {
              let cls = 'answer-btn'
              if (selectedChoice !== null) {
                if (choice === currentItem.characters) cls += ' correct'
                else if (choice === selectedChoice) cls += ' incorrect'
                else cls += ' dimmed'
              }
              return (
                <button
                  key={choice}
                  className={cls}
                  onClick={() => handleChoiceClick(choice)}
                  disabled={selectedChoice !== null}
                >
                  {choice}
                </button>
              )
            })}
          </div>
        ) : answerMode === 'type' ? (
          <div className="type-area">
            <input
              ref={inputRef}
              className={`type-input${typeResult ? ` ${typeResult}` : ''}`}
              type="text"
              value={typedInput}
              onChange={(e) => setTypedInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && phase === 'playing') handleTypeSubmit()
              }}
              disabled={phase === 'answered'}
              placeholder="Type the Chinese sentence…"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />

            {/* Close hint — shown when retryUsed is true and still playing */}
            {typeResult === 'close' && phase === 'playing' && (
              <div className="hint-close">你快到了！ So close! Try again 🙂</div>
            )}

            {/* Incorrect reveal */}
            {typeResult === 'incorrect' && phase === 'answered' && (
              <div className="correct-reveal">
                Correct: <span className="correct-chars">{currentItem.characters}</span>
              </div>
            )}


            {/* Submit button */}
            {phase === 'playing' && (
              <button className="btn-primary" onClick={handleTypeSubmit} type="button">
                Submit
              </button>
            )}
          </div>
        ) : (
          <div className="speak-area">
            {/* Idle — tap to start */}
            {phase === 'playing' && speechState === 'idle' && (
              <button className="mic-btn" onClick={handleStartSpeech}>
                🎤 Tap to speak
              </button>
            )}

            {/* Listening — passive pulsing indicator */}
            {phase === 'playing' && speechState === 'listening' && (
              <>
                <div className="mic-listening-indicator">
                  <div className="mic-pulse-ring" />
                  <div className="mic-icon-large">🎤</div>
                  <p className="mic-listening-label">Listening...</p>
                  <p className="mic-listening-hint">Speak the sentence, then pause</p>
                </div>
                <button className="btn-cancel-speech" onClick={handleStopSpeech}>Cancel</button>
              </>
            )}

            {/* Processing — spinner */}
            {phase === 'playing' && speechState === 'processing' && (
              <div className="mic-processing">
                <div className="spinner" />
                <p>Analyzing your pronunciation...</p>
              </div>
            )}

            {/* Retry hint (close but not correct, first attempt) */}
            {retryUsed && phase === 'playing' && speechState === 'idle' && (
              <div className="hint-close">
                你快到了！ So close!
                {phoneticScore !== null && <span className="phonetic-score"> ({phoneticScore}% match)</span>}
                {' '}Try again 🙂
              </div>
            )}

            {/* Transcript display */}
            {transcript && speechState === 'idle' && (
              <div className="transcript-display">
                You said: <span className="transcript-text">{transcript}</span>
              </div>
            )}

            {/* Phonetic score + correct answer after failed attempt */}
            {phase === 'answered' && answerMode === 'speak' && (
              <div className="speak-result">
                {phoneticScore !== null && (
                  <div className="phonetic-score-display">
                    Phonetic match: <strong>{phoneticScore}%</strong>
                  </div>
                )}
                {transcript && (
                  <div className="transcript-display">
                    You said: <span className="transcript-text">{transcript}</span>
                  </div>
                )}
              </div>
            )}

            {!canUseSpeech() && (
              <div className="speech-unsupported">
                ⚠️ Speech recognition not supported in this browser. Use Chrome or Edge.
              </div>
            )}
          </div>
        )}

        {/* English translation (after answering) */}
        {phase === 'answered' && (
          <div className="english-reveal">{currentItem.english}</div>
        )}

        {/* Next button */}
        {phase === 'answered' && (
          <button
            className="btn-primary next-btn"
            onClick={() => handleNext()}
          >
            {isLastItem ? 'Finish →' : 'Next →'}
          </button>
        )}

        {/* Speed slider */}
        <div className="speed-control">
          <span className="speed-emoji">🐢</span>
          <input
            type="range"
            className="speed-slider"
            min={0.5}
            max={1.0}
            step={0.25}
            value={playbackRate}
            onChange={(e) => {
              const rate = parseFloat(e.target.value)
              setPlaybackRateState(rate)
              setPlaybackRate(rate)
              playbackRateRef.current = rate
              if (audioRef.current) {
                audioRef.current.playbackRate = rate
              }
            }}
          />
          <span className="speed-emoji">🐇</span>
          <span className="speed-label">{playbackRate.toFixed(2)}×</span>
        </div>
      </div>
    </div>
  )
}
