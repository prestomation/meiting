#!/usr/bin/env ts-node
/**
 * distractors.ts — selects 3 phonetically plausible but wrong distractors
 * for each sentence from the pool of generated sentences at the same level.
 *
 * Strategy:
 * 1. Convert all sentences to pinyin arrays (using pinyin-pro)
 * 2. For each target sentence, find sentences that share ≥1 pinyin syllable
 *    OR have same sentence length (±1 char) — these "look possible"
 * 3. From those candidates, exclude the correct answer
 * 4. Pick 3 by score (most phonetically similar but most lexically different)
 */
import { pinyin } from 'pinyin-pro';

interface SentenceEntry {
  id: string;
  characters: string;
}

function toPinyinSyllables(text: string): string[] {
  return pinyin(text, { toneType: 'none', type: 'array', nonZh: 'removed' });
}

function phoneticSimilarity(a: string, b: string): number {
  const syllablesA = toPinyinSyllables(a);
  const syllablesB = toPinyinSyllables(b);
  const setA = new Set(syllablesA);
  const setB = new Set(syllablesB);
  let shared = 0;
  for (const s of setA) {
    if (setB.has(s)) shared++;
  }
  return shared / Math.max(setA.size, setB.size, 1);
}

export function selectDistractors(
  target: SentenceEntry,
  pool: SentenceEntry[],
  count: number = 3
): string[] {
  const targetChineseLen = target.characters.replace(/[^\u4e00-\u9fff]/g, '').length;

  const candidates = pool
    .filter((s) => s.id !== target.id)
    .map((s) => ({
      sentence: s.characters,
      score: phoneticSimilarity(target.characters, s.characters),
      lengthDiff: Math.abs(
        s.characters.replace(/[^\u4e00-\u9fff]/g, '').length - targetChineseLen
      ),
    }))
    // Prefer phonetically similar OR same length
    .filter((s) => s.score > 0 || s.lengthDiff <= 1)
    // Sort: higher phonetic score first, then by length similarity
    .sort((a, b) => {
      const scoreB = b.score * 10 - b.lengthDiff;
      const scoreA = a.score * 10 - a.lengthDiff;
      return scoreB - scoreA;
    });

  // Pick top candidates, shuffle slightly for variety
  const top = candidates.slice(0, Math.min(count * 3, candidates.length));
  top.sort(() => Math.random() - 0.5);

  const result = top.slice(0, count).map((c) => c.sentence);

  // Fallback: if not enough phonetic matches, just grab random items from pool
  if (result.length < count) {
    const remaining = pool
      .filter((s) => s.id !== target.id && !result.includes(s.characters))
      .map((s) => s.characters);
    remaining.sort(() => Math.random() - 0.5);
    result.push(...remaining.slice(0, count - result.length));
  }

  return result;
}
