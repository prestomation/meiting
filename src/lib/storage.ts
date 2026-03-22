// localStorage schema + typed helpers

export const KEYS = {
  PREFERRED_VOICE: 'meiting_preferred_voice',
  HSK_LEVEL: 'meiting_hsk_level',
  ANSWER_MODE: 'meiting_answer_mode',
  STREAK_DAYS: 'meiting_streak_days',
  LAST_ACTIVE_DATE: 'meiting_last_active',
  SESSION_HISTORY: 'meiting_history',
  PLAYBACK_RATE: 'meiting_playback_rate',
} as const

export type KeyName = (typeof KEYS)[keyof typeof KEYS]

export interface SessionResult {
  date: string // ISO
  hskLevel: number
  total: number
  correct: number
  answerMode: 'multiple-choice' | 'type'
}

// Generic helpers
export function getStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function setStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage full or unavailable
  }
}

export function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

// Typed getters/setters

export function getPreferredVoice(): string | null {
  return getStorage(KEYS.PREFERRED_VOICE)
}
export function setPreferredVoice(name: string): void {
  setStorage(KEYS.PREFERRED_VOICE, name)
}

export function getHskLevel(): number {
  const parsed = parseInt(getStorage(KEYS.HSK_LEVEL) ?? '1', 10)
  return isNaN(parsed) ? 1 : parsed
}
export function setHskLevel(level: number): void {
  setStorage(KEYS.HSK_LEVEL, String(level))
}

export type AnswerMode = 'multiple-choice' | 'type'
export function getAnswerMode(): AnswerMode {
  const stored = getStorage(KEYS.ANSWER_MODE)
  if (stored === 'multiple-choice' || stored === 'type') {
    return stored
  }
  return 'multiple-choice'
}
export function setAnswerMode(mode: AnswerMode): void {
  setStorage(KEYS.ANSWER_MODE, mode)
}

export function getStreakDays(): number {
  const parsed = parseInt(getStorage(KEYS.STREAK_DAYS) ?? '0', 10)
  return isNaN(parsed) ? 0 : parsed
}
export function setStreakDays(days: number): void {
  setStorage(KEYS.STREAK_DAYS, String(days))
}

export function getLastActiveDate(): string | null {
  return getStorage(KEYS.LAST_ACTIVE_DATE)
}
export function setLastActiveDate(date: string): void {
  setStorage(KEYS.LAST_ACTIVE_DATE, date)
}

export function getSessionHistory(): SessionResult[] {
  try {
    const data = getStorage(KEYS.SESSION_HISTORY)
    if (!data) return []

    const parsed = JSON.parse(data)
    if (!Array.isArray(parsed)) return []

    return parsed.filter((item): item is SessionResult =>
      item != null &&
      typeof item === 'object' &&
      typeof item.date === 'string' &&
      typeof item.hskLevel === 'number' &&
      typeof item.total === 'number' &&
      typeof item.correct === 'number' &&
      item.hskLevel > 0 &&
      item.total >= 0 &&
      item.correct >= 0 &&
      item.correct <= item.total &&
      (item.answerMode === 'multiple-choice' || item.answerMode === 'type')
    )
  } catch {
    return []
  }
}
export function addSessionResult(result: SessionResult): void {
  const history = getSessionHistory()
  history.push(result)
  // Keep only last 100 sessions to prevent localStorage quota exceeded
  const bounded = history.slice(-100)
  setStorage(KEYS.SESSION_HISTORY, JSON.stringify(bounded))
}

const PLAYBACK_RATE_MIN = 0.5
const PLAYBACK_RATE_MAX = 1.0
const PLAYBACK_RATE_DEFAULT = 1.0

export function getPlaybackRate(): number {
  const v = parseFloat(getStorage(KEYS.PLAYBACK_RATE) ?? String(PLAYBACK_RATE_DEFAULT))
  if (isNaN(v) || v < PLAYBACK_RATE_MIN || v > PLAYBACK_RATE_MAX) return PLAYBACK_RATE_DEFAULT
  return v
}
export function setPlaybackRate(rate: number): void {
  const clamped = Math.min(PLAYBACK_RATE_MAX, Math.max(PLAYBACK_RATE_MIN, rate))
  setStorage(KEYS.PLAYBACK_RATE, String(clamped))
}

/** Alias for addSessionResult — saves a completed session result */
export function saveSessionResult(result: SessionResult): void {
  addSessionResult(result)
  // Update streak
  const today = new Date().toISOString().slice(0, 10)
  const lastActive = getLastActiveDate()
  const yesterdayDate = new Date()
  yesterdayDate.setDate(yesterdayDate.getDate() - 1)
  const yesterday = yesterdayDate.toISOString().slice(0, 10)
  if (lastActive === today) {
    // Already counted today — do nothing
    return
  } else if (lastActive === yesterday) {
    setStreakDays(getStreakDays() + 1)
    setLastActiveDate(today)
  } else {
    setStreakDays(1)
    setLastActiveDate(today)
  }
}
