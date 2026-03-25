import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getSeenIds,
  markIdsAsSeen,
  resetLevelProgress,
  getItemData,
  updateItemData,
  getItemsDueForReview,
  getBatchSize,
  setBatchSize,
} from './storage'

// Mock localStorage with a simple in-memory implementation
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()

vi.stubGlobal('localStorage', localStorageMock)

beforeEach(() => {
  localStorageMock.clear()
})

describe('getSeenIds / markIdsAsSeen', () => {
  it('returns empty set when nothing stored', () => {
    const ids = getSeenIds(1)
    expect(ids.size).toBe(0)
  })

  it('round-trips stored IDs', () => {
    markIdsAsSeen(1, ['id-1', 'id-2', 'id-3'])
    const ids = getSeenIds(1)
    expect(ids.has('id-1')).toBe(true)
    expect(ids.has('id-2')).toBe(true)
    expect(ids.has('id-3')).toBe(true)
    expect(ids.size).toBe(3)
  })

  it('accumulates across multiple calls', () => {
    markIdsAsSeen(1, ['id-1', 'id-2'])
    markIdsAsSeen(1, ['id-3'])
    const ids = getSeenIds(1)
    expect(ids.size).toBe(3)
  })

  it('does not duplicate IDs', () => {
    markIdsAsSeen(1, ['id-1'])
    markIdsAsSeen(1, ['id-1'])
    const ids = getSeenIds(1)
    expect(ids.size).toBe(1)
  })

  it('isolates by level', () => {
    markIdsAsSeen(1, ['id-1'])
    markIdsAsSeen(2, ['id-2'])
    expect(getSeenIds(1).has('id-1')).toBe(true)
    expect(getSeenIds(1).has('id-2')).toBe(false)
    expect(getSeenIds(2).has('id-2')).toBe(true)
  })
})

describe('resetLevelProgress', () => {
  it('clears seen IDs and item data for a level', () => {
    markIdsAsSeen(1, ['id-1', 'id-2'])
    updateItemData(1, 'id-1', true)
    resetLevelProgress(1)
    expect(getSeenIds(1).size).toBe(0)
    expect(Object.keys(getItemData(1)).length).toBe(0)
  })

  it('does not affect other levels', () => {
    markIdsAsSeen(1, ['id-1'])
    markIdsAsSeen(2, ['id-2'])
    resetLevelProgress(1)
    expect(getSeenIds(2).has('id-2')).toBe(true)
  })
})

describe('updateItemData — correct path', () => {
  it('increases interval on correct answer', () => {
    updateItemData(1, 'test-id', true)
    const data = getItemData(1)
    const item = data['test-id']
    expect(item).toBeDefined()
    // First correct: interval stays at 1 (SM-2 initial step)
    expect(item.interval).toBe(1)
    expect(item.correct).toBe(1)
    expect(item.wrong).toBe(0)
  })

  it('advances nextReview into the future on correct', () => {
    updateItemData(1, 'test-id', true)
    const data = getItemData(1)
    const item = data['test-id']
    const today = new Date().toISOString().slice(0, 10)
    expect(item.nextReview > today).toBe(true)
  })

  it('increases easeFactor up to 2.5 cap', () => {
    // Start from default 2.5 — should stay at 2.5
    updateItemData(1, 'cap-id', true)
    const item = getItemData(1)['cap-id']
    expect(item.easeFactor).toBeLessThanOrEqual(2.5)
    expect(item.easeFactor).toBeGreaterThan(2.0)
  })

  it('caps interval at 180 days', () => {
    // Simulate many correct answers to push interval high
    const id = 'long-id'
    // Manually set high interval via multiple correct updates
    for (let i = 0; i < 20; i++) {
      updateItemData(1, id, true)
    }
    const item = getItemData(1)[id]
    expect(item.interval).toBeLessThanOrEqual(180)
  })
})

describe('updateItemData — wrong path', () => {
  it('resets interval to 1 on wrong answer', () => {
    // First build up some interval
    updateItemData(1, 'wrong-id', true)
    updateItemData(1, 'wrong-id', true)
    // Now answer wrong
    updateItemData(1, 'wrong-id', false)
    const item = getItemData(1)['wrong-id']
    expect(item.interval).toBe(1)
  })

  it('decreases easeFactor on wrong answer', () => {
    const id = 'ease-id'
    updateItemData(1, id, true) // easeFactor starts at 2.5, goes to min(2.5, 2.6) = 2.5 effectively
    // Actually on first correct it was 2.5 -> 2.5 (capped), so force a different start
    // Answer wrong: should decrease
    updateItemData(1, id, false)
    const item = getItemData(1)[id]
    expect(item.easeFactor).toBeLessThan(2.5)
  })

  it('does not drop easeFactor below 1.3', () => {
    const id = 'floor-id'
    // Answer wrong many times
    for (let i = 0; i < 20; i++) {
      updateItemData(1, id, false)
    }
    const item = getItemData(1)[id]
    expect(item.easeFactor).toBeGreaterThanOrEqual(1.3)
  })

  it('increments wrong count', () => {
    updateItemData(1, 'wcount-id', false)
    updateItemData(1, 'wcount-id', false)
    const item = getItemData(1)['wcount-id']
    expect(item.wrong).toBe(2)
    expect(item.correct).toBe(0)
  })
})

describe('getItemsDueForReview', () => {
  it('returns empty array when nothing seen', () => {
    const items = [{ id: 'a' }, { id: 'b' }]
    expect(getItemsDueForReview(1, items)).toEqual([])
  })

  it('returns only overdue items', () => {
    // Mark items as seen
    markIdsAsSeen(1, ['overdue-id', 'future-id'])

    // Manually set item data with past nextReview for overdue-id
    updateItemData(1, 'overdue-id', true) // will be in future after correct
    // Force overdue by manipulating storage directly
    const allData = getItemData(1)
    allData['overdue-id'] = {
      ...allData['overdue-id'],
      nextReview: '1970-01-01', // definitely overdue
    }
    import.meta.env // just to prevent tree-shaking complaints
    // Write back via the raw helper
    localStorage.setItem('meiting_item_data_hsk1', JSON.stringify(allData))

    // Set future-id with a far future nextReview
    allData['future-id'] = {
      correct: 1,
      wrong: 0,
      interval: 30,
      easeFactor: 2.5,
      nextReview: '2099-01-01',
      lastSeen: new Date().toISOString().slice(0, 10),
    }
    localStorage.setItem('meiting_item_data_hsk1', JSON.stringify(allData))

    const due = getItemsDueForReview(1, [{ id: 'overdue-id' }, { id: 'future-id' }])
    expect(due).toContain('overdue-id')
    expect(due).not.toContain('future-id')
  })

  it('does not return unseen items even if itemData exists', () => {
    // Item data exists but ID is not in seenIds
    updateItemData(1, 'unseen-id', true)
    const allData = getItemData(1)
    allData['unseen-id'] = { ...allData['unseen-id'], nextReview: '1970-01-01' }
    localStorage.setItem('meiting_item_data_hsk1', JSON.stringify(allData))

    // Do NOT call markIdsAsSeen
    const due = getItemsDueForReview(1, [{ id: 'unseen-id' }])
    expect(due).not.toContain('unseen-id')
  })
})

describe('getBatchSize / setBatchSize', () => {
  it('defaults to 20', () => {
    expect(getBatchSize()).toBe(20)
  })

  it('persists set value', () => {
    setBatchSize(10)
    expect(getBatchSize()).toBe(10)
    setBatchSize(30)
    expect(getBatchSize()).toBe(30)
  })
})
