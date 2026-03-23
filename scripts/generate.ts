#!/usr/bin/env ts-node
/**
 * generate.ts — HSK sentence content generator
 *
 * Reads a wordlist from scripts/wordlists/hsk[N].json
 * Calls Anthropic API in chunked batches to generate sentences
 * Outputs to src/data/hsk[N].json
 * Idempotent: skips already-generated items
 * Strict: validates every sentence against HSK vocabulary, retries once on failure
 *
 * Usage:
 *   npx ts-node scripts/generate.ts --level 1
 *   npx ts-node scripts/generate.ts --level 1 --fresh   # clears existing data first
 */

import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { buildAllowedChars, validateSentence, getSentenceLengthLimit } from './vocab';
import { selectDistractors } from './distractors';

// ---- Types ----

interface WordEntry {
  characters: string;
  pinyin: string;
  english: string;
}

interface ContentItem {
  id: string;
  hsk: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  type: 'sentence';
  characters: string;
  pinyin: string;
  english: string;
  audio?: string;
  distractors: string[];
}

interface RawSentence {
  characters: string;
  pinyin: string;
  english: string;
  focus_word?: string;
  keyword?: string; // legacy field
}

// ---- Args ----

function parseArgs(): { level: number; fresh: boolean } {
  const args = process.argv.slice(2);
  const levelIndex = args.indexOf('--level');
  if (levelIndex === -1 || !args[levelIndex + 1]) {
    console.error('Usage: npx ts-node scripts/generate.ts --level <1-9> [--fresh]');
    process.exit(1);
  }
  const level = parseInt(args[levelIndex + 1], 10);
  if (isNaN(level) || level < 1 || level > 9) {
    console.error('Level must be between 1 and 9');
    process.exit(1);
  }
  const fresh = args.includes('--fresh');
  return { level, fresh };
}

// ---- Paths ----

function getWordlistPath(level: number): string {
  return path.resolve(__dirname, 'wordlists', `hsk${level}.json`);
}

function getOutputPath(level: number): string {
  return path.resolve(__dirname, '..', 'src', 'data', `hsk${level}.json`);
}

// ---- Load existing ----

function loadExisting(outputPath: string): ContentItem[] {
  if (!fs.existsSync(outputPath)) return [];
  try {
    const raw = fs.readFileSync(outputPath, 'utf-8');
    return JSON.parse(raw) as ContentItem[];
  } catch {
    console.warn(`Warning: could not parse existing ${outputPath}, starting fresh.`);
    return [];
  }
}

// ---- Prompt ----

function buildPrompt(level: number, words: WordEntry[], allowedWordList: string): string {
  const lengthLimit = getSentenceLengthLimit(level);
  const forbiddenGrammar =
    level === 1
      ? '\n- FORBIDDEN grammar: 把, 被, 连...都, 虽然, 但是, 如果, 只要, 除非, 即使'
      : '';

  return `You are creating Chinese language learning content for absolute beginners studying HSK level ${level}.

CRITICAL CONSTRAINT: Every Chinese character in every sentence you write MUST appear in this allowed vocabulary list. Do not use ANY character outside this list. This is a hard rule — violating it makes the sentence unusable for learners.

Allowed vocabulary (every character in your sentences must come from words in this list):
${allowedWordList}

Additional always-allowed single characters (grammatical particles): 的 了 吗 呢 吧 也 都 就 很 不 有 在 是 个

Rules:
- Generate exactly 2 sentences per focus word
- Each sentence must primarily feature the focus word
- Maximum ${lengthLimit} Chinese characters per sentence (short and simple)
- Use ONLY the vocabulary above — no exceptions
- Sentences must be natural, practical Chinese a beginner would actually say or hear${forbiddenGrammar}

Focus words for this batch (${words.length} words):
${words.map((w) => `${w.characters} (${w.pinyin}) = ${w.english}`).join('\n')}

Return ONLY a JSON array. No markdown, no code blocks, no explanation.
Each object must have exactly these fields:
{
  "focus_word": "<the focus word characters>",
  "characters": "<the complete sentence in Chinese>",
  "pinyin": "<full pinyin with tone marks>",
  "english": "<natural English translation>"
}`;
}

// ---- Parse & validate LLM response ----

