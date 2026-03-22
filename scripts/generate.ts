#!/usr/bin/env ts-node
/**
 * generate.ts — HSK sentence content generator
 *
 * Reads a wordlist from scripts/wordlists/hsk[N].json
 * Calls Anthropic API (ONE batched request) to generate sentences
 * Outputs to src/data/hsk[N].json
 * Idempotent: skips already-generated items
 *
 * Usage:
 *   npx ts-node scripts/generate.ts --level 1
 *   npx ts-node scripts/generate.ts --level 2
 */

import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';

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

// ---- Args ----

function parseArgs(): { level: number } {
  const args = process.argv.slice(2);
  const levelIndex = args.indexOf('--level');
  if (levelIndex === -1 || !args[levelIndex + 1]) {
    console.error('Usage: npx ts-node scripts/generate.ts --level <1-9>');
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

function buildPrompt(level: number, words: WordEntry[]): string {
  const wordListStr = words
    .map((w) => `${w.characters} (${w.pinyin}) = ${w.english}`)
    .join('\n');

  return `You are creating Chinese language learning content for HSK level ${level} learners.

Given the following HSK ${level} vocabulary list, generate natural example sentences.

Rules:
- Each sentence must be a complete, natural Chinese sentence
- Each sentence must primarily feature one word from the wordlist
- Sentences should use vocabulary appropriate for HSK level ${level}
- Be practically useful for everyday communication
- Generate exactly 3 sentences per word

Wordlist (${words.length} words):
${wordListStr}

Return ONLY a JSON array with NO markdown formatting, NO code blocks, NO explanation.
Each object must have exactly these fields:
- "characters": the Chinese sentence (汉字)
- "pinyin": pinyin with tone marks (ā á ǎ à, not numbers)
- "english": natural English translation
- "keyword": the vocabulary word from the list being demonstrated

Example format: [{"characters":"你好，很高兴认识你。","pinyin":"Nǐ hǎo, hěn gāoxìng rènshi nǐ.","english":"Hello, nice to meet you.","keyword":"你好"}]

Output the JSON array only:`;
}

// ---- Parse & validate LLM response ----

interface RawSentence {
  characters: string;
  pinyin: string;
  english: string;
  keyword?: string;
}

function extractJSON(text: string): string {
  // Strip markdown code blocks if present (including partial/truncated code blocks)
  let cleaned = text;

  // Try to match complete code block first
  const completeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (completeBlock) {
    cleaned = completeBlock[1].trim();
  } else {
    // Handle truncated/partial code block - strip opening fence
    const partialBlock = cleaned.match(/```(?:json)?\s*([\s\S]*)/);
    if (partialBlock) {
      cleaned = partialBlock[1].trim();
    }
  }

  // Try to find JSON array in the response
  const startIdx = cleaned.indexOf('[');
  if (startIdx === -1) {
    throw new Error('No JSON array found in response');
  }

  // Find the last valid closing bracket
  const endIdx = cleaned.lastIndexOf(']');
  if (endIdx === -1 || endIdx < startIdx) {
    // Try to repair truncated JSON by finding the last complete object
    const truncated = cleaned.slice(startIdx);
    const lastCompleteObj = truncated.lastIndexOf('},');
    if (lastCompleteObj === -1) throw new Error('No JSON array found in response');
    // Reconstruct array with last complete object
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
        keyword: typeof item.keyword === 'string' ? item.keyword.trim() : undefined,
      });
    }
  }

  if (valid.length === 0) throw new Error('No valid sentences found in response');
  return valid;
}

// ---- Assign IDs and distractors ----

function buildContentItems(
  level: number,
  sentences: RawSentence[],
  existingCount: number
): ContentItem[] {
  const items: ContentItem[] = [];

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const globalIndex = existingCount + i + 1;
    const id = `hsk${level}-s-${String(globalIndex).padStart(4, '0')}`;

    // Pick 3 distractors: other sentences from the batch that are NOT this sentence
    // Pick ones that are structurally similar but have different meaning
    const candidates = sentences.filter((_, idx) => idx !== i);
    const distractors: string[] = [];

    // Try to pick distractors that are similar length
    const targetLen = s.characters.length;
    const sorted = candidates
      .map((c, idx) => ({ c, idx, diff: Math.abs(c.characters.length - targetLen) }))
      .sort((a, b) => a.diff - b.diff);

    for (const { c } of sorted) {
      if (distractors.length >= 3) break;
      if (!distractors.includes(c.characters)) {
        distractors.push(c.characters);
      }
    }

    // Fallback: just pick first 3 different sentences
    if (distractors.length < 3) {
      for (const c of candidates) {
        if (distractors.length >= 3) break;
        if (!distractors.includes(c.characters)) {
          distractors.push(c.characters);
        }
      }
    }

    items.push({
      id,
      hsk: level as ContentItem['hsk'],
      type: 'sentence',
      characters: s.characters,
      pinyin: s.pinyin,
      english: s.english,
      distractors,
    });
  }

  return items;
}

// ---- Main ----

async function main() {
  const { level } = parseArgs();

  // Check API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is not set');
    process.exit(1);
  }

  const wordlistPath = getWordlistPath(level);
  const outputPath = getOutputPath(level);

  // Load wordlist
  if (!fs.existsSync(wordlistPath)) {
    console.error(`Wordlist not found: ${wordlistPath}`);
    process.exit(1);
  }
  const words: WordEntry[] = JSON.parse(fs.readFileSync(wordlistPath, 'utf-8'));
  console.log(`Loaded ${words.length} words from HSK ${level} wordlist`);

  // Load existing items
  const existing = loadExisting(outputPath);
  console.log(`Found ${existing.length} existing items in output`);

  // Check which words already have sentences
  const existingCharacters = new Set(existing.map((item) => item.characters));

  // Build the Anthropic client
  // oat01 tokens are OAuth tokens - use authToken (Bearer) instead of apiKey (x-api-key)
  const isOAuthToken = apiKey.includes('sk-ant-oat');
  const client = new Anthropic({
    apiKey: isOAuthToken ? null : apiKey,
    authToken: isOAuthToken ? apiKey : null,
    defaultHeaders: isOAuthToken ? {
      'anthropic-beta': 'oauth-2025-04-20',
    } : {},
  });

  // We'll generate ALL sentences in batches to avoid token limits
  // Split wordlist into chunks of 50 words
  const CHUNK_SIZE = 50;
  const allNewSentences: RawSentence[] = [];

  console.log(`\nGenerating sentences for HSK ${level}...`);
  console.log(`Processing ${words.length} words in chunks of ${CHUNK_SIZE}`);

  for (let chunkStart = 0; chunkStart < words.length; chunkStart += CHUNK_SIZE) {
    const chunk = words.slice(chunkStart, chunkStart + CHUNK_SIZE);
    const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, words.length);
    console.log(`\nChunk ${Math.floor(chunkStart / CHUNK_SIZE) + 1}: words ${chunkStart + 1}–${chunkEnd}`);

    const prompt = buildPrompt(level, chunk);

    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8192,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        console.error('Unexpected response type:', content.type);
        continue;
      }

      let sentences: RawSentence[];
      try {
        sentences = parseAndValidate(content.text);
      } catch (parseErr) {
        // Log a snippet of the raw text for debugging
        const preview = content.text.slice(0, 200).replace(/\n/g, '\\n');
        console.error(`  Parse error. Raw response preview: ${preview}`);
        throw parseErr;
      }

      // Filter out sentences we already have
      const newSentences = sentences.filter(
        (s) => !existingCharacters.has(s.characters)
      );

      console.log(
        `  Generated ${sentences.length} sentences, ${newSentences.length} are new`
      );

      allNewSentences.push(...newSentences);

      // Add to set so we don't double-add in later chunks
      newSentences.forEach((s) => existingCharacters.add(s.characters));

      // Small delay to avoid rate limits
      if (chunkEnd < words.length) {
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (err) {
      console.error(`Error processing chunk ${Math.floor(chunkStart / CHUNK_SIZE) + 1}:`, err);
      // Continue with next chunk
    }
  }

  console.log(`\nTotal new sentences generated: ${allNewSentences.length}`);

  if (allNewSentences.length === 0) {
    console.log('No new sentences to add. Output is up to date.');
    return;
  }

  // Build content items with IDs and distractors
  const newItems = buildContentItems(level, allNewSentences, existing.length);

  // Merge and save
  const allItems = [...existing, ...newItems];

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(allItems, null, 2), 'utf-8');
  console.log(`\nSaved ${allItems.length} total items to ${outputPath}`);
  console.log(`  (${existing.length} existing + ${newItems.length} new)`);

  // Print a sample
  if (newItems.length > 0) {
    console.log('\nSample generated items:');
    const sample = newItems.slice(0, 3);
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
