#!/usr/bin/env ts-node
/**
 * validate-content.ts — CI guard for content data integrity
 *
 * Checks that every item in every src/data/hsk*.json:
 *   1. Has a valid R2 audio URL for the DEFAULT voice (the shipped voice).
 *      Other voices are optional — they're filled in asynchronously by the
 *      generate-audio workflow and shouldn't block a merge — but if present
 *      they must also be valid R2 URLs.
 *   2. Has non-empty characters, pinyin, english fields
 *   3. Has at least 3 non-empty distractors
 *
 * Exits non-zero on any violation — blocks CI/merge.
 *
 * Usage:
 *   npx ts-node scripts/validate-content.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import type { VoiceProvider } from './lib/voices';

const DATA_DIR = path.resolve(__dirname, '..', 'src', 'data');
const R2_URL_PREFIX = 'https://pub-';
const DEFAULT_VOICE: VoiceProvider = 'elevenlabs-haoran';

interface ContentItem {
  id: string;
  hsk: number;
  type: string;
  characters: string;
  pinyin: string;
  english: string;
  audio?: Partial<Record<VoiceProvider, string>>;
  distractors: string[];
}

/** Returns an error reason if the URL isn't a valid R2 URL, otherwise null. */
function audioUrlError(url: string | undefined): string | null {
  if (!url?.trim()) return 'missing';
  if (url.startsWith('/') || url.startsWith('./')) return `local path (${url})`;
  if (!url.startsWith(R2_URL_PREFIX)) return `invalid (${url.slice(0, 60)})`;
  return null;
}

let totalErrors = 0;
let totalItems = 0;

let dataFiles: string[];
try {
  dataFiles = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.match(/^hsk\d+\.json$/))
    .sort();
} catch (err) {
  console.error(`❌ Cannot read data directory ${DATA_DIR}: ${(err as Error).message}`);
  process.exit(1);
}

if (dataFiles.length === 0) {
  console.error('❌ No hsk*.json files found in src/data/');
  process.exit(1);
}

for (const file of dataFiles) {
  const filePath = path.join(DATA_DIR, file);
  let items: ContentItem[];

  try {
    items = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error(`❌ ${file}: failed to parse JSON — ${(err as Error).message}`);
    totalErrors++;
    continue;
  }

  let fileErrors = 0;
  const audioMissing: string[] = [];
  const audioLocal: string[] = [];
  const missingFields: string[] = [];
  const badDistractors: string[] = [];

  for (const item of items) {
    totalItems++;

    // Check required text fields (reject empty strings and whitespace-only)
    if (
      !item.characters?.trim() ||
      !item.pinyin?.trim() ||
      !item.english?.trim()
    ) {
      missingFields.push(item.id);
      fileErrors++;
    }

    // Check audio. The default voice is required and must be a valid R2 URL.
    const defaultErr = audioUrlError(item.audio?.[DEFAULT_VOICE]);
    if (defaultErr === 'missing') {
      audioMissing.push(item.id);
      fileErrors++;
    } else if (defaultErr) {
      audioLocal.push(`${item.id} ${defaultErr}`);
      fileErrors++;
    }

    // Other voices are optional, but if present they must be valid R2 URLs.
    for (const [voice, url] of Object.entries(item.audio ?? {})) {
      if (voice === DEFAULT_VOICE) continue;
      const err = audioUrlError(url);
      if (err && err !== 'missing') {
        audioLocal.push(`${item.id} [${voice}] ${err}`);
        fileErrors++;
      }
    }

    // Check distractors — require at least 3 non-empty entries
    const validDistractors = Array.isArray(item.distractors)
      ? item.distractors.filter((d) => d?.trim())
      : [];
    if (validDistractors.length < 3) {
      badDistractors.push(item.id);
      fileErrors++;
    }
  }

  if (fileErrors === 0) {
    console.log(`✅ ${file}: ${items.length} items — all valid`);
  } else {
    console.error(`❌ ${file}: ${items.length} items — ${fileErrors} errors`);

    if (audioMissing.length > 0) {
      const preview = audioMissing.slice(0, 5).join(', ');
      const more = audioMissing.length > 5 ? ` (+${audioMissing.length - 5} more)` : '';
      console.error(`   Missing audio: ${preview}${more}`);
    }
    if (audioLocal.length > 0) {
      const preview = audioLocal.slice(0, 3).join(', ');
      const more = audioLocal.length > 3 ? ` (+${audioLocal.length - 3} more)` : '';
      console.error(`   Local/invalid audio paths: ${preview}${more}`);
    }
    if (missingFields.length > 0) {
      console.error(`   Missing required fields: ${missingFields.slice(0, 5).join(', ')}`);
    }
    if (badDistractors.length > 0) {
      console.error(`   Insufficient distractors (<3): ${badDistractors.slice(0, 5).join(', ')}`);
    }

    totalErrors += fileErrors;
  }
}

console.log(`\nChecked ${totalItems} items across ${dataFiles.length} files.`);

if (totalErrors > 0) {
  console.error(`\n❌ Validation failed: ${totalErrors} error(s). Fix before merging.`);
  console.error('   Hint: Run audio generation script before opening a PR.');
  process.exit(1);
} else {
  console.log('\n✅ All content valid — safe to merge.');
}