function extractJSON(text: string): string {
  let cleaned = text;

  const completeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (completeBlock) {
    cleaned = completeBlock[1].trim();
  } else {
    const partialBlock = cleaned.match(/```(?:json)?\s*([\s\S]*)/);
    if (partialBlock) {
      cleaned = partialBlock[1].trim();
    }
  }

  const startIdx = cleaned.indexOf('[');
  if (startIdx === -1) throw new Error('No JSON array found in response');

  const endIdx = cleaned.lastIndexOf(']');
  if (endIdx === -1 || endIdx < startIdx) {
    const truncated = cleaned.slice(startIdx);
    const lastCompleteObj = truncated.lastIndexOf('},');
    if (lastCompleteObj === -1) throw new Error('No JSON array found in response');
    return truncated.slice(0, lastCompleteObj + 1) + ']';
  }

  return cleaned.slice(startIdx, endIdx + 1);
}

function parseAndValidate(raw: string): RawSentence[] {
  const jsonStr = extractJSON(raw);
  const parsed = JSON.parse(jsonStr);
  if (!Array.isArray(parsed)) throw new Error('Expected JSON array');

  const valid: RawSentence[] = [];
  for (const item of parsed) {
    if (
      typeof item.characters === 'string' &&
      typeof item.pinyin === 'string' &&
      typeof item.english === 'string'
    ) {
      valid.push({
        characters: item.characters.trim(),
        pinyin: item.pinyin.trim(),
        english: item.english.trim(),
        focus_word:
          typeof item.focus_word === 'string'
            ? item.focus_word.trim()
            : typeof item.keyword === 'string'
              ? item.keyword.trim()
              : undefined,
      });
    }
  }

  if (valid.length === 0) throw new Error('No valid sentences found in response');
  return valid;
}

// ---- Validate chunk against vocabulary ----

function validateChunk(
  sentences: RawSentence[],
  words: WordEntry[],
  allowedChars: Set<string>,
  lengthLimit: number
): { valid: RawSentence[]; failedWords: WordEntry[] } {
  const valid: RawSentence[] = [];
  const failedWordChars = new Set<string>();

  for (const sentence of sentences) {
    const validation = validateSentence(sentence.characters, allowedChars);
    const chineseChars = sentence.characters.replace(/[^\u4e00-\u9fff]/g, '');

    if (!validation.valid) {
      console.log(
        `  ✗ REJECTED "${sentence.characters}" — out-of-level chars: ${validation.violations.join(', ')}`
      );
      const focusWord = sentence.focus_word;
      if (focusWord) failedWordChars.add(focusWord);
    } else if (chineseChars.length > lengthLimit) {
      console.log(
        `  ✗ REJECTED "${sentence.characters}" — too long (${chineseChars.length} > ${lengthLimit})`
      );
      const focusWord = sentence.focus_word;
      if (focusWord) failedWordChars.add(focusWord);
    } else {
      valid.push(sentence);
    }
  }

  const failedWords = words.filter((w) => failedWordChars.has(w.characters));
  return { valid, failedWords };
}

// ---- Main ----

async function main() {
  const { level, fresh } = parseArgs();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is not set');
    process.exit(1);
  }

  const wordlistPath = getWordlistPath(level);
  const outputPath = getOutputPath(level);

  if (!fs.existsSync(wordlistPath)) {
    console.error(`Wordlist not found: ${wordlistPath}`);
    process.exit(1);
  }

  const words: WordEntry[] = JSON.parse(fs.readFileSync(wordlistPath, 'utf-8'));
  console.log(`Loaded ${words.length} words from HSK ${level} wordlist`);

  // Fresh mode: clear existing data
  if (fresh) {
    console.log('--fresh flag: clearing existing data');
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, '[]', 'utf-8');
  }

  const existing = loadExisting(outputPath);
  console.log(`Found ${existing.length} existing items in output`);

  const existingCharacters = new Set(existing.map((item) => item.characters));

  const isOAuthToken = apiKey.startsWith('sk-ant-oat');
  const client = new Anthropic(
    isOAuthToken
      ? { authToken: apiKey, defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' } }
      : { apiKey }
  );

  const allowedChars = buildAllowedChars(level);
  const lengthLimit = getSentenceLengthLimit(level);

  // Build allowed word list string for prompt
  const allHskWords: WordEntry[] = JSON.parse(fs.readFileSync(wordlistPath, 'utf-8'));
  const allowedWordList = allHskWords.map((w) => `${w.characters} (${w.pinyin})`).join(', ');

  console.log(`Allowed chars set size: ${allowedChars.size}`);
  console.log(`Sentence length limit: ${lengthLimit} chars`);

  const CHUNK_SIZE = 50;
  const allNewSentences: RawSentence[] = [];
  let totalRejected = 0;
  let totalGenerated = 0;

  console.log(`\nGenerating sentences for HSK ${level}...`);
  console.log(`Processing ${words.length} words in chunks of ${CHUNK_SIZE}`);

  for (let chunkStart = 0; chunkStart < words.length; chunkStart += CHUNK_SIZE) {
    const chunk = words.slice(chunkStart, chunkStart + CHUNK_SIZE);
    const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, words.length);
    const chunkNum = Math.floor(chunkStart / CHUNK_SIZE) + 1;
    console.log(`\nChunk ${chunkNum}: words ${chunkStart + 1}–${chunkEnd}`);

    const prompt = buildPrompt(level, chunk, allowedWordList);

    let chunkSentences: RawSentence[] = [];

    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        console.error('Unexpected response type:', content.type);
        continue;
      }

      try {
        chunkSentences = parseAndValidate(content.text);
      } catch (parseErr) {
        const preview = content.text.slice(0, 200).replace(/\n/g, '\\n');
        console.error(`  Parse error. Raw response preview: ${preview}`);
        continue;
      }

      totalGenerated += chunkSentences.length;
      console.log(`  Generated ${chunkSentences.length} sentences`);

      // Validate chunk
      const { valid: validSentences, failedWords } = validateChunk(
        chunkSentences,
        chunk,
        allowedChars,
        lengthLimit
      );
      totalRejected += chunkSentences.length - validSentences.length;

      console.log(
        `  Valid: ${validSentences.length}, Rejected: ${chunkSentences.length - validSentences.length}`
      );

      // One retry for failed words
      let retrySentences: RawSentence[] = [];
      if (failedWords.length > 0) {
        console.log(`  Retrying ${failedWords.length} failed words...`);
        const retryPrompt = buildPrompt(level, failedWords, allowedWordList);

        try {
          const retryResponse = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 4096,
            messages: [{ role: 'user', content: retryPrompt }],
          });

          const retryContent = retryResponse.content[0];
          if (retryContent.type === 'text') {
            const retryCandidates = parseAndValidate(retryContent.text);
            totalGenerated += retryCandidates.length;
            const { valid: retryValid } = validateChunk(
              retryCandidates,
              failedWords,
              allowedChars,
              lengthLimit
            );
            totalRejected += retryCandidates.length - retryValid.length;
            retrySentences = retryValid;
            console.log(`  Retry recovered: ${retryValid.length}/${retryCandidates.length}`);
          }
        } catch (retryErr) {
          console.error(`  Retry failed:`, retryErr);
        }
      }

      const allValid = [...validSentences, ...retrySentences];

      // Filter out duplicates
      const newSentences = allValid.filter((s) => !existingCharacters.has(s.characters));
      allNewSentences.push(...newSentences);
      newSentences.forEach((s) => existingCharacters.add(s.characters));

      // Small delay to avoid rate limits
      if (chunkEnd < words.length) {
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (err) {
      console.error(`Error processing chunk ${chunkNum}:`, err);
    }
  }

  const passRate =
    totalGenerated > 0
      ? (((totalGenerated - totalRejected) / totalGenerated) * 100).toFixed(1)
      : (0).toFixed(1);
  console.log(`\n=== Generation complete ===`);
  console.log(`Total generated: ${totalGenerated}`);
  console.log(`Total rejected: ${totalRejected}`);
  console.log(`Pass rate: ${passRate}%`);
  console.log(`New valid sentences: ${allNewSentences.length}`);

  if (allNewSentences.length === 0) {
    console.log('No new sentences to add. Output is up to date.');
    return;
  }

  // Build ContentItems WITHOUT distractors first
  const newItemsNoDistractors: ContentItem[] = allNewSentences.map((s, i) => {
    const globalIndex = existing.length + i + 1;
    const id = `hsk${level}-s-${String(globalIndex).padStart(4, '0')}`;
    return {
      id,
      hsk: level as ContentItem['hsk'],
      type: 'sentence',
      characters: s.characters,
      pinyin: s.pinyin,
      english: s.english,
      distractors: [],
    };
  });

  // Build full pool for distractor selection (existing + new)
  const allItemsPool = [...existing, ...newItemsNoDistractors];
  const poolForDistractors = allItemsPool.map((item) => ({
    id: item.id,
    characters: item.characters,
  }));

  const REQUIRED_DISTRACTORS = 3;
  if (poolForDistractors.length <= REQUIRED_DISTRACTORS) {
    console.warn(
      `Warning: pool size (${poolForDistractors.length}) is too small to guarantee ${REQUIRED_DISTRACTORS} distractors per sentence. Some items may have fewer distractors.`
    );
  }

  console.log(`\nAssigning phonetic distractors from pool of ${allItemsPool.length} sentences...`);

  // Assign distractors to new items
  for (const item of newItemsNoDistractors) {
    item.distractors = selectDistractors(
      { id: item.id, characters: item.characters },
      poolForDistractors
    );
  }

  // Merge and save
  const allItems = [...existing, ...newItemsNoDistractors];

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  fs.writeFileSync(outputPath, JSON.stringify(allItems, null, 2), 'utf-8');
  console.log(`\nSaved ${allItems.length} total items to ${outputPath}`);
  console.log(`  (${existing.length} existing + ${newItemsNoDistractors.length} new)`);

  // Print sample
  if (newItemsNoDistractors.length > 0) {
    console.log('\nSample generated items:');
    const sample = newItemsNoDistractors.slice(0, 3);
    for (const item of sample) {
      console.log(`  [${item.id}] ${item.characters}`);
      console.log(`    ${item.pinyin}`);
      console.log(`    "${item.english}"`);
      console.log(`    Distractors: ${item.distractors.slice(0, 2).join(' | ')}...`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
