// localStorage schema + typed helpers

import type { ContentItem } from './types'

export const KEYS = {
  PREFERRED_VOICE: 'meiting_preferred_voice',
  HSK_LEVEL: 'meiting_hsk_level',
  ANSWER_MODE: 'meiting_answer_mode',
  STREAK_DAYS: 'meiting_streak_days',
  LAST_ACTIVE_DATE: 'meiting_last_active',
  SESSION_HISTORY: 'meiting_history',
  PLAYBACK_RATE: 'meiting_playback_rate',
  BATCH_SIZE: 'meiting_batch_size',
  ACTIVE_BATCH: 'meiting_active_batch',
  ACTIVE_BATCH_TS: 'meiting_active_batch_ts',
  // Dynamic keys (functions, not string constants)
  SEEN_IDS: (level: number) => `meiting_seen_hsk${level}`,
  ITEM_DATA: (level: number) => `meiting_item_data_hsk${level}`,
} as const

export type KeyName = (typeof KEYS)[keyof typeof KEYS]

export interface SessionResult {
  date: string // ISO
  hskLevel: number
  total: number
  correct: number
  answerMode: 'multiple-choice' | 'type' | 'speak'
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

export type AnswerMode = 'multiple-choice' | 'type' | 'speak'
export function getAnswerMode(): AnswerMode {
  const stored = getStorage(KEYS.ANSWER_MODE)
  if (stored === 'multiple-choice' || stored === 'type' || stored === 'speak') {
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
      (item.answerMode === 'multiple-choice' || item.answerMode === 'type' || item.answerMode === 'speak')
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

// ── SRS / Batching ──────────────────────────────────────────────────────────

export interface ItemData {
  correct: number      // total correct answers
  wrong: number        // total wrong answers
  interval: number     // days until next review (SM-2)
  easeFactor: number   // SM-2 ease factor (default 2.5)
  nextReview: string   // ISO date 'YYYY-MM-DD', or '1970-01-01' if new/overdue
  lastSeen: string     // ISO date 'YYYY-MM-DD'
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function addDays(dateISO: string, days: number): string {
  const d = new Date(dateISO + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function getSeenIds(level: number): Set<string> {
  try {
    const data = getStorage(KEYS.SEEN_IDS(level))
    if (!data) return new Set()
    const parsed = JSON.parse(data)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed as string[])
  } catch {
    return new Set()
  }
}

export function markIdsAsSeen(level: number, ids: string[]): void {
  const seen = getSeenIds(level)
  for (const id of ids) seen.add(id)
  setStorage(KEYS.SEEN_IDS(level), JSON.stringify([...seen]))
}

export function resetLevelProgress(level: number): void {
  removeStorage(KEYS.SEEN_IDS(level))
  removeStorage(KEYS.ITEM_DATA(level))
}

export function getItemData(level: number): Record<string, ItemData> {
  try {
    const data = getStorage(KEYS.ITEM_DATA(level))
    if (!data) return {}
    const parsed = JSON.parse(data)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, ItemData>
  } catch {
    return {}
  }
}

export function updateItemData(level: number, id: string, correct: boolean): void {
  const allData = getItemData(level)
  const today = todayISO()
  const existing: ItemData = allData[id] ?? {
    correct: 0,
    wrong: 0,
    interval: 1,
    easeFactor: 2.5,
    nextReview: '1970-01-01',
    lastSeen: today,
  }

  let { interval, easeFactor } = existing

  if (correct) {
    interval = interval === 1 ? 1 : Math.min(Math.round(interval * easeFactor), 180)
    easeFactor = Math.min(2.5, easeFactor + 0.1)
  } else {
    interval = 1
    easeFactor = Math.max(1.3, easeFactor - 0.2)
  }

  allData[id] = {
    correct: existing.correct + (correct ? 1 : 0),
    wrong: existing.wrong + (correct ? 0 : 1),
    interval,
    easeFactor,
    nextReview: addDays(today, interval),
    lastSeen: today,
  }

  setStorage(KEYS.ITEM_DATA(level), JSON.stringify(allData))
}

export function getItemsDueForReview(level: number, allItems: { id: string }[]): string[] {
  const itemData = getItemData(level)
  const seenIds = getSeenIds(level)
  const today = todayISO()
  return allItems
    .filter((item) => seenIds.has(item.id) && itemData[item.id] && itemData[item.id].nextReview <= today)
    .map((item) => item.id)
}

export function getBatchSize(): number {
  const parsed = parseInt(getStorage(KEYS.BATCH_SIZE) ?? '20', 10)
  return isNaN(parsed) ? 20 : parsed
}

export function setBatchSize(n: number): void {
  setStorage(KEYS.BATCH_SIZE, String(n))
}

// ── Active Batch Persistence ─────────────────────────────────────────────────

const ACTIVE_BATCH_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

export interface ActiveBatch {
  items: ContentItem[]
  currentIndex: number
  correctCount: number
  correctMap: Record<string, boolean>
  hskLevel: number
  answerMode: AnswerMode
}

function isValidActiveBatch(value: unknown): value is ActiveBatch {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return (
    Array.isArray(v.items) &&
    typeof v.currentIndex === 'number' &&
    typeof v.correctCount === 'number' &&
    v.correctMap !== null && typeof v.correctMap === 'object' && !Array.isArray(v.correctMap) &&
    typeof v.hskLevel === 'number' &&
    (v.answerMode === 'multiple-choice' || v.answerMode === 'type' || v.answerMode === 'speak')
  )
}

export function getActiveBatch(): ActiveBatch | null {
  try {
    const data = getStorage(KEYS.ACTIVE_BATCH)
    if (!data) return null
    const tsRaw = getStorage(KEYS.ACTIVE_BATCH_TS)
    if (!tsRaw) return null
    const ts = parseInt(tsRaw, 10)
    if (isNaN(ts) || Date.now() - ts > ACTIVE_BATCH_TTL_MS) return null
    const parsed: unknown = JSON.parse(data)
    if (!isValidActiveBatch(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

export function setActiveBatch(batch: ActiveBatch): void {
  setStorage(KEYS.ACTIVE_BATCH, JSON.stringify(batch))
  setStorage(KEYS.ACTIVE_BATCH_TS, String(Date.now()))
}

export function clearActiveBatch(): void {
  removeStorage(KEYS.ACTIVE_BATCH)
  removeStorage(KEYS.ACTIVE_BATCH_TS)
}

// ── Session Results ──────────────────────────────────────────────────────────

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
