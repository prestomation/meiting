# HSK 3 Content Generation Plan

> Plan to generate the next HSK level (HSK 3) for MěiTīng. HSK 1 and HSK 2 are
> already shipped; HSK 3 is the next level to add.

## Status

- [x] Wordlist (already authoritative, 973 words)
- [x] Sentences generated — **1,909 sentences** via the subagent pipeline (98.8% vocab pass rate)
- [x] HSK 3 registered in the app (Settings / Session / Stats)
- [x] Build + 62 unit tests green
- [ ] **Audio** — run the Generate Audio workflow (`level: 3, voice: all, limit: 0`); CI content-validation is red until these URLs are committed back

## Current state

| Level | Wordlist | Sentence data (`src/data`) | Audio | App-registered |
|-------|----------|----------------------------|-------|----------------|
| HSK 1 | ✅ 500 words | ✅ 957 sentences | ✅ | ✅ |
| HSK 2 | ✅ 772 words | ✅ 1389 sentences | ✅ | ✅ |
| **HSK 3** | ✅ **973 words** (`scripts/wordlists/hsk3.json`) | ❌ none | ❌ | ❌ |

The HSK 3 wordlist is **already present and authoritative** (built by
`scripts/build-wordlists.py` from the HSK 3.0 standard), so no wordlist work is
needed. Everything downstream of the wordlist still has to be produced.

Estimated output: ~973 words × 2 sentences ≈ **1,600–1,900 sentences** after
vocabulary-validation rejects and dedupe (HSK 2 yielded ~1.8 sentences/word).

## How the pipeline works (recap)

1. **Sentence generation is subagent-driven — no API key.**
   `scripts/emit-batches.ts --level 3` splits `wordlists/hsk3.json` into 50-word
   batches and writes one prompt per batch under `scripts/.work/hsk3/`. Claude
   Code runs each prompt through a subagent (these replace the old Anthropic API
   call), saving a JSON array to the matching `raw/batch-NN.json`.
   `scripts/assemble.ts --level 3` then validates every sentence against the
   **cumulative** allowed-character set for levels 1–3 (`vocab.ts →
   buildAllowedChars(3)`, limit **16 chars**), drops out-of-vocab/too-long ones,
   dedupes, assigns IDs (`hsk3-s-0001…`), and picks 3 phonetic distractors per
   sentence. Idempotent — safe to re-run; it skips sentences already in the file.
2. Pushing `src/data/hsk3.json` triggers the **Generate Audio** workflow, which
   synthesizes Polly + ElevenLabs MP3s, uploads them to Cloudflare R2
   (content-addressed), and commits the `audio` URL map back to the branch.
3. The app must be told the level exists (three small code edits).
4. CI (`validate-content.ts`) gates merge: **every** item needs a valid R2 URL
   for the default voice (`elevenlabs-haoran`) plus non-empty text and ≥3
   distractors.

## Steps

### 1. Generate sentences  *(requires `ANTHROPIC_API_KEY`)*

```bash
npm install
npx ts-node --project scripts/tsconfig.json scripts/generate.ts --level 3
```

- Output: `src/data/hsk3.json` (~1,600–1,900 items, no audio yet).
- Cost: ~$3–5 of Anthropic usage (rough, per README).
- **Note:** this needs an API key, which dev/web sessions may not hold. If the
  key is unavailable here, this step runs locally or in a key-equipped CI job;
  the rest of the plan assumes the JSON exists.
- Spot-check a sample after generation: natural sentences, correct pinyin tone
  marks, sensible English, no obvious out-of-level characters slipping through.

### 2. Register HSK 3 in the app (3 edits)

- `src/pages/Settings.tsx:20` — add `3` to `AVAILABLE_HSK_LEVELS` (`[1, 2]` → `[1, 2, 3]`).
- `src/pages/Session.tsx:26-33` — `import hsk3Data from '../data/hsk3.json'` and add `3: hsk3Data as ContentItem[]` to the level→data map.
- `src/pages/Stats.tsx:2-8` — import `hsk3Data` and add `3: (hsk3Data as { id: string }[]).length` to the totals map.

These are mechanical and can land in the same PR as the data.

### 3. Generate audio  *(GitHub Actions — secrets live in the repo)*

Pushing `hsk3.json` auto-triggers `generate-audio.yml`, **but the push event
defaults to `limit: 10` new files per level/voice** — far too slow for ~1,800
sentences. So after the data is on the branch, manually dispatch the workflow
with no cap:

- Run **Generate Audio** via `workflow_dispatch` → `level: 3`, `voice: all`,
  `limit: 0` (unlimited). It synthesizes both voices, uploads to R2, and commits
  the audio URLs back to this branch.
- Cost: ~$0.24 Polly + ElevenLabs credits per level (rough).
- Re-runs are cheap no-ops (content-addressed caching).

### 4. Validate & verify

```bash
npm test
npm run build
npx ts-node scripts/validate-content.ts   # must pass — gates merge
```

- `validate-content.ts` will **fail until step 3 has filled every default-voice
  audio URL** — this is expected; it's the merge gate. Sequence accordingly:
  generate data → register in app → run audio workflow → confirm validation
  green → mark PR ready.
- Manually exercise an HSK 3 session in the running app (`npm run dev`): audio
  plays, multiple-choice distractors render, type-to-answer scoring works.

### 5. Open / finalize PR

- Draft PR with `src/data/hsk3.json` + the 3 app edits.
- Let the audio workflow commit URLs back to the branch.
- Once CI (tests, build, content validation) is green, mark ready for review.

## Sequencing summary

```
wordlist (done) → generate.ts → src/data/hsk3.json
                                      │
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
     register in 3 files     push triggers audio      (CI red until audio
     (Settings/Session/Stats)  workflow_dispatch        URLs committed)
                                limit:0, voice:all
                                      │
                                      ▼
                            audio URLs committed → CI green → ready
```

## Risks / watch-outs

- **API key availability** for `generate.ts` — the one hard external dependency.
- **Audio limit default of 10** on the push trigger — must dispatch with
  `limit: 0` or audio fills in 10-at-a-time across many runs.
- **CI is red by design** between data-commit and audio-commit; don't mistake it
  for a broken build — keep the PR in draft until audio lands.
- **Pool size for distractors** is fine at HSK 3 volume (needs ≥4 items).
- **Cumulative vocabulary** means HSK 3 sentences may reuse HSK 1–2 characters —
  intended; validation already accounts for it.

## Out of scope

- Generating HSK 4–6 (wordlists exist; same process, future PRs).
- Wordlist rebuilds (`build-wordlists.py`) — HSK 3 list is already authoritative.
