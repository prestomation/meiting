#!/usr/bin/env ts-node
/**
 * assemble.ts — stitch subagent batch outputs into src/data/hsk{N}.json.
 *
 * Reads the raw/ JSON arrays produced by Claude Code subagents (see
 * emit-batches.ts), validates every sentence against the cumulative HSK
 * vocabulary, dedupes, assigns IDs, and selects phonetic distractors.
 *
 * Idempotent: merges with existing data and never overwrites already-generated
 * sentences. Safe to re-run as more batches are completed.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/assemble.ts --level 3
 *   # optional: --raw <dir>    (default: scripts/.work/hsk{N}/raw)
 *   # optional: --fresh        (clear existing src/data/hsk{N}.json first)
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ContentItem,
  RawSentence,
  parseAndValidate,
  filterByVocabulary,
  assembleItems,
  buildAllowedChars,
  getSentenceLengthLimit,
} from './lib/generation';

function parseArgs(): { level: number; raw?: string; fresh: boolean } {
  const args = process.argv.slice(2);
  const levelIndex = args.indexOf('--level');
  if (levelIndex === -1 || !args[levelIndex + 1]) {
    console.error('Usage: assemble.ts --level <1-9> [--raw <dir>] [--fresh]');
    process.exit(1);
  }
  const level = parseInt(args[levelIndex + 1], 10);
  if (isNaN(level) || level < 1 || level > 9) {
    console.error('Level must be between 1 and 9');
    process.exit(1);
  }
  const rawIndex = args.indexOf('--raw');
  const raw = rawIndex !== -1 ? args[rawIndex + 1] : undefined;
  return { level, raw, fresh: args.includes('--fresh') };
}

function loadExisting(outputPath: string): ContentItem[] {
  if (!fs.existsSync(outputPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(outputPath, 'utf-8')) as ContentItem[];
  } catch {
    console.warn(`Warning: could not parse existing ${outputPath}, starting fresh.`);
    return [];
  }
}

function main() {
  const { level, raw, fresh } = parseArgs();

  const rawDir = raw ?? path.resolve(__dirname, '.work', `hsk${level}`, 'raw');
  const outputPath = path.resolve(__dirname, '..', 'src', 'data', `hsk${level}.json`);

  if (!fs.existsSync(rawDir)) {
    console.error(`Raw output dir not found: ${rawDir}`);
    console.error('Run emit-batches.ts and complete the subagent batches first.');
    process.exit(1);
  }

  const rawFiles = fs
    .readdirSync(rawDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (rawFiles.length === 0) {
    console.error(`No raw batch outputs (*.json) found in ${rawDir}`);
    process.exit(1);
  }

  // Collect + parse all batch outputs
  const collected: RawSentence[] = [];
  let parseErrors = 0;
  for (const file of rawFiles) {
    const full = path.join(rawDir, file);
    try {
      const sentences = parseAndValidate(fs.readFileSync(full, 'utf-8'));
      collected.push(...sentences);
      console.log(`  ${file}: ${sentences.length} sentences`);
    } catch (err) {
      parseErrors++;
      console.warn(`  ${file}: parse failed — ${(err as Error).message}`);
    }
  }
  console.log(`\nCollected ${collected.length} raw sentences from ${rawFiles.length} batch file(s).`);

  // Vocabulary + length validation (cumulative for this level)
  const allowedChars = buildAllowedChars(level);
  const lengthLimit = getSentenceLengthLimit(level);
  const { valid, rejected } = filterByVocabulary(collected, allowedChars, lengthLimit);

  const passRate = collected.length > 0 ? ((valid.length / collected.length) * 100).toFixed(1) : '0.0';
  console.log(`Valid: ${valid.length}, Rejected: ${rejected.length} (pass rate ${passRate}%)`);
  for (const r of rejected.slice(0, 10)) {
    console.log(`  ✗ "${r.sentence.characters}" — ${r.reason}`);
  }
  if (rejected.length > 10) console.log(`  ... and ${rejected.length - 10} more`);

  if (fresh && fs.existsSync(outputPath)) {
    console.log('--fresh: clearing existing data');
    fs.writeFileSync(outputPath, '[]', 'utf-8');
  }

  const existing = loadExisting(outputPath);
  console.log(`\nExisting items in output: ${existing.length}`);

  const { items, added, insufficientDistractors } = assembleItems(level, existing, valid);

  if (added === 0) {
    console.log('No new sentences to add. Output is up to date.');
    return;
  }

  if (insufficientDistractors.length > 0) {
    console.warn(
      `Warning: ${insufficientDistractors.length} item(s) have < 3 distractors (pool too small).`
    );
  }

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(items, null, 2), 'utf-8');

  console.log(`\nSaved ${items.length} total items to ${path.relative(process.cwd(), outputPath)}`);
  console.log(`  (${existing.length} existing + ${added} new)`);
  if (parseErrors > 0) {
    console.log(`Note: ${parseErrors} batch file(s) failed to parse — re-run those batches if needed.`);
  }
}

main();
