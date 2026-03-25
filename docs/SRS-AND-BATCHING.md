# SRS and Session Batching Design

## Overview

This document describes the design for two related features added to 美听 (MěiTīng):

1. **Session Batching** — present 20 sentences per session instead of all sentences at once
2. **Spaced Repetition (SRS)** — track per-item performance and schedule future reviews using a simplified SM-2 algorithm

---

## Batch System

### Concept

Instead of showing all sentences for a level in one session, each session presents a **batch of 20 items** (configurable: 10 / 20 / 30). This makes sessions more focused and achievable.

### Item Selection

Each batch is composed as follows:

```
BATCH_SIZE = getBatchSize()  // default 20

reviewDue  = items due for review today (previously seen, SRS scheduled)
unseenIds  = all item IDs not yet seen at this level
newItems   = shuffle(unseenIds)

reviewCount = min(reviewDue.length, floor(BATCH_SIZE * 0.25))  // max 25% review
newCount    = BATCH_SIZE - reviewCount

batch = [...reviewItems[0..reviewCount], ...newItems[0..newCount]]
batch = shuffle(batch)
```

- Review items get at most 25% of slots to keep sessions feeling fresh
- New items fill the remaining slots
- If fewer unseen items remain than `newCount`, use what's available (short final batch)
- If no unseen items **and** no reviews are due → show "level complete" state

### Progress Tracking

- Seen item IDs are stored per-level in localStorage
- Progress is shown as: `N / 957 HSK1 sentences seen`
- A progress bar reflects the fraction seen for that level

### Batch Completion vs Level Completion

- After completing a batch, the app enters `batch-complete` phase
- `complete` phase is only shown when the entire level is exhausted (no unseen items, no reviews due)

---

## Spaced Repetition System (SRS)

### Algorithm: Simplified SM-2

Each item has associated data (`ItemData`) stored in localStorage. The key fields:

| Field        | Description                                    | Default     |
|--------------|------------------------------------------------|-------------|
| `correct`    | Total correct answers                          | `0`         |
| `wrong`      | Total wrong answers                            | `0`         |
| `interval`   | Days until next review                         | `1`         |
| `easeFactor` | SM-2 ease factor (higher = longer intervals)   | `2.5`       |
| `nextReview` | ISO date string for next review                | `1970-01-01`|
| `lastSeen`   | ISO date of last answer                        | (today)     |

### Update Logic

**On correct answer:**
```
interval    = min(round(interval * easeFactor), 180)
easeFactor  = min(2.5, easeFactor + 0.1)
nextReview  = today + interval days
```

**On wrong answer:**
```
interval    = 1
easeFactor  = max(1.3, easeFactor - 0.2)
nextReview  = today + 1 day
```

### Review Scheduling

An item is "due for review" when `nextReview <= today`. These items are eligible to appear in the review slot of a future batch (up to 25% of the batch).

---

## Storage Schema

### New localStorage Keys

| Key pattern                          | Type                       | Description                        |
|--------------------------------------|----------------------------|------------------------------------|
| `meiting_seen_hsk{level}`            | `string` (JSON Set array)  | IDs of items seen at least once    |
| `meiting_item_data_hsk{level}`       | `string` (JSON object)     | Per-item SRS data record           |
| `meiting_batch_size`                 | `string` (number)          | Configurable batch size (10/20/30) |

### ItemData Interface

```ts
interface ItemData {
  correct: number       // total correct answers
  wrong: number         // total wrong answers
  interval: number      // days until next review (SM-2 interval)
  easeFactor: number    // SM-2 ease factor (default 2.5)
  nextReview: string    // ISO date 'YYYY-MM-DD', or '1970-01-01' if new/overdue
  lastSeen: string      // ISO date 'YYYY-MM-DD' of last review
}
```

---

## User-Facing Behavior

### Starting a Session

1. User taps **Start Session**
2. App computes a batch (up to 20 items: mix of new + review-due)
3. Session proceeds as before — audio plays, user answers

### Batch Complete Screen

After completing all items in a batch, the user sees:

```
Session Complete! 🎉

[X / 20 correct]   [accuracy %]
[███████░░░░░░] 180 / 957 HSK1 sentences seen
[🔥 3 day streak]

--- Review Your Misses ---
  • 你好吗？ (nǐ hǎo ma?) — How are you?

[See you tomorrow 👋]    [Keep going → (next 20)]
```

- **See you tomorrow** → navigates to Stats page
- **Keep going** → immediately starts the next batch

### Level Complete Screen

When all items have been seen and no reviews are due:

```
🏆 Level Complete!
You've seen all 957 HSK 1 sentences.
Check back tomorrow for your review session.
```

### Stats Page

A new **Level Progress** card shows:

```
HSK 1: [████████░░░░] 180 / 957 seen  •  82% accuracy
```

### Settings Page

- **Batch Size** segmented control: `10 | 20 | 30`
- **Reset Level Progress** button — clears seen IDs and SRS data for the current HSK level (with confirmation dialog)

---

## Implementation Files

| File                   | Change                                                      |
|------------------------|-------------------------------------------------------------|
| `src/lib/storage.ts`   | New keys, `ItemData` interface, SRS helper functions        |
| `src/pages/Session.tsx`| Batch composition, `batch-complete` phase, missed tracking  |
| `src/pages/Stats.tsx`  | Level Progress card                                         |
| `src/pages/Settings.tsx`| Batch size toggle, Reset Level Progress button             |
| `src/lib/storage.test.ts` | Tests for SRS helpers                                   |
