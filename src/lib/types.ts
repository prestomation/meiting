// Shared domain types used across multiple modules

import type { VoiceProvider } from './storage'

export interface ContentItem {
  id: string
  hsk: number
  type: 'sentence'
  characters: string
  pinyin: string
  english: string
  // Audio URLs keyed by voice provider, e.g. { 'polly-zhiyu': url, 'elevenlabs-haoran': url }.
  // Partial: a voice is present only once its audio has been generated.
  audio?: Partial<Record<VoiceProvider, string>>
  distractors: string[]
}
