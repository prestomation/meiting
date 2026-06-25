/**
 * generation.ts — shared, deterministic content-generation helpers.
 *
 * This module holds everything EXCEPT the act of producing sentences from a
 * prompt. Sentence production is done by Claude Code subagents (see
 * scripts/emit-batches.ts + scripts/assemble.ts and scripts/README.md), not by
 * a direct Anthropic API call. Keeping the prompt builder, response parser,
 * vocabulary validator, and item assembler here lets both the batch emitter and
 * the assembler share identical logic.
 */
import { buildAllowedChars, validateSentence, getSentenceLengthLimit } from '../vocab';
import { selectDistractors } from '../distractors';

export type HskLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface WordEntry {
  characters: string;
  pinyin: string;
  english: string;
}

export interface ContentItem {
  id: string;
  hsk: HskLevel;
  type: 'sentence';
  characters: string;
  pinyin: string;
  english: string;
  audio?: Record<string, string>;
  distractors: string[];
}

export interface RawSentence {
  characters: string;
  pinyin: string;
  english: string;
  focus_word?: string;
  keyword?: string; // legacy field
}

export const CHUNK_SIZE = 50;
export const REQUIRED_DISTRACTORS = 3;

/** Split an array into fixed-size chunks. */
export function chunk<T>(items: T[], size: number = CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Build the generation prompt for one batch of focus words. */
export function buildPrompt(level: number, words: WordEntry[], allowedWordList: string): string {
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

/** Pull a JSON array out of arbitrary model text (tolerates code fences / truncation). */
export function extractJSON(text: string): string {
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

/** Parse + shape a raw batch response into RawSentence[]. Throws if nothing usable. */
export function parseAndValidate(raw: string): RawSentence[] {
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

export interface VocabFilterResult {
  valid: RawSentence[];
  rejected: { sentence: RawSentence; reason: string }[];
}

/** Filter sentences to those whose every character is in-level and within the length limit. */
export function filterByVocabulary(
  sentences: RawSentence[],
  allowedChars: Set<string>,
  lengthLimit: number
): VocabFilterResult {
  const valid: RawSentence[] = [];
  const rejected: { sentence: RawSentence; reason: string }[] = [];

  for (const sentence of sentences) {
    const validation = validateSentence(sentence.characters, allowedChars);
    const chineseChars = sentence.characters.replace(/[^一-鿿]/g, '');

    if (!validation.valid) {
      rejected.push({ sentence, reason: `out-of-level chars: ${validation.violations.join(', ')}` });
    } else if (chineseChars.length > lengthLimit) {
      rejected.push({ sentence, reason: `too long (${chineseChars.length} > ${lengthLimit})` });
    } else {
      valid.push(sentence);
    }
  }

  return { valid, rejected };
}

export interface AssembleResult {
  items: ContentItem[];
  added: number;
  insufficientDistractors: ContentItem[];
}

/**
 * Merge new raw sentences into the existing item list:
 *  - drop sentences whose characters already exist (idempotent / dedupe)
 *  - assign sequential IDs (hsk{level}-s-NNNN)
 *  - pick phonetic distractors from the full pool (existing + new)
 *
 * Returns the merged list; never overwrites already-generated sentences.
 */
export function assembleItems(
  level: number,
  existing: ContentItem[],
  rawSentences: RawSentence[]
): AssembleResult {
  const seen = new Set(existing.map((item) => item.characters));

  const fresh: RawSentence[] = [];
  for (const s of rawSentences) {
    if (seen.has(s.characters)) continue;
    seen.add(s.characters);
    fresh.push(s);
  }

  const newItems: ContentItem[] = fresh.map((s, i) => {
    const globalIndex = existing.length + i + 1;
    return {
      id: `hsk${level}-s-${String(globalIndex).padStart(4, '0')}`,
      hsk: level as HskLevel,
      type: 'sentence',
      characters: s.characters,
      pinyin: s.pinyin,
      english: s.english,
      distractors: [],
    };
  });

  const pool = [...existing, ...newItems].map((item) => ({
    id: item.id,
    characters: item.characters,
  }));

  for (const item of newItems) {
    item.distractors = selectDistractors({ id: item.id, characters: item.characters }, pool);
  }

  const insufficientDistractors = newItems.filter(
    (item) => item.distractors.length < REQUIRED_DISTRACTORS
  );

  return {
    items: [...existing, ...newItems],
    added: newItems.length,
    insufficientDistractors,
  };
}

/** Build the prompt-facing allowed-word list (the level's own wordlist). */
export function buildAllowedWordList(words: WordEntry[]): string {
  return words.map((w) => `${w.characters} (${w.pinyin})`).join(', ');
}

export { buildAllowedChars, getSentenceLengthLimit };
