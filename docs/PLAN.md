# MěiTīng (美听) — Product Plan

> A fully static Chinese listening practice app. Deployed on Cloudflare Pages. No backend.

---

## Vision

Users select their HSK level, hear audio clips, and answer — either by picking from multiple choice options or typing the characters they heard. The app tracks streaks, accuracy, and session history entirely in localStorage. Content is pre-generated at build time using an LLM and pre-rendered audio via AWS Polly.

---

## Build Order

### ✅ Phase 1 — Scaffold (this PR)
- Vite + React + TypeScript
- React Router with placeholder pages
- Working Voice Test page (browser TTS + Polly samples)
- `tts.ts`, `storage.ts`, `scoring.ts` libraries
- Cloudflare Pages deploy (native GitHub integration)
- GitHub Pages deploy workflow (backup)

### 🔜 Phase 2 — Content Generation
- HSK wordlist data (New HSK 1–9)
- `scripts/generate.ts` — calls Anthropic API to produce sentences/dialogues per level
- `scripts/audio.ts` — calls AWS Polly to generate MP3 per content item
- Output: `src/data/hsk[1-9].json` + `public/audio/*.mp3`
- Idempotent (skips existing items)

### 🔜 Phase 3 — Session Page (core loop)
- Load items for selected HSK level
- Play audio via preferred voice (browser TTS or Polly MP3 if available)
- Answer modes:
  - **Multiple choice**: 4 汉字 options, tap to answer
  - **Type it**: Input field for 汉字, fuzzy match scoring
    - ≥70% character overlap → "你快到了！" hint, try again
    - 100% → correct
- Next item, repeat

### 🔜 Phase 4 — Scoring & Storage
- Per-session tracking: total, correct, answer mode, HSK level
- Daily streak: consecutive calendar days with ≥1 session
- Session streak: consecutive correct answers (current run)
- Save `SessionResult` to localStorage on completion

### 🔜 Phase 5 — Stats Page
- Daily streak with flame icon
- All-time accuracy % by HSK level
- Session history (last N sessions)
- Streak calendar (GitHub-style heatmap optional)

### 🔜 Phase 6 — Settings Page
- HSK level selector (1–9)
- Answer mode preference (multiple choice / type)
- Preferred voice (carries over from Voice Test page)
- Reset progress option

### 🔜 Phase 7 — Polish & Extras
- Mobile-first responsive design
- Chinese character input method hints
- Google login + cloud sync (future)
- Cloudflare R2 for audio if file count grows beyond CF Pages limits

---

## Content Schema

Each content item in `src/data/hsk[N].json`:

```json
{
  "id": "hsk2-sentence-017",
  "hsk": 2,
  "type": "word | sentence | dialogue",
  "characters": "你好吗？",
  "pinyin": "nǐ hǎo ma?",
  "english": "How are you?",
  "audio": "audio/hsk2-sentence-017.mp3",
  "distractors": ["你在哪里？", "谢谢你。", "再见！"]
}
```

- **word**: single HSK vocabulary item
- **sentence**: example sentence using level-appropriate vocabulary
- **dialogue**: short 2-line exchange, played as one clip
- **distractors**: 3 wrong answers for multiple choice — plausible but clearly different meaning

---

## Answer Scoring

### Multiple Choice
- Exact match only (character string comparison)
- Correct on first try → full score
- Wrong → reveal correct answer, mark incorrect

### Type It
- Normalize input (trim whitespace, full-width → half-width punctuation)
- Score = `matchingChars / totalChars` using longest common subsequence
- `score >= 0.70` → hint "你快到了！Try again" — one retry allowed
- `score == 1.0` → correct
- `score < 0.70` after retry → incorrect, reveal answer

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | React + Vite + TypeScript | Ecosystem maturity, easy Google login later |
| Routing | React Router v6 | Standard |
| Styling | TBD (CSS modules or Tailwind) | Decide in Phase 3 |
| State | localStorage only | No backend needed |
| Audio | Browser TTS + Polly MP3s | Polly for quality, browser TTS as fallback |
| Deploy | Cloudflare Pages | Free, fast, native PR previews |
| Content gen | Anthropic API (claude-sonnet) | Cost-effective, good Chinese output |
| Audio gen | AWS Polly (Zhiyu neural) | Only quality Mandarin neural voice |

---

## Audio Strategy

Pre-generate all audio at build time. Commit MP3s to the repo.

**Why commit MP3s:**
- Zero runtime cost
- Works offline
- No CDN complexity at current scale
- ~30KB per file × 1,000 items = ~30MB — well within GitHub/CF limits

**When to move to R2:**
- File count approaches 20,000 (CF Pages limit)
- Repo size becomes unwieldy (>500MB)

---

## Cloudflare Pages Limits

| Limit | Free Tier | Notes |
|---|---|---|
| Builds/month | 500 | ~16/day — very comfortable |
| Build timeout | 20 min | Fine for `npm run build` |
| Files per deploy | 20,000 | Key limit for MP3s — see below |
| Max file size | 25 MiB | No single MP3 will be near this |
| Custom domains | 100 | Way more than needed |
| Bandwidth | Unlimited | No cap |

