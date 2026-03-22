// Scoring utilities for typed Chinese answers

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
