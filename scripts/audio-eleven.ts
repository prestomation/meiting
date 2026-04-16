#!/usr/bin/env ts-node
/**
 * audio-eleven.ts — ElevenLabs audio generator for MěiTīng
 *
 * Reads src/data/hsk1.json
 * For each item missing ElevenLabs audio, calls ElevenLabs TTS (Haoran voice)
 * Uploads MP3 directly to Cloudflare R2 (meiting-audio bucket)
 * Writes output to src/data/hsk1-haoran.json with updated audio URLs
 * Idempotent: skips items that already have an R2 URL in the output file
 *
 * Throttle handling: exponential backoff with jitter, up to MAX_RETRIES
 *
 * Usage:
 *   npx ts-node scripts/audio-eleven.ts --level 1
 *
 * Required env vars:
 *   ELEVENLABS_API_KEY                                      (for ElevenLabs TTS)
 *   CLOUDFLARE_API_TOKEN                                    (for R2 upload)
 *   CLOUDFLARE_ACCOUNT_ID                                   (CF account ID)
 *   CLOUDFLARE_R2_PUBLIC_BASE                               (e.g. https://pub-xxx.r2.dev)
 *   CLOUDFLARE_R2_BUCKET                                    (optional, default: meiting-audio)
 */

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

// ---- Config ----

const VOICE_ID = 'pU9NaAwkoR3v0Mrg3uKz';
const SERVICE_PREFIX = 'elevenlabs-haoran';

// ---- Args ----

function parseArgs(): { level: number } {
  const args = process.argv.slice(2);
  const levelIndex = args.indexOf('--level');
  if (levelIndex === -1 || !args[levelIndex + 1]) {
    console.error('Usage: npx ts-node scripts/audio-eleven.ts --level <1-9>');
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

function getSourceDataPath(level: number): string {
  return path.resolve(__dirname, '..', 'src', 'data', `hsk${level}.json`);
}

function getOutputDataPath(level: number): string {
  return path.resolve(__dirname, '..', 'src', 'data', `hsk${level}-haoran.json`);
}

function getAudioR2Key(id: string): string {
  // e.g. elevenlabs-haoran-hsk1-s-0001.mp3
  const safe = id.replace(/[^a-zA-Z0-9\-_]/g, '_');
  return `${SERVICE_PREFIX}-${safe}.mp3`;
}

// ---- Retry with exponential backoff ----

const MAX_RETRIES = 6;
const BASE_DELAY_MS = 500;
const THROTTLE_BASE_DELAY_MS = 2000;

function isThrottleError(err: any): boolean {
  return (
    err?.name === 'ThrottlingException' ||
    err?.$metadata?.httpStatusCode === 429 ||
    (err?.message ?? '').toLowerCase().includes('rate limit') ||
    (err?.message ?? '').toLowerCase().includes('throttl')
  );
}

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
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error(`R2 upload failed: HTTP ${r.status} (${r.statusText})`);
    }
    await r.body?.cancel();
  }, `R2:${key}`);

  return `${publicBase}/${key}`;
}

// ---- ElevenLabs synthesize to buffer ----

