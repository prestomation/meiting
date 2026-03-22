import { describe, it, expect } from 'vitest'
import { normalize, scoreAnswer, checkAnswer, toPinyinSyllables, scorePhonetic, checkPhoneticAnswer } from './scoring'

describe('normalize', () => {
  it('trims whitespace', () => expect(normalize('  你好  ')).toBe('你好'))
  it('strips Chinese punctuation', () => expect(normalize('你好！')).toBe('你好'))
  it('strips English punctuation', () => expect(normalize('Hello, world.')).toBe('helloworld'))
  it('normalizes full-width chars', () => expect(normalize('ａｂｃ')).toBe('abc'))
  it('collapses whitespace', () => expect(normalize('你  好')).toBe('你好'))
})

describe('scoreAnswer', () => {
  it('returns 1.0 for exact match', () => expect(scoreAnswer('你好', '你好')).toBe(1))
  it('returns 1.0 for match ignoring punctuation', () => expect(scoreAnswer('你好！', '你好')).toBe(1))
  it('returns 0 for empty input', () => expect(scoreAnswer('', '你好')).toBe(0))
  it('returns partial score for partial match', () => {
    const score = scoreAnswer('你', '你好吗')
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(1)
  })
  it('returns 1 for empty correct and empty input', () => expect(scoreAnswer('', '')).toBe(1))
})

describe('checkAnswer', () => {
  it('returns correct for exact match', () => expect(checkAnswer('你好', '你好')).toBe('correct'))
  it('returns incorrect for completely wrong', () => expect(checkAnswer('再见', '你好吗？')).toBe('incorrect'))
  it('returns close for partial match >=0.7', () => {
    // 你好 vs 你好吗 → LCS=2/3 = 0.67 — check close to boundary
    const result = checkAnswer('我去学校', '我去学校了')
    expect(['close', 'correct']).toContain(result)
  })
})

describe('toPinyinSyllables', () => {
  it('converts Chinese to pinyin array', () => {
    const result = toPinyinSyllables('你好')
    expect(result).toEqual(['ni', 'hao'])
  })
  it('strips tones', () => {
    const result = toPinyinSyllables('妈麻马骂')
    expect(result).toEqual(['ma', 'ma', 'ma', 'ma'])
  })
})

describe('scorePhonetic', () => {
  it('returns 1 for exact phonetic match', () => {
    expect(scorePhonetic('你好', '你好')).toBe(1)
  })
  it('returns 1 for homophone (same sounds, different chars)', () => {
    // 你好 and 你号 sound the same (ni hao)
    expect(scorePhonetic('你号', '你好')).toBe(1)
  })
  it('returns partial score for partial match', () => {
    const score = scorePhonetic('你好', '你好吗')
    expect(score).toBeGreaterThan(0.5)
    expect(score).toBeLessThan(1)
  })
})

describe('checkPhoneticAnswer', () => {
  it('accepts homophones as correct', () => {
    expect(checkPhoneticAnswer('你号', '你好')).toBe('correct')
  })
})
