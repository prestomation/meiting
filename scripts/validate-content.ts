#!/usr/bin/env ts-node
/**
 * validate-content.ts — CI guard for content data integrity
 *
 * Checks that every item in every src/data/hsk*.json:
 *   1. Has a non-empty audio URL pointing to R2 (not a local path, not empty)
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

const DATA_DIR = path.resolve(__dirname, '..', 'src', 'data');
const R2_URL_PREFIX = 'https://pub-';

interface ContentItem {
  id: string;
  hsk: number;
  type: string;
  characters: string;
  pinyin: string;
  english: string;
  audio?: string;
  distractors: string[];
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

    // Check audio (reject missing, empty string, whitespace)
    if (!item.audio?.trim()) {
      audioMissing.push(item.id);
      fileErrors++;
    } else if (item.audio.startsWith('/') || item.audio.startsWith('./')) {
      audioLocal.push(`${item.id} (${item.audio})`);
      fileErrors++;
    } else if (!item.audio.startsWith(R2_URL_PREFIX)) {
      audioLocal.push(`${item.id} (${item.audio.slice(0, 60)})`);
      fileErrors++;
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
