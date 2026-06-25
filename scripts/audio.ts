#!/usr/bin/env ts-node
/**
 * audio.ts — Recipe-driven audio generator for MěiTīng (Polly + ElevenLabs)
 *
 * Reads src/data/hsk[N].json and, for the selected voice, fills in any missing
 * audio. Audio is content-addressed: the R2 object key is a hash over the voice
 * recipe + sentence text (see scripts/lib/voices.ts), so an identical file is
 * never synthesized twice — across runs, levels, or a lost manifest.
 *
 * Cache ladder, per item:
 *   1. JSON already records the expected URL → skip (no network).
 *   2. Object already exists in R2 (HEAD)     → record URL, skip synth.
 *   3. Otherwise                              → synthesize, upload, record URL.
 *
 * Idempotent and resumable: progress is saved periodically and on failure.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/audio.ts --level 1 --voice polly-zhiyu
 *   npx ts-node --project scripts/tsconfig.json scripts/audio.ts --level 1 --voice elevenlabs-haoran
 *
 * Required env vars:
 *   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_R2_PUBLIC_BASE   (R2)
 *   CLOUDFLARE_R2_BUCKET                                  (optional, default: meiting-audio)
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION  (Polly voices only)
 *   ELEVENLABS_API_KEY                                    (ElevenLabs voices only)
 */

import {
  PollyClient,
  SynthesizeSpeechCommand,
  type OutputFormat,
  type TextType,
  type VoiceId,
  type Engine,
  type LanguageCode,
} from '@aws-sdk/client-polly';
import * as fs from 'fs';
import * as path from 'path';
import {
  VOICE_RECIPES,
  audioCacheKey,
  audioIsCurrent,
  type VoiceProvider,
  type PollyRecipe,
  type ElevenLabsRecipe,
} from './lib/voices';

// ---- Types ----

interface ContentItem {
  id: string;
  hsk: number;
  type: 'sentence';
  characters: string;
  pinyin: string;
  english: string;
  audio?: Partial<Record<VoiceProvider, string>>;
  distractors: string[];
}

// ---- Args ----

const VOICES = Object.keys(VOICE_RECIPES) as VoiceProvider[];

function parseArgs(): { level: number; voice: VoiceProvider; limit: number } {
  const args = process.argv.slice(2);

  const levelIndex = args.indexOf('--level');
  const voiceIndex = args.indexOf('--voice');
  if (levelIndex === -1 || !args[levelIndex + 1] || voiceIndex === -1 || !args[voiceIndex + 1]) {
    console.error(
      `Usage: npx ts-node scripts/audio.ts --level <1-9> --voice <${VOICES.join('|')}> [--limit N]`
    );
    process.exit(1);
  }

  const level = parseInt(args[levelIndex + 1], 10);
  if (isNaN(level) || level < 1 || level > 9) {
    console.error('Level must be between 1 and 9');
    process.exit(1);
  }

  const voice = args[voiceIndex + 1] as VoiceProvider;
  if (!VOICES.includes(voice)) {
    console.error(`Unknown voice "${voice}". Valid voices: ${VOICES.join(', ')}`);
    process.exit(1);
  }

  // Optional cap on NEW syntheses per run (0 = unlimited). Cache hits don't count.
  let limit = 0;
  const limitIndex = args.indexOf('--limit');
  if (limitIndex !== -1) {
    limit = parseInt(args[limitIndex + 1], 10);
    if (isNaN(limit) || limit < 0) {
      console.error('--limit must be a non-negative integer (0 = unlimited)');
      process.exit(1);
    }
  }

  return { level, voice, limit };
}

// ---- Paths ----

function getDataPath(level: number): string {
  return path.resolve(__dirname, '..', 'src', 'data', `hsk${level}.json`);
}

// ---- Retry with exponential backoff ----

const MAX_RETRIES = 6;
const BASE_DELAY_MS = 500;
const THROTTLE_BASE_DELAY_MS = 2000; // longer backoff for rate limit errors

function isThrottleError(err: any): boolean {
  return (
    err?.name === 'ThrottlingException' ||
    err?.Code === 'ThrottlingException' ||
    err?.$metadata?.httpStatusCode === 429 ||
    (err?.message ?? '').toLowerCase().includes('throttl') ||
    (err?.message ?? '').toLowerCase().includes('rate exceeded') ||
    (err?.message ?? '').toLowerCase().includes('rate limit')
  );
}

/**
 * Retry fn up to MAX_RETRIES times total. Throttle errors use longer backoff.
 * After MAX_RETRIES attempts, throws — never silently skips.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (attempt === MAX_RETRIES - 1) {
        throw new Error(`${label} failed after ${MAX_RETRIES} attempts: ${err?.message ?? err}`);
      }
      const throttle = isThrottleError(err);
      const base = throttle ? THROTTLE_BASE_DELAY_MS : BASE_DELAY_MS;
      const delay = base * Math.pow(2, attempt) + Math.random() * 200;
      const reason = throttle ? 'throttled' : `error (${(err?.message ?? '').slice(0, 40)})`;
      process.stdout.write(`\n  ⏳ ${reason} — attempt ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay)}ms... `);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(`${label}: unreachable`);
}

// ---- Env ----

function getRequiredEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

// ---- R2 operations ----

interface R2Config {
  token: string;
  accountId: string;
  bucket: string;
  publicBase: string;
}

function r2ObjectUrl(cfg: R2Config, key: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/r2/buckets/${cfg.bucket}/objects/${key}`;
}

/** True if the object already exists in R2 (cache hit), false if absent. */
async function r2ObjectExists(cfg: R2Config, key: string): Promise<boolean> {
  return withRetry(async (): Promise<boolean> => {
    const r = await fetch(r2ObjectUrl(cfg, key), {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    await r.body?.cancel();
    if (r.status === 200) return true;
    if (r.status === 404) return false;
    if (r.status === 429) {
      const err: any = new Error('R2 rate limit');
      err.name = 'ThrottlingException';
      throw err;
    }
    throw new Error(`R2 HEAD failed for ${key}: HTTP ${r.status} (${r.statusText})`);
  }, `R2-HEAD:${key}`);
}

async function uploadToR2(cfg: R2Config, key: string, buffer: Buffer): Promise<string> {
  await withRetry(async (): Promise<void> => {
    const r = await fetch(r2ObjectUrl(cfg, key), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'audio/mpeg',
      },
      body: buffer,
    });
    if (r.status === 429) {
      const err: any = new Error('R2 rate limit');
      err.name = 'ThrottlingException';
      throw err;
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error(`R2 upload failed for ${key}: HTTP ${r.status} (${r.statusText})`);
    }
    await r.body?.cancel();
  }, `R2-PUT:${key}`);

  return `${cfg.publicBase.replace(/\/+$/, '')}/${key}`;
}

// ---- Synthesis (dispatched on the recipe's service) ----

async function synthesizePolly(polly: PollyClient, recipe: PollyRecipe, text: string): Promise<Buffer> {
  const command = new SynthesizeSpeechCommand({
    Text: text,
    TextType: recipe.textType as TextType,
    OutputFormat: recipe.outputFormat as OutputFormat,
    VoiceId: recipe.voiceId as VoiceId,
    Engine: recipe.engine as Engine,
    LanguageCode: recipe.languageCode as LanguageCode,
    SampleRate: recipe.sampleRate,
  });

  const response = await withRetry(() => polly.send(command), `Polly:${text.slice(0, 20)}`);
  if (!response.AudioStream) {
    throw new Error('No audio stream returned from Polly');
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.AudioStream as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function synthesizeElevenLabs(recipe: ElevenLabsRecipe, apiKey: string, text: string): Promise<Buffer> {
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${recipe.voiceId}` +
    `?output_format=${encodeURIComponent(recipe.outputFormat)}`;

  const response = await withRetry(async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: recipe.modelId,
        voice_settings: recipe.voiceSettings,
      }),
    });
    if (r.status === 429) {
      const err: any = new Error('ElevenLabs rate limit');
      err.name = 'ThrottlingException';
      throw err;
    }
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`ElevenLabs TTS failed: HTTP ${r.status} (${r.statusText}): ${body.slice(0, 200)}`);
    }
    return r;
  }, `ElevenLabs:${text.slice(0, 20)}`);

  return Buffer.from(await response.arrayBuffer());
}

// ---- Main ----

async function main() {
  if (typeof fetch === 'undefined') {
    console.error('❌ fetch is not available. Requires Node.js 18 or later.');
    process.exit(1);
  }

  const { level, voice, limit } = parseArgs();
  const recipe = VOICE_RECIPES[voice];

  const dataPath = getDataPath(level);
  if (!fs.existsSync(dataPath)) {
    console.error(`Data file not found: ${dataPath}`);
    console.error('Run generate.ts first to create the data file.');
    process.exit(1);
  }

  const items: ContentItem[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  console.log(`Loaded ${items.length} items from HSK ${level} data (voice: ${voice})`);

  // Validate R2 credentials (always needed) and service-specific credentials.
  const cfg: R2Config = {
    token: getRequiredEnv('CLOUDFLARE_API_TOKEN'),
    accountId: getRequiredEnv('CLOUDFLARE_ACCOUNT_ID'),
    publicBase: getRequiredEnv('CLOUDFLARE_R2_PUBLIC_BASE'),
    bucket: process.env.CLOUDFLARE_R2_BUCKET ?? 'meiting-audio',
  };

  let polly: PollyClient | undefined;
  let elevenApiKey: string | undefined;
  if (recipe.service === 'polly') {
    getRequiredEnv('AWS_ACCESS_KEY_ID');
    getRequiredEnv('AWS_SECRET_ACCESS_KEY');
    polly = new PollyClient({ region: process.env.AWS_REGION || 'us-east-1' });
  } else {
    elevenApiKey = getRequiredEnv('ELEVENLABS_API_KEY');
  }
  console.log('Credentials validated ✓');

  // Fast-path skip: items whose JSON already records up-to-date audio for this
  // voice. Legacy (pre-CAS) URLs are respected; only missing or stale CAS-managed
  // audio is (re)generated.
  const needsAudio = items.filter(
    (item) => !audioIsCurrent(item.audio?.[voice], voice, item.characters, cfg.publicBase)
  );

  console.log(
    `${needsAudio.length} items need audio for ${voice} (${items.length - needsAudio.length} already current)`
  );
  if (limit > 0) {
    console.log(`Limit: at most ${limit} new file(s) will be synthesized this run (cache hits don't count).`);
  }

  if (needsAudio.length === 0) {
    console.log('All items already have current audio. Nothing to do.');
    return;
  }

  // ElevenLabs has stricter rate limits than Polly.
  const CONCURRENCY = recipe.service === 'elevenlabs' ? 2 : 5;
  const SAVE_INTERVAL = 20;

  let processed = 0;
  let cached = 0;
  let pendingSave = 0;
  // Slots reserved for synthesis, incremented synchronously before the await so
  // the limit is enforced exactly even with concurrent workers (no overage).
  let reserved = 0;
  let limitReached = false;

  const maybeSave = () => {
    pendingSave++;
    if (pendingSave >= SAVE_INTERVAL) {
      fs.writeFileSync(dataPath, JSON.stringify(items, null, 2), 'utf-8');
      pendingSave = 0;
    }
  };

  const setAudio = (item: ContentItem, url: string) => {
    item.audio = { ...(item.audio ?? {}), [voice]: url };
  };

  // Returns true if the item was handled, false if skipped because the synthesis
  // limit was reached (the caller re-queues it for a future run).
  const processItem = async (item: ContentItem, index: number): Promise<boolean> => {
    const key = audioCacheKey(voice, item.characters);

    // Cache ladder step 2: object already in R2 (dup text, or manifest was lost/rebuilt).
    // Cheap and free — always allowed, never counts against the limit.
    if (await r2ObjectExists(cfg, key)) {
      process.stdout.write(`[${index + 1}/${needsAudio.length}] ${item.id}: ${item.characters.slice(0, 15)} ... `);
      setAudio(item, `${cfg.publicBase.replace(/\/+$/, '')}/${key}`);
      process.stdout.write('♻️  cached\n');
      cached++;
      maybeSave();
      return true;
    }

    // Reserve a synthesis slot (check + increment with no await between → atomic).
    if (limit > 0 && reserved >= limit) {
      limitReached = true;
      return false;
    }
    reserved++;

    // Cache ladder step 3: synthesize and upload.
    process.stdout.write(`[${index + 1}/${needsAudio.length}] ${item.id}: ${item.characters.slice(0, 15)} ... `);
    const buffer =
      recipe.service === 'polly'
        ? await synthesizePolly(polly!, recipe, item.characters)
        : await synthesizeElevenLabs(recipe, elevenApiKey!, item.characters);
    const url = await uploadToR2(cfg, key, buffer);
    setAudio(item, url);
    process.stdout.write('✓\n');
    processed++;
    maybeSave();
    return true;
  };

  // Concurrency queue — workers stop immediately on the first failure.
  const abort = new AbortController();
  const queue: number[] = needsAudio.map((_, i) => i);

  const worker = async () => {
    while (true) {
      if (abort.signal.aborted || limitReached) break;
      const idx = queue.shift();
      if (idx === undefined) break;
      if (abort.signal.aborted) {
        queue.unshift(idx);
        break;
      }
      const handled = await processItem(needsAudio[idx], idx);
      if (!handled) {
        // Skipped because the synthesis limit was reached — re-queue for next run and stop.
        queue.unshift(idx);
        break;
      }
    }
  };

  try {
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        try {
          await worker();
        } catch (err) {
          abort.abort();
          throw err;
        }
      })
    );
  } catch (err) {
    fs.writeFileSync(dataPath, JSON.stringify(items, null, 2), 'utf-8');
    console.error(`\n\n❌ Audio generation failed: ${(err as Error).message}`);
    console.error(`   ${processed} synthesized, ${cached} cache hits before failure.`);
    console.error(`   Saved progress. Fix the issue and rerun to continue from where it left off.`);
    process.exit(1);
  }

  fs.writeFileSync(dataPath, JSON.stringify(items, null, 2), 'utf-8');
  if (limitReached) {
    console.log(`\n🛑 Reached --limit of ${limit} new file(s). ${processed} synthesized, ${cached} cache hits.`);
    console.log(`   Remaining items will be picked up on the next run.`);
  } else {
    console.log(`\n✅ Done! ${processed} synthesized, ${cached} cache hits.`);
  }

  const withAudio = items.filter((item) => item.audio?.[voice]).length;
  console.log(`Final state: ${withAudio}/${items.length} items have ${voice} audio`);
  console.log(`Audio hosted at: ${cfg.publicBase}/`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
