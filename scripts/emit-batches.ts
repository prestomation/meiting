#!/usr/bin/env ts-node
/**
 * emit-batches.ts — prepare subagent generation batches for an HSK level.
 *
 * Replaces the old "call the Anthropic API" step. Instead of hitting the API,
 * we emit one prompt file per batch of focus words. Claude Code then runs each
 * prompt through a subagent and saves the JSON result into the matching raw/
 * file; scripts/assemble.ts stitches those back into src/data/hsk{N}.json.
 *
 * No API key required — generation is performed by Claude Code subagents.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/emit-batches.ts --level 3
 *   # optional: --out <dir>  (default: scripts/.work/hsk{N})
 *
 * Output layout (work dir):
 *   prompts/batch-01.md ... batch-NN.md   ← subagent input (one per chunk)
 *   raw/                                  ← subagent writes batch-01.json ... here
 *   manifest.json                         ← list of {batch, words, prompt, raw}
 */
import * as fs from 'fs';
import * as path from 'path';
import { WordEntry, buildPrompt, buildAllowedWordList, chunk, CHUNK_SIZE } from './lib/generation';

function parseArgs(): { level: number; out?: string } {
  const args = process.argv.slice(2);
  const levelIndex = args.indexOf('--level');
  if (levelIndex === -1 || !args[levelIndex + 1]) {
    console.error('Usage: emit-batches.ts --level <1-9> [--out <dir>]');
    process.exit(1);
  }
  const level = parseInt(args[levelIndex + 1], 10);
  if (isNaN(level) || level < 1 || level > 9) {
    console.error('Level must be between 1 and 9');
    process.exit(1);
  }
  const outIndex = args.indexOf('--out');
  const out = outIndex !== -1 ? args[outIndex + 1] : undefined;
  return { level, out };
}

function main() {
  const { level, out } = parseArgs();

  const wordlistPath = path.resolve(__dirname, 'wordlists', `hsk${level}.json`);
  if (!fs.existsSync(wordlistPath)) {
    console.error(`Wordlist not found: ${wordlistPath}`);
    process.exit(1);
  }

  let words: WordEntry[];
  try {
    words = JSON.parse(fs.readFileSync(wordlistPath, 'utf-8')) as WordEntry[];
  } catch (err) {
    console.error(`Could not parse wordlist ${wordlistPath}: ${err}`);
    process.exit(1);
  }

  const workDir = out ?? path.resolve(__dirname, '.work', `hsk${level}`);
  const promptsDir = path.join(workDir, 'prompts');
  const rawDir = path.join(workDir, 'raw');
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.mkdirSync(rawDir, { recursive: true });

  const allowedWordList = buildAllowedWordList(words);
  const batches = chunk(words, CHUNK_SIZE);

  const manifest = batches.map((batchWords, i) => {
    const num = String(i + 1).padStart(2, '0');
    const promptFile = path.join(promptsDir, `batch-${num}.md`);
    const rawFile = path.join(rawDir, `batch-${num}.json`);
    fs.writeFileSync(promptFile, buildPrompt(level, batchWords, allowedWordList), 'utf-8');
    return {
      batch: num,
      words: batchWords.map((w) => w.characters),
      prompt: path.relative(process.cwd(), promptFile),
      raw: path.relative(process.cwd(), rawFile),
    };
  });

  fs.writeFileSync(
    path.join(workDir, 'manifest.json'),
    JSON.stringify({ level, chunkSize: CHUNK_SIZE, batches: manifest }, null, 2),
    'utf-8'
  );

  console.log(`Emitted ${batches.length} batch prompts for HSK ${level}`);
  console.log(`  words:    ${words.length}`);
  console.log(`  prompts:  ${path.relative(process.cwd(), promptsDir)}/batch-*.md`);
  console.log(`  raw out:  ${path.relative(process.cwd(), rawDir)}/batch-*.json`);
  console.log(`  manifest: ${path.relative(process.cwd(), path.join(workDir, 'manifest.json'))}`);
  console.log('\nNext: run each prompt through a Claude Code subagent, saving its');
  console.log('JSON array to the matching raw/ file, then run:');
  console.log(`  npx ts-node --project scripts/tsconfig.json scripts/assemble.ts --level ${level}`);
}

main();
