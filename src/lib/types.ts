// Shared domain types used across multiple modules

export interface ContentItem {
  id: string
  hsk: number
  type: 'sentence'
  characters: string
  pinyin: string
  english: string
  audio?: string
  distractors: string[]
}