async function synthesizeToBuffer(
  text: string,
  apiKey: string,
): Promise<Buffer> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;

  const response = await withRetry(async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
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

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ---- Main ----

async function main() {
  if (typeof fetch === 'undefined') {
    console.error('❌ fetch is not available. Requires Node.js 18 or later.');
    process.exit(1);
  }

  const { level } = parseArgs();

  const sourcePath = getSourceDataPath(level);
  const outputPath = getOutputDataPath(level);

  if (!fs.existsSync(sourcePath)) {
    console.error(`Source data file not found: ${sourcePath}`);
    console.error('Run generate.ts first to create the data file.');
    process.exit(1);
  }

  // Load source data
  const sourceItems: ContentItem[] = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));
  console.log(`Loaded ${sourceItems.length} items from HSK ${level} source data`);

  // Load or create output data
  let outputItems: ContentItem[];
  if (fs.existsSync(outputPath)) {
    outputItems = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    console.log(`Loaded ${outputItems.length} items from existing output file`);
  } else {
    outputItems = sourceItems.map((item) => ({ ...item }));
    console.log('Created new output data from source');
  }

  // Build lookup of output items by ID
  const outputMap = new Map<string, ContentItem>();
  for (const item of outputItems) {
    outputMap.set(item.id, item);
  }

  // Validate credentials
  const cfToken = getRequiredEnv('CLOUDFLARE_API_TOKEN');
  const cfAccountId = getRequiredEnv('CLOUDFLARE_ACCOUNT_ID');
  const cfPublicBase = getRequiredEnv('CLOUDFLARE_R2_PUBLIC_BASE');
  const cfBucket = process.env.CLOUDFLARE_R2_BUCKET ?? 'meiting-audio';
  const elevenApiKey = getRequiredEnv('ELEVENLABS_API_KEY');
  console.log('Credentials validated ✓');

  // Find items that need audio
  const needsAudio = sourceItems.filter((item) => {
    const existing = outputMap.get(item.id);
    if (!existing) return true;
    if (existing.audio && (existing.audio.includes('r2.dev') || existing.audio.includes('r2.cloudflarestorage'))) return false;
    return true;
  });

  console.log(
    `${needsAudio.length} items need audio (${sourceItems.length - needsAudio.length} already have it)`
  );

  if (needsAudio.length === 0) {
    console.log('All items already have audio. Nothing to do.');
    // Save final output
    fs.writeFileSync(outputPath, JSON.stringify(outputItems, null, 2), 'utf-8');
    return;
  }

  const CONCURRENCY = 2; // ElevenLabs has stricter rate limits
  const SAVE_INTERVAL = 20;

  let processed = 0;
  let pendingSave = 0;

  const maybeSave = () => {
    pendingSave++;
    if (pendingSave >= SAVE_INTERVAL) {
      fs.writeFileSync(outputPath, JSON.stringify(outputItems, null, 2), 'utf-8');
      pendingSave = 0;
    }
  };

  const processItem = async (item: ContentItem, index: number): Promise<void> => {
    const key = getAudioR2Key(item.id);
    process.stdout.write(`[${index + 1}/${needsAudio.length}] ${item.id}: ${item.characters.slice(0, 15)} ... `);
    const buffer = await synthesizeToBuffer(item.characters, elevenApiKey);
    const url = await uploadToR2(key, buffer, cfToken, cfAccountId, cfBucket, cfPublicBase);

    // Update the output map
    const existing = outputMap.get(item.id);
    if (existing) {
      existing.audio = url;
    } else {
      const newItem = { ...item, audio: url };
      outputMap.set(item.id, newItem);
    }

    process.stdout.write('✓\n');
    processed++;
    maybeSave();
  };

  // Concurrency queue
  const abort = new AbortController();
  const queue: number[] = needsAudio.map((_, i) => i);

  const worker = async () => {
    while (true) {
      if (abort.signal.aborted) break;
      const idx = queue.shift();
      if (idx === undefined) break;
      if (abort.signal.aborted) {
        queue.unshift(idx);
        break;
      }
      await processItem(needsAudio[idx], idx);
    }
  };

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      try {
        await worker();
      } catch (err) {
        abort.abort();
        throw err;
      }
    }));
  } catch (err) {
    // Rebuild outputItems from map before saving
    const rebuilt = sourceItems.map((item) => outputMap.get(item.id) ?? item);
    fs.writeFileSync(outputPath, JSON.stringify(rebuilt, null, 2), 'utf-8');
    console.error(`\n\n❌ Audio generation failed: ${(err as Error).message}`);
    console.error(`   ${processed} items succeeded before failure.`);
    console.error(`   Saved progress. Fix the issue and rerun to continue from where it left off.`);
    process.exit(1);
  }

  console.log(`\n✅ Done! All ${processed} items processed successfully.`);

  // Rebuild outputItems from map in source order
  outputItems = sourceItems.map((item) => outputMap.get(item.id) ?? item);
  fs.writeFileSync(outputPath, JSON.stringify(outputItems, null, 2), 'utf-8');

  const withAudio = outputItems.filter((item) => item.audio).length;
  console.log(`\nFinal state: ${withAudio}/${outputItems.length} items have audio`);

  console.log(`Audio hosted at: ${cfPublicBase}/`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});