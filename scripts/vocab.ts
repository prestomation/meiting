#!/usr/bin/env ts-node
/**
 * vocab.ts — builds the cumulative allowed character set for a given HSK level
 * Loads wordlists 1..N and returns a Set of all individual Chinese characters
 */
import * as fs from 'fs';
import * as path from 'path';

// Grammatical particles/function words unavoidable in natural Chinese
// These are not in HSK wordlists but are essential connective tissue
export const ALWAYS_ALLOWED = new Set(
  '的了吗呢吧也都就很不有在是个一二三四五六七八九十这那他她它我你们里上下来去说看做想知道什么哪为什么怎么啊哦哈嗯'.split('')
);

export function buildAllowedChars(level: number): Set<string> {
  const allowed = new Set(ALWAYS_ALLOWED);

  for (let l = 1; l <= level; l++) {
    const wordlistPath = path.resolve(__dirname, 'wordlists', `hsk${l}.json`);
    if (!fs.existsSync(wordlistPath)) continue;

    const words: Array<{ characters: string }> = JSON.parse(
      fs.readFileSync(wordlistPath, 'utf-8')
    );

    for (const word of words) {
      // Add every individual character from every word
      for (const char of word.characters) {
        allowed.add(char);
      }
    }
  }

  return allowed;
}

export function validateSentence(
  sentence: string,
  allowedChars: Set<string>
): { valid: boolean; violations: string[] } {
  // Strip punctuation — only validate Chinese characters
  const chineseOnly = sentence.replace(/[^\u4e00-\u9fff]/g, '');
  const violations: string[] = [];

  for (const char of chineseOnly) {
    if (!allowedChars.has(char)) {
      violations.push(char);
    }
  }

  return {
    valid: violations.length === 0,
    violations: [...new Set(violations)], // dedupe
  };
}

export function getSentenceLengthLimit(level: number): number {
  const limits: Record<number, number> = {
    1: 8,
    2: 12,
    3: 16,
    4: 20,
    5: 25,
    6: 30,
    7: 35,
    8: 40,
    9: 50,
  };
  return limits[level] ?? 30;
}
