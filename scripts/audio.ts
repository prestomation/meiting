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
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID, CLOUDFLARE_R2_SECRET_ACCESS_KEY
 *   (or set CF_API_TOKEN for token-based auth)
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

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      const isThrottle =
        err?.name === 'ThrottlingException' ||
        err?.Code === 'ThrottlingException' ||
        err?.$metadata?.httpStatusCode === 429 ||
        (err?.message ?? '').toLowerCase().includes('throttl') ||
        (err?.message ?? '').toLowerCase().includes('rate exceeded');

      if (isThrottle && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 200;
        process.stdout.write(`⏳ throttled (attempt ${attempt + 1}/${MAX_RETRIES}, retry in ${Math.round(delay)}ms)... `);
        await new Promise((r) => setTimeout(r, delay));
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

// ---- R2 upload via Cloudflare API ----

const CF_ACCOUNT_ID = '364b2140fbff5211780667a063dfa257';
const R2_BUCKET = 'meiting-audio';
const R2_PUBLIC_BASE = 'https://pub-8a634995dd094be9868574d25ca7dcd9.r2.dev';

async function uploadToR2(key: string, buffer: Buffer): Promise<string> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN env var required');

  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects/${key}`;

  const resp = await withRetry(async () => {
    const r = await fetch(url, {
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
    if (!r.ok) throw new Error(`R2 upload failed: ${r.status} ${await r.text()}`);
    return r;
  }, `R2:${key}`);

  return `${R2_PUBLIC_BASE}/${key}`;
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

  // Initialize Polly client
  const polly = new PollyClient({
    region: process.env.AWS_REGION || 'us-east-1',
  });

  const CONCURRENCY = 5; // parallel Polly calls
  const SAVE_INTERVAL = 20; // write JSON every N completions

  let processed = 0;
  let failed = 0;
  const failedIds: string[] = [];
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
  const processItem = async (item: ContentItem, index: number): Promise<void> => {
    const key = getAudioR2Key(item.id);
    try {
      process.stdout.write(`[${index + 1}/${needsAudio.length}] ${item.id}: ${item.characters.slice(0, 15)} ... `);
      const buffer = await synthesizeToBuffer(polly, item.characters);
      const url = await uploadToR2(key, buffer);
      item.audio = url;
      process.stdout.write('✓\n');
      processed++;
      maybeSave();
    } catch (err) {
      process.stdout.write(`✗ (${(err as Error).message})\n`);
      failed++;
      failedIds.push(item.id);
      // Do NOT mark item.audio — leave it empty so a rerun will retry
    }
  };

  // Concurrency queue — run CONCURRENCY workers draining a shared index
  let cursor = 0;
  const worker = async () => {
    while (cursor < needsAudio.length) {
      const idx = cursor++;
      await processItem(needsAudio[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\nDone!`);
  console.log(`  Processed: ${processed}`);
  console.log(`  Failed: ${failed}`);

  if (failedIds.length > 0) {
    console.log(`  Failed IDs: ${failedIds.join(', ')}`);
    console.log('  Run again to retry failed items.');
  }

  // Final save
  fs.writeFileSync(dataPath, JSON.stringify(items, null, 2), 'utf-8');

  // Summary
  const withAudio = items.filter((item) => item.audio).length;
  console.log(`\nFinal state: ${withAudio}/${items.length} items have audio`);

  console.log(`Audio hosted at: ${R2_PUBLIC_BASE}/`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
