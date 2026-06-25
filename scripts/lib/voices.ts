/**
 * voices.ts — Voice recipes and content-addressed cache keys for MěiTīng audio.
 *
 * The cache key for a piece of audio is a hash over a canonical "recipe" object
 * AND the text. The recipe pins every input that changes the output bytes
 * (voice, model/engine, output format, sample rate, voice settings, …) so that:
 *
 *   - identical recipe + text  → identical key → permanent cache hit
 *   - any knob changes         → new key       → regenerates
 *   - edited sentence text     → new key       → old audio auto-invalidated
 *   - duplicate sentences      → same key      → deduped across levels
 *
 * Incidental config (API keys, concurrency, retry delays) is NOT part of the
 * recipe — it doesn't affect the bytes.
 *
 * Keep VoiceProvider in sync with src/lib/storage.ts (string literals must match).
 */

import { createHash } from 'crypto';

export type VoiceProvider = 'polly-zhiyu' | 'elevenlabs-haoran';

export interface PollyRecipe {
  service: 'polly';
  voiceId: string;
  engine: string;
  languageCode: string;
  textType: string;
  outputFormat: string;
  /** Pinned explicitly — Polly otherwise picks a default that would not be captured here. */
  sampleRate: string;
}

export interface ElevenLabsRecipe {
  service: 'elevenlabs';
  voiceId: string;
  modelId: string;
  /** Encodes both sample rate and bitrate, e.g. mp3_44100_128. */
  outputFormat: string;
  voiceSettings: {
    stability: number;
    similarity_boost: number;
  };
}

export type VoiceRecipe = PollyRecipe | ElevenLabsRecipe;

/**
 * The single source of truth for how each voice is synthesized. The generator
 * passes these exact params to the TTS API, so the produced bytes always match
 * the cache key derived from the recipe.
 */
export const VOICE_RECIPES: Record<VoiceProvider, VoiceRecipe> = {
  'polly-zhiyu': {
    service: 'polly',
    voiceId: 'Zhiyu',
    engine: 'neural',
    languageCode: 'cmn-CN',
    textType: 'text',
    outputFormat: 'mp3',
    sampleRate: '24000',
  },
  'elevenlabs-haoran': {
    service: 'elevenlabs',
    voiceId: 'pU9NaAwkoR3v0Mrg3uKz',
    modelId: 'eleven_multilingual_v2',
    outputFormat: 'mp3_44100_128',
    voiceSettings: {
      stability: 0.5,
      similarity_boost: 0.75,
    },
  },
};

/**
 * Deterministic JSON: object keys sorted recursively so the serialization (and
 * therefore the hash) does not depend on key insertion order.
 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** 16 hex chars (64 bits) of SHA-256 — ample to avoid collisions across a corpus this size. */
const HASH_LEN = 16;

/** R2 object key for a given voice + text, e.g. `polly-zhiyu-1a2b3c4d5e6f7a8b.mp3`. */
export function audioCacheKey(voice: VoiceProvider, text: string): string {
  const recipe = VOICE_RECIPES[voice];
  const digest = createHash('sha256')
    .update(canonicalJSON({ recipe, text }))
    .digest('hex')
    .slice(0, HASH_LEN);
  return `${voice}-${digest}.mp3`;
}

/** Public URL for a given voice + text under the configured R2 public base. */
export function audioCacheUrl(voice: VoiceProvider, text: string, publicBase: string): string {
  return `${publicBase.replace(/\/+$/, '')}/${audioCacheKey(voice, text)}`;
}

/** True if `url`'s filename is a content-addressed key this voice's generator would produce. */
export function isCasUrl(url: string, voice: VoiceProvider): boolean {
  const file = url.split('/').pop() ?? '';
  return new RegExp(`^${voice}-[0-9a-f]{${HASH_LEN}}\\.mp3$`).test(file);
}

/**
 * Whether the recorded audio URL is up to date for the given text, deciding if
 * the generator should (re)synthesize:
 *   - no URL                              → not current (generate)
 *   - matches the expected CAS URL        → current (skip)
 *   - a CAS URL for this voice, but stale → not current (text/recipe changed → regenerate)
 *   - any other (legacy, non-CAS) URL     → current (respected as-is, no needless re-synthesis)
 *
 * The last case is what preserves existing pre-CAS audio (e.g. migrated Polly
 * URLs) instead of regenerating it.
 */
export function audioIsCurrent(
  url: string | undefined,
  voice: VoiceProvider,
  text: string,
  publicBase: string,
): boolean {
  if (!url) return false;
  if (url === audioCacheUrl(voice, text, publicBase)) return true;
  if (isCasUrl(url, voice)) return false; // CAS-managed but no longer matches → stale
  return true; // legacy / externally-named URL — leave it alone
}
