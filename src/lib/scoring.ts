// Scoring utilities for typed Chinese answers
import { pinyin } from 'pinyin-pro'

// Normalize: trim, strip Chinese/English punctuation, normalize full-width chars
export function normalize(text: string): string {
  return text
    .trim()
    // Normalize full-width ASCII chars to half-width
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    // Strip Chinese punctuation
    .replace(/[。，、；：！？「」『』【】〔〕〈〉《》〖〗""''…—～·]/g, '')
    // Strip common English punctuation
    .replace(/[.,;:!?'"()\[\]{}\-_]/g, '')
    // Collapse whitespace
    .replace(/\s+/g, '')
    .toLowerCase()
}

// LCS-based character overlap ratio: matching chars as subsequence / correct.length
export function scoreAnswer(input: string, correct: string): number {
  const a = normalize(input)
  const b = normalize(correct)

  if (b.length === 0) return a.length === 0 ? 1 : 0
  if (a.length === 0) return 0

  // Build LCS length table
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  return dp[m][n] / b.length
}

export type AnswerResult = 'correct' | 'close' | 'incorrect'

export function checkAnswer(input: string, correct: string): AnswerResult {
  const score = scoreAnswer(input, correct)
  if (score >= 1.0) return 'correct'
  if (score >= 0.7) return 'close'
  return 'incorrect'
}

/** Calculate accuracy as a percentage (0–100) */
export function calcAccuracy(correct: number, total: number): number {
  if (total === 0) return 0
  return Math.round((correct / total) * 100)
}

/**
 * Convert Chinese text to an array of pinyin syllables (tone-stripped, lowercase)
 * e.g. "你好吗" → ["ni", "hao", "ma"]
 */
export function toPinyinSyllables(text: string): string[] {
  const normalized = normalize(text)
  if (normalized.length === 0) return []
  const result = pinyin(normalized, {
    toneType: 'none',
    type: 'array',
    nonZh: 'removed',
  })
  return result.filter((s) => s.length > 0)
}

/**
 * Phonetic similarity score: LCS of pinyin syllables / correct syllable count
 * e.g. ["ni","hao"] vs ["ni","hao","ma"] → LCS=2, score=2/3=0.67
 */
export function scorePhonetic(input: string, correct: string): number {
  const a = toPinyinSyllables(input)
  const b = toPinyinSyllables(correct)
  if (b.length === 0) return a.length === 0 ? 1 : 0
  if (a.length === 0) return 0

  const m = a.length,
    n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[m][n] / b.length
}

/**
 * Check phonetic answer: uses syllable LCS scoring
 * Same thresholds as checkAnswer: correct=1.0, close>=0.7, incorrect<0.7
 */
export function checkPhoneticAnswer(input: string, correct: string): AnswerResult {
  const score = scorePhonetic(input, correct)
  if (score >= 1.0) return 'correct'
  if (score >= 0.7) return 'close'
  return 'incorrect'
}
