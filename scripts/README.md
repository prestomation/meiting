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

Audio generation normally runs in **GitHub Actions**, not locally — the
Cloudflare/AWS/ElevenLabs secrets live in the repo, so development can happen in
environments that don't hold any secrets. See
[`.github/workflows/generate-audio.yml`](../.github/workflows/generate-audio.yml).

The same script can be run locally if you do have the secrets:

```bash
# Per level AND voice
npx ts-node --project scripts/tsconfig.json scripts/audio.ts --level 1 --voice polly-zhiyu
npx ts-node --project scripts/tsconfig.json scripts/audio.ts --level 1 --voice elevenlabs-haoran

# Cap NEW syntheses per run while testing (cache hits don't count; 0 = unlimited)
npx ts-node --project scripts/tsconfig.json scripts/audio.ts --level 1 --voice elevenlabs-haoran --limit 10
```

`--limit N` stops after N new files are synthesized; remaining items are picked
up on the next run. The workflow exposes this as a `limit` input (default `10`
while testing) — raise it or set `0` once you're happy.

**Output:** MP3s uploaded to Cloudflare R2. The public URL is written into the
per-voice `audio` map in `src/data/hsk[N].json`:

```json
"audio": {
  "polly-zhiyu": "https://pub-xxx.r2.dev/polly-zhiyu-<hash>.mp3",
  "elevenlabs-haoran": "https://pub-xxx.r2.dev/elevenlabs-haoran-<hash>.mp3"
}
```

### Content-addressed caching (never generate the same file twice)

The R2 object key is a SHA-256 hash over the voice **recipe** + sentence text
(see [`scripts/lib/voices.ts`](lib/voices.ts)). The recipe pins every input that
changes the output bytes — voice, model/engine, output format, **sample rate**,
voice settings. Consequences:

- Identical recipe + text → identical key → permanent cache hit.
- Any knob changes (e.g. sample rate) → new key → regenerates.
- Edited sentence text → new key → stale audio auto-invalidated.
- Duplicate sentences dedupe automatically, even across levels.

Per item the generator: (1) skips if the JSON already records the expected URL;
(2) else does a cheap R2 `HEAD` and reuses the object if it already exists;
(3) else synthesizes, uploads, and records the URL. Re-runs are cheap no-ops.

### GitHub Actions workflow

`generate-audio.yml` triggers on pushes that touch `src/data/hsk*.json` (any
branch) and via manual `workflow_dispatch` (pick a level + voice). It runs the
generator for the relevant level × voice combinations and commits the updated
`audio` URLs back to the branch with `[skip ci]`.

**Repo secrets required:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_R2_PUBLIC_BASE`, `CLOUDFLARE_R2_BUCKET` (optional),
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `ELEVENLABS_API_KEY`.

## File layout

```
scripts/
  generate.ts          ← sentence generation script
  audio.ts             ← recipe-driven audio generator (--level, --voice)
  migrate-audio-map.ts ← one-time: string audio → per-voice audio map
  validate-content.ts  ← CI guard for content data integrity
  lib/
    voices.ts          ← voice recipes + content-addressed cache keys
  tsconfig.json        ← TypeScript config for scripts
  README.md            ← this file
  wordlists/
    hsk1.json          ← HSK 1 vocabulary (incremental)
    hsk2.json          ← HSK 2 vocabulary (new words only)
    hsk3.json          ← (add future levels here)

src/data/
  hsk1.json            ← generated sentence content + per-voice audio URLs (HSK 1)
  hsk2.json            ← generated sentence content + per-voice audio URLs (HSK 2)

# Audio MP3s are hosted on Cloudflare R2, not committed to the repo.
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
3. Commit `src/data/hsk[N].json`. Pushing it triggers the **Generate Audio**
   workflow, which fills in the audio URLs for each voice and commits them back.
   (Or run `scripts/audio.ts --level N --voice <voice>` locally if you have the secrets.)

## Cost estimates

See [docs/PLAN.md](../docs/PLAN.md) for detailed cost estimates.

**Rough estimates for reference:**
- Anthropic API (claude-sonnet): ~$3–5 per HSK level (depends on word count × 3 sentences each)
- AWS Polly neural: ~$16 per 1 million characters. For 1,500 sentences averaging 10 characters each = ~$0.24 per level.

Total to generate all HSK 1–6 content: approximately **$20–35** one-time cost.

## Notes

- Generated content is committed to the repo — no runtime API calls from the app
- The app serves pre-generated JSON from `src/data/`; MP3s are served from Cloudflare R2
- Audio is content-addressed in R2, so identical sentences/voices are never stored twice
