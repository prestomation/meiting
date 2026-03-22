// Scoring utilities — stubs for future implementation

export interface ScoreResult {
  correct: boolean
  partialCredit?: number // 0–1 for partial match
}

/** Compare a typed answer to the expected answer (exact match for now) */
export function scoreTypedAnswer(input: string, expected: string): ScoreResult {
  return { correct: input.trim() === expected.trim() }
}

/** Calculate accuracy as a percentage (0–100) */
export function calcAccuracy(correct: number, total: number): number {
  if (total === 0) return 0
  return Math.round((correct / total) * 100)
}
