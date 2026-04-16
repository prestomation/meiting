#!/usr/bin/env ts-node
/**
 * rename-audio-files.ts — Rename R2 audio keys from short names to prefixed names
 *
 * Reads src/data/hsk[N].json
 * For each item with an audio URL that does NOT start with `polly-` or `elevenlabs-`:
 *   - Computes new R2 key: `polly-zhiyu-<old-filename>`
 *   - Copies old R2 key to new key via Cloudflare R2 COPY API
 *   - Deletes old R2 key via Cloudflare R2 DELETE API
 *   - Updates the item's audio field to use the new URL
 * Writes updated JSON back to the source file.
 *
 * Usage:
 *   npx ts-node scripts/rename-audio-files.ts
 *
 * Required env vars:
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_R2_PUBLIC_BASE
 *   CLOUDFLARE_R2_BUCKET (optional, default: meiting-audio)
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

// ---- Retry ----

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

// ---- Env ----

function getRequiredEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

// ---- R2 Operations ----

async function copyR2Object(
  sourceKey: string,
  destKey: string,
  token: string,
  accountId: string,
  bucket: string,
): Promise<void> {
  // R2 COPY via S3-compatible API using Cloudflare API
  // We use the Cloudflare API to copy objects between keys in the same bucket
  const copyUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${destKey}`;

  await withRetry(async (): Promise<void> => {
    // First, GET the object and PUT it to the new key
    const sourceUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${sourceKey}`;
    
    // Read the source object
    const getResponse = await fetch(sourceUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (getResponse.status === 404) {
      console.log(`  ⚠️ Source key not found: ${sourceKey} — skipping`);
      return;
    }

    if (!getResponse.ok) {
      const body = await getResponse.text();
      throw new Error(`R2 GET failed for ${sourceKey}: HTTP ${getResponse.status} (${getResponse.statusText}): ${body.slice(0, 200)}`);
    }

    const bodyBuffer = Buffer.from(await getResponse.arrayBuffer());

    // Write to the new key
    const putResponse = await fetch(copyUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'audio/mpeg',
      },
      body: bodyBuffer,
    });

    if (putResponse.status === 429) {
      const err: any = new Error('R2 rate limit');
      err.name = 'ThrottlingException';
      throw err;
    }

    if (!putResponse.ok) {
      await putResponse.body?.cancel();
      throw new Error(`R2 PUT failed for ${destKey}: HTTP ${putResponse.status} (${putResponse.statusText})`);
    }

    await putResponse.body?.cancel();
  }, `R2-COPY:${sourceKey}->${destKey}`);
}

async function deleteR2Object(
  key: string,
  token: string,
  accountId: string,
  bucket: string,
): Promise<void> {
  const deleteUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${key}`;

  await withRetry(async (): Promise<void> => {
    const r = await fetch(deleteUrl, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (r.status === 429) {
      const err: any = new Error('R2 rate limit');
      err.name = 'ThrottlingException';
      throw err;
    }

    // 204 = deleted, 404 = already gone — both fine
    if (r.status !== 204 && r.status !== 404) {
      await r.body?.cancel();
      throw new Error(`R2 DELETE failed for ${key}: HTTP ${r.status} (${r.statusText})`);
    }

    await r.body?.cancel();
  }, `R2-DELETE:${key}`);
}

// ---- Main ----

async function main() {
  if (typeof fetch === 'undefined') {
    console.error('❌ fetch is not available. Requires Node.js 18 or later.');
    process.exit(1);
  }

  const cfToken = getRequiredEnv('CLOUDFLARE_API_TOKEN');
  const cfAccountId = getRequiredEnv('CLOUDFLARE_ACCOUNT_ID');
  const cfPublicBase = getRequiredEnv('CLOUDFLARE_R2_PUBLIC_BASE');
  const cfBucket = process.env.CLOUDFLARE_R2_BUCKET ?? 'meiting-audio';

  const levels = [1, 2];

  for (const level of levels) {
    const dataPath = path.resolve(__dirname, '..', 'src', 'data', `hsk${level}.json`);

    if (!fs.existsSync(dataPath)) {
      console.log(`\n⏩ HSK ${level}: File not found at ${dataPath}, skipping.`);
      continue;
    }

    const items: ContentItem[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    console.log(`\nHSK ${level}: Loaded ${items.length} items`);

    const needsRename = items.filter((item) => {
      if (!item.audio) return false;
      // Check if the filename (last path segment) already has a prefix
      const filename = item.audio.split('/').pop() ?? '';
      if (filename.startsWith('polly-') || filename.startsWith('elevenlabs-')) return false;
      return true;
    });

    console.log(`  ${needsRename.length} items need renaming (${items.length - needsRename.length} already prefixed)`);

    if (needsRename.length === 0) {
      console.log('  Nothing to do for this level.');
      continue;
    }

    let renamed = 0;
    const SAVE_INTERVAL = 20;

    for (let i = 0; i < needsRename.length; i++) {
      const item = needsRename[i];
      if (!item.audio) continue;

      const oldFilename = item.audio.split('/').pop() ?? '';
      const newFilename = `polly-zhiyu-${oldFilename}`;
      const oldKey = oldFilename; // R2 key is just the filename (flat structure)
      const newKey = newFilename;

      process.stdout.write(`  [${i + 1}/${needsRename.length}] ${item.id}: ${oldFilename} -> ${newFilename} ... `);

      try {
        // Copy to new key
        await copyR2Object(oldKey, newKey, cfToken, cfAccountId, cfBucket);
        // Delete old key
        await deleteR2Object(oldKey, cfToken, cfAccountId, cfBucket);
        // Update URL
        const newUrl = `${cfPublicBase}/${newKey}`;
        item.audio = newUrl;
        process.stdout.write('✓\n');
        renamed++;
      } catch (err: any) {
        console.error(`\n  ❌ Failed: ${err.message}`);
        // Continue with next item — don't abort the whole run
      }

      // Save progress periodically
      if (renamed > 0 && renamed % SAVE_INTERVAL === 0) {
        fs.writeFileSync(dataPath, JSON.stringify(items, null, 2), 'utf-8');
        console.log(`  💾 Saved progress (${renamed}/${needsRename.length})`);
      }
    }

    // Final save
    fs.writeFileSync(dataPath, JSON.stringify(items, null, 2), 'utf-8');
    console.log(`  ✅ HSK ${level}: Renamed ${renamed}/${needsRename.length} audio files`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});