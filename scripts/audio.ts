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

  let processed = 0;
  let failed = 0;
  const failedIds: string[] = [];

  for (const item of needsAudio) {
    const audioFilePath = getAudioPath(item.id);
    const audioPublicPath = getAudioPublicPath(item.id);

    try {
      process.stdout.write(`[${processed + 1}/${needsAudio.length}] ${item.id}: ${item.characters} ... `);

      await synthesize(polly, item.characters, audioFilePath);

      // Update item in memory
      item.audio = audioPublicPath;

      // Save after each item so progress is preserved on failure
      fs.writeFileSync(dataPath, JSON.stringify(items, null, 2), 'utf-8');

      process.stdout.write('✓\n');
      processed++;

      // Small delay to avoid throttling
      await new Promise((r) => setTimeout(r, 100));
    } catch (err) {
      process.stdout.write(`✗ (${(err as Error).message})\n`);
      failed++;
      failedIds.push(item.id);

      // If we get a throttling error, wait longer
      if ((err as Error).message?.includes('throttl') || (err as Error).message?.includes('rate')) {
        console.log('Rate limit detected, waiting 5 seconds...');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

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