**File count math for audio:**
- 1,000 content items × 1 MP3 = 1,000 files → well under 20k limit
- 5,000 items × 1 MP3 = 5,000 files → still fine
- 15,000 items × 1 MP3 → approaching limit, migrate to R2

---

## AWS Polly — Voice Options & Pricing

### Mandarin Chinese Voices

| Voice | Engine | Gender | Quality |
|---|---|---|---|
| **Zhiyu** (neural) | Neural | Female | ⭐ Best available — natural, clear |
| **Zhiyu** (standard) | Standard | Female | Noticeably more robotic |

**Polly currently has only one Mandarin voice (Zhiyu).** Neural is significantly better. No male Mandarin neural voice exists yet.

### Pricing (outside free tier)

| Engine | Price per 1M characters |
|---|---|
| Standard | $4.00 |
| Neural | $19.20 |
| Long-form | $100.00 |

### Free Tier
- 5 million characters/month free for 12 months (standard)
- 1 million characters/month free for 12 months (neural)

### Cost Estimates for MěiTīng

Assume average content item = ~20 characters (a short sentence).

| Items | Characters | Neural Cost | Standard Cost |
|---|---|---|---|
| 100 items | ~2,000 chars | ~$0.04 | ~$0.01 |
| 500 items | ~10,000 chars | ~$0.19 | ~$0.04 |
| 1,000 items | ~20,000 chars | ~$0.38 | ~$0.08 |
| 5,000 items | ~100,000 chars | ~$1.92 | ~$0.40 |
| 20,000 items | ~400,000 chars | ~$7.68 | ~$1.60 |

**Conclusion: Polly costs are negligible.** Even 5,000 items with neural voices costs under $2 total, and the free tier covers the first ~50,000 items (neural) easily. Generate neural, no need to cut corners.

### Alternatives to Polly

| Service | Mandarin Quality | Price | Notes |
|---|---|---|---|
| AWS Polly Zhiyu Neural | ⭐⭐⭐⭐ | $19.20/1M chars | Only real option for quality Mandarin |
| Google Cloud TTS (WaveNet) | ⭐⭐⭐⭐ | $16.00/1M chars | Comparable quality, slightly cheaper |
| Google Cloud TTS (Standard) | ⭐⭐ | $4.00/1M chars | Similar to Polly standard |
| Azure Cognitive Speech (Neural) | ⭐⭐⭐⭐ | $15.00/1M chars | Good Mandarin options, more voices |
| ElevenLabs | ⭐⭐⭐⭐⭐ | ~$330/1M chars | Overkill, very expensive |
| Browser TTS | ⭐⭐ (varies) | Free | Inconsistent, device-dependent |

**Recommendation:** Stick with Polly Zhiyu Neural. It's the best Mandarin voice we can automate at build time, and costs are trivial. If we want a male voice or more variety later, Google Cloud TTS or Azure are the next stops.

---

## Content Generation Plan (Phase 2)

### Input
- HSK wordlists (New HSK 1–9, bundled as JSON)
- Per level: ~150–300 vocab items

### LLM Generation (Anthropic)
For each HSK level, prompt claude-sonnet to generate:
1. **Words**: pinyin + English gloss for each vocab item (already in HSK data)
2. **Sentences**: 3–5 sentences per word using only level-appropriate vocabulary
3. **Distractors**: 3 plausible wrong answers per item (same HSK level, different meaning)
4. **Dialogues**: short 2-line exchanges (one per ~5 words)

### Audio Generation (Polly)
For each generated item, call Polly Zhiyu Neural → save as `public/audio/{id}.mp3`

### Script Design
```
scripts/
├── generate.ts      # LLM content generation → src/data/hsk[N].json
├── audio.ts         # Polly audio generation → public/audio/*.mp3
├── wordlists/       # Raw HSK 1-9 wordlist data
└── README.md        # How to run
```

Both scripts are idempotent — skip items that already have generated output. Safe to re-run after adding new vocab.

---

## Repository Layout (target)

```
/
├── docs/
│   └── PLAN.md             # This file
├── public/
│   ├── audio/              # Generated MP3s (committed)
│   └── samples/            # Polly voice samples for test page
├── scripts/
│   ├── generate.ts
│   ├── audio.ts
│   ├── wordlists/
│   └── README.md
├── src/
│   ├── data/               # Generated JSON content
│   ├── pages/
│   │   ├── VoiceTest.tsx
│   │   ├── Settings.tsx
│   │   ├── Session.tsx
│   │   └── Stats.tsx
│   ├── components/
│   │   └── Nav.tsx
│   └── lib/
│       ├── tts.ts
│       ├── scoring.ts
│       └── storage.ts
├── .github/workflows/
│   └── deploy.yml          # GitHub Pages (backup deploy)
└── README.md
```
