#!/usr/bin/env ts-node
/**
 * audio.ts — AWS Polly audio generator for MěiTīng
 *
 * Reads src/data/hsk[N].json
 * For each item missing audio, calls AWS Polly (Zhiyu neural voice)
 * Uploads MP3 directly to Cloudflare R2 (meiting-audio bucket)
 * Updates audio field in JSON with public R2 URL
 * Idempotent: skips items that already have an R2 audio URL
 *
 * Throttle handling: exponential backoff with jitter, up to MAX_RETRIES
 *
 * Usage:
 *   npx ts-node scripts/audio.ts --level 1
 *   npx ts-node scripts/audio.ts --level 2
 *
 * Required env vars:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION  (for Polly)
 *   CLOUDFLARE_API_TOKEN                                   (for R2 upload)
 *   CLOUDFLARE_ACCOUNT_ID                                  (CF account ID)
 *   CLOUDFLARE_R2_PUBLIC_BASE                              (e.g. https://pub-xxx.r2.dev)
 *   CLOUDFLARE_R2_BUCKET                                   (optional, default: meiting-audio)
 */

import {
  PollyClient,
  SynthesizeSpeechCommand,
  OutputFormat,
  TextType,
  VoiceId,
  Engine,
} from '@aws-sdk/client-polly';
import * as fs from 'fs';
import * as path from 'path';

// ---- Types ----

interface ContentItem {
  id: string;
  hsk: number;
  type: 'sentence';
  characters: string;
  pinyin: string;
  english: string;
  audio?: string;
  distractors: string[];
}

// ---- Args ----

function parseArgs(): { level: number } {
  const args = process.argv.slice(2);
  const levelIndex = args.indexOf('--level');
  if (levelIndex === -1 || !args[levelIndex + 1]) {
    console.error('Usage: npx ts-node scripts/audio.ts --level <1-9>');
    process.exit(1);
  }
  const level = parseInt(args[levelIndex + 1], 10);
  if (isNaN(level) || level < 1 || level > 9) {
    console.error('Level must be between 1 and 9');
    process.exit(1);
  }
  return { level };
}

// ---- Paths ----

function getDataPath(level: number): string {
  return path.resolve(__dirname, '..', 'src', 'data', `hsk${level}.json`);
}

function getAudioR2Key(id: string): string {
  return `${id}.mp3`;
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
    (err?.message ?? '').toLowerCase().includes('rate exceeded')
  );
}

/**
 * Retry fn up to MAX_RETRIES times total.
 * Throttle errors use longer exponential backoff.
 * All other errors use shorter backoff.
 * After MAX_RETRIES attempts, throws — never silently skips.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  // attempt counts from 0; we allow attempts 0..MAX_RETRIES-1 (MAX_RETRIES total)
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
  // TypeScript needs this — the loop above always returns or throws
  throw new Error(`${label}: unreachable`);
}

// ---- R2 upload via Cloudflare API ----

function getRequiredEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

async function uploadToR2(
  key: string,
  buffer: Buffer,
  token: string,
  accountId: string,
  bucket: string,
  publicBase: string,
): Promise<string> {
  const uploadUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${key}`;

  await withRetry(async (): Promise<void> => {
    const r = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'audio/mpeg',
      },
      body: buffer,
    });
    if (r.status === 429) {
      const err: any = new Error('R2 rate limit');
      err.name = 'ThrottlingException';
      throw err;
    }
    if (!r.ok) throw new Error(`R2 upload failed: HTTP ${r.status} (${r.statusText})`);
  }, `R2:${key}`);

  return `${publicBase}/${key}`;
}

// ---- Polly synthesize to buffer ----

async function synthesizeToBuffer(
  polly: PollyClient,
  text: string,
): Promise<Buffer> {
  const command = new SynthesizeSpeechCommand({
    Text: text,
    TextType: TextType.TEXT,
    OutputFormat: OutputFormat.MP3,
    VoiceId: VoiceId.Zhiyu,
    Engine: Engine.NEURAL,
    LanguageCode: 'cmn-CN',
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



// ---- Main ----

async function main() {
  // fetch is built-in from Node.js 18+; fail fast if not available
  if (typeof fetch === 'undefined') {
    console.error('❌ fetch is not available. Requires Node.js 18 or later.');
    process.exit(1);
  }

  const { level } = parseArgs();

  const dataPath = getDataPath(level);
  // Load data
  if (!fs.existsSync(dataPath)) {
    console.error(`Data file not found: ${dataPath}`);
    console.error('Run generate.ts first to create the data file.');
    process.exit(1);
  }

  const items: ContentItem[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  console.log(`Loaded ${items.length} items from HSK ${level} data`);

  // Ensure audio directory exists
  // Find items that need audio — skip items already pointing at R2
  const needsAudio = items.filter((item) => {
    if (!item.audio) return true;
    // Already has an R2 URL — skip
    if (item.audio.includes('r2.dev') || item.audio.includes('r2.cloudflarestorage')) return false;
    return true;
  });

  console.log(
    `${needsAudio.length} items need audio (${items.length - needsAudio.length} already have it)`
  );

  if (needsAudio.length === 0) {
    console.log('All items already have audio. Nothing to do.');
    return;
  }

  // Validate all required credentials upfront — fail fast before any API calls
  const cfToken = getRequiredEnv('CLOUDFLARE_API_TOKEN');
  const cfAccountId = getRequiredEnv('CLOUDFLARE_ACCOUNT_ID');
  const cfPublicBase = getRequiredEnv('CLOUDFLARE_R2_PUBLIC_BASE');
  const cfBucket = process.env.CLOUDFLARE_R2_BUCKET ?? 'meiting-audio';
  getRequiredEnv('AWS_ACCESS_KEY_ID');
  getRequiredEnv('AWS_SECRET_ACCESS_KEY');
  console.log('Credentials validated ✓');

  // Initialize Polly client
  const polly = new PollyClient({
    region: process.env.AWS_REGION || 'us-east-1',
  });

  const CONCURRENCY = 5; // parallel Polly calls
  const SAVE_INTERVAL = 20; // write JSON every N completions

  let processed = 0;
  let pendingSave = 0;

  // Save helper — debounced by SAVE_INTERVAL
  const maybeSave = () => {
    pendingSave++;
    if (pendingSave >= SAVE_INTERVAL) {
      fs.writeFileSync(dataPath, JSON.stringify(items, null, 2), 'utf-8');
      pendingSave = 0;
    }
  };

  // Worker: synthesize via Polly, upload to R2, update item
  // Throws on failure — no silent skips allowed
  const processItem = async (item: ContentItem, index: number): Promise<void> => {
    const key = getAudioR2Key(item.id);
    process.stdout.write(`[${index + 1}/${needsAudio.length}] ${item.id}: ${item.characters.slice(0, 15)} ... `);
    const buffer = await synthesizeToBuffer(polly, item.characters);
    const url = await uploadToR2(key, buffer, cfToken, cfAccountId, cfBucket, cfPublicBase);
    item.audio = url;
    process.stdout.write('✓\n');
    processed++;
    maybeSave();
  };

  // Concurrency queue — workers pull from a shared queue of indices
  // Uses a shared AbortController so all workers stop immediately on first failure
  const abort = new AbortController();
  const queue: number[] = needsAudio.map((_, i) => i);

  const worker = async () => {
    // Check abort before AND after shift — in Node.js the event loop is single-threaded
    // so shift() is atomic, but we re-check abort after each await to stop promptly
    let idx: number | undefined;
    while (!abort.signal.aborted && (idx = queue.shift()) !== undefined) {
      await processItem(needsAudio[idx], idx);
    }
  };

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      try {
        await worker();
      } catch (err) {
        abort.abort(); // Signal all other workers to stop
        throw err;     // Re-throw so Promise.all rejects
      }
    }));
  } catch (err) {
    // Save progress for items that succeeded before the failure
    fs.writeFileSync(dataPath, JSON.stringify(items, null, 2), 'utf-8');
    console.error(`\n\n❌ Audio generation failed: ${(err as Error).message}`);
    console.error(`   ${processed} items succeeded before failure.`);
    console.error(`   Saved progress. Fix the issue and rerun to continue from where it left off.`);
    process.exit(1);
  }

  console.log(`\n✅ Done! All ${processed} items processed successfully.`);

  // Final save
  fs.writeFileSync(dataPath, JSON.stringify(items, null, 2), 'utf-8');

  // Summary
  const withAudio = items.filter((item) => item.audio).length;
  console.log(`\nFinal state: ${withAudio}/${items.length} items have audio`);

  console.log(`Audio hosted at: ${cfPublicBase}/`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
