#!/usr/bin/env ts-node
/**
 * audio.ts — AWS Polly audio generator for MěiTīng
 *
 * Reads src/data/hsk[N].json
 * For each item missing audio, calls AWS Polly (Zhiyu neural voice)
 * Saves MP3 to public/audio/{id}.mp3
 * Updates audio field in JSON
 * Idempotent: skips items that already have audio AND the file exists
 *
 * Usage:
 *   npx ts-node scripts/audio.ts --level 1
 *   npx ts-node scripts/audio.ts --level 2
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

function getAudioDir(): string {
  return path.resolve(__dirname, '..', 'public', 'audio');
}

function getAudioPath(id: string): string {
  return path.join(getAudioDir(), `${id}.mp3`);
}

function getAudioPublicPath(id: string): string {
  return `/audio/${id}.mp3`;
}

// ---- Polly synthesize ----

async function synthesize(
  polly: PollyClient,
  text: string,
  outputPath: string
): Promise<void> {
  const command = new SynthesizeSpeechCommand({
    Text: text,
    TextType: TextType.TEXT,
    OutputFormat: OutputFormat.MP3,
    VoiceId: VoiceId.Zhiyu,
    Engine: Engine.NEURAL,
    LanguageCode: 'cmn-CN',
  });

  const response = await polly.send(command);

  if (!response.AudioStream) {
    throw new Error('No audio stream returned from Polly');
  }

  // Convert stream to buffer
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.AudioStream as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);
  fs.writeFileSync(outputPath, buffer);
}

// ---- Main ----

async function main() {
  const { level } = parseArgs();

  const dataPath = getDataPath(level);
  const audioDir = getAudioDir();

  // Load data
  if (!fs.existsSync(dataPath)) {
    console.error(`Data file not found: ${dataPath}`);
    console.error('Run generate.ts first to create the data file.');
    process.exit(1);
  }

  const items: ContentItem[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  console.log(`Loaded ${items.length} items from HSK ${level} data`);

  // Ensure audio directory exists
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
    console.log(`Created audio directory: ${audioDir}`);
  }

  // Find items that need audio
  const needsAudio = items.filter((item) => {
    if (!item.audio) return true;
    // Check if file actually exists
    const filePath = path.join(audioDir, `${item.id}.mp3`);
    return !fs.existsSync(filePath);
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

  // Worker: process one item
  const processItem = async (item: ContentItem, index: number): Promise<void> => {
    const audioFilePath = getAudioPath(item.id);
    const audioPublicPath = getAudioPublicPath(item.id);

    try {
      process.stdout.write(`[${index + 1}/${needsAudio.length}] ${item.id}: ${item.characters} ... `);
      await synthesize(polly, item.characters, audioFilePath);
      item.audio = audioPublicPath;
      process.stdout.write('✓\n');
      processed++;
      maybeSave();
    } catch (err) {
      process.stdout.write(`✗ (${(err as Error).message})\n`);
      failed++;
      failedIds.push(item.id);
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

  // Show where audio files are
  const audioFiles = fs.readdirSync(audioDir).filter((f) => f.endsWith('.mp3'));
  console.log(`Audio files in ${audioDir}: ${audioFiles.length}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
