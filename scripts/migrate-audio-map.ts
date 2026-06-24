#!/usr/bin/env ts-node
/**
 * migrate-audio-map.ts — One-time migration of the audio field shape.
 *
 * Converts each item's `audio` from a bare string URL to a per-voice map:
 *
 *   "audio": "https://pub-xxx.r2.dev/hsk1-s-0001.mp3"
 *     becomes
 *   "audio": { "polly-zhiyu": "https://pub-xxx.r2.dev/hsk1-s-0001.mp3" }
 *
 * All existing audio was generated with AWS Polly (Zhiyu voice), so the existing
 * URL is recorded under the 'polly-zhiyu' key. The R2 objects keep their current
 * names — this is a pure JSON rewrite, no secrets and no network calls.
 *
 * Idempotent: items whose `audio` is already an object (or absent) are left as-is.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/migrate-audio-map.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import type { VoiceProvider } from './lib/voices';

const DEFAULT_VOICE: VoiceProvider = 'polly-zhiyu';

interface RawItem {
  id: string;
  audio?: string | Partial<Record<VoiceProvider, string>>;
  [key: string]: unknown;
}

function migrateFile(dataPath: string): void {
  if (!fs.existsSync(dataPath)) {
    console.log(`⏩ ${path.basename(dataPath)}: not found, skipping.`);
    return;
  }

  const items: RawItem[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  let migrated = 0;

  for (const item of items) {
    if (typeof item.audio === 'string') {
      item.audio = { [DEFAULT_VOICE]: item.audio };
      migrated++;
    }
    // Already a map or absent — leave untouched (idempotent).
  }

  fs.writeFileSync(dataPath, JSON.stringify(items, null, 2), 'utf-8');
  console.log(`✅ ${path.basename(dataPath)}: migrated ${migrated}/${items.length} items to audio map`);
}

function main(): void {
  const dataDir = path.resolve(__dirname, '..', 'src', 'data');
  const files = fs
    .readdirSync(dataDir)
    .filter((f) => /^hsk\d+\.json$/.test(f))
    .sort();

  if (files.length === 0) {
    console.error('❌ No hsk*.json files found in src/data/');
    process.exit(1);
  }

  for (const file of files) {
    migrateFile(path.join(dataDir, file));
  }
}

main();
