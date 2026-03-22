# MěiTīng Content Generation Scripts

These scripts generate the HSK sentence content and audio used by the app.

## Prerequisites

- **Node 20+**
- **Anthropic API key** — set as `ANTHROPIC_API_KEY` env var
- **AWS credentials** — configured via `~/.aws/credentials` or env vars (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`)
  - IAM permissions needed: `polly:SynthesizeSpeech`

## Install dependencies

From the repo root:

```bash
npm install
npm install -D ts-node @types/node @aws-sdk/client-polly @anthropic-ai/sdk
```

## Generate sentences

Generates natural example sentences for each HSK level vocabulary word using the Anthropic API.

```bash
# HSK 1
npx ts-node --project scripts/tsconfig.json scripts/generate.ts --level 1

# HSK 2
npx ts-node --project scripts/tsconfig.json scripts/generate.ts --level 2
```

**Output:** `src/data/hsk[N].json`

### How it works

1. Reads the wordlist from `scripts/wordlists/hsk[N].json`
2. Sends batched requests to Anthropic (50 words per request) asking for 3 sentences per word
3. Parses and validates the JSON response
4. Assigns IDs (`hsk1-s-0001`, `hsk1-s-0002`, ...) and picks distractors from within the batch
5. Merges with existing data — **already-generated sentences are never overwritten**

### Idempotency

Run it multiple times safely. It tracks which sentence characters already exist in the output file and skips them. If it fails partway through, run it again to pick up where it left off.

## Generate audio

Generates MP3 audio for each sentence using AWS Polly (Zhiyu neural voice, Mandarin Chinese).

```bash
# HSK 1
npx ts-node --project scripts/tsconfig.json scripts/audio.ts --level 1

# HSK 2
npx ts-node --project scripts/tsconfig.json scripts/audio.ts --level 2
```

**Output:** `public/audio/hsk[N]-s-[NNNN].mp3` (one file per sentence)

Updates the `audio` field in `src/data/hsk[N].json` to `/audio/{id}.mp3`.

### How it works

1. Reads `src/data/hsk[N].json`
2. For each item where `audio` is missing OR the file doesn't exist, calls Polly
3. Saves the MP3 and updates the JSON immediately (progress preserved on failure)
4. Uses Zhiyu neural voice (`cmn-CN`) for natural-sounding Mandarin

### Idempotency

Run it multiple times safely. Items with `audio` set AND the file present are skipped entirely.

## File layout

```
scripts/
  generate.ts          ← sentence generation script
  audio.ts             ← audio generation script
  tsconfig.json        ← TypeScript config for scripts
  README.md            ← this file
  wordlists/
    hsk1.json          ← HSK 1 vocabulary (incremental)
    hsk2.json          ← HSK 2 vocabulary (new words only)
    hsk3.json          ← (add future levels here)

src/data/
  hsk1.json            ← generated sentence content (HSK 1)
  hsk2.json            ← generated sentence content (HSK 2)

public/audio/
  hsk1-s-0001.mp3      ← generated MP3 files
  hsk1-s-0002.mp3
  ...
```

## Adding a new HSK level

1. Create `scripts/wordlists/hsk[N].json` with the incremental vocabulary:
   ```json
   [
     { "characters": "词语", "pinyin": "cíyǔ", "english": "word; vocabulary" },
     ...
   ]
   ```
2. Run: `npx ts-node --project scripts/tsconfig.json scripts/generate.ts --level N`
3. Run: `npx ts-node --project scripts/tsconfig.json scripts/audio.ts --level N`
4. Commit `src/data/hsk[N].json` and `public/audio/hsk[N]-s-*.mp3`

## Cost estimates

See [docs/PLAN.md](../docs/PLAN.md) for detailed cost estimates.

**Rough estimates for reference:**
- Anthropic API (claude-sonnet): ~$3–5 per HSK level (depends on word count × 3 sentences each)
- AWS Polly neural: ~$16 per 1 million characters. For 1,500 sentences averaging 10 characters each = ~$0.24 per level.

Total to generate all HSK 1–6 content: approximately **$20–35** one-time cost.

## Notes

- Generated content is committed to the repo — no runtime API calls from the app
- The app serves pre-generated JSON from `src/data/` and MP3s from `public/audio/`
- Audio files can be large — consider git-lfs for `public/audio/` if the repo grows
