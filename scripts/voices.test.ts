import { describe, it, expect } from 'vitest';
import { audioCacheKey, canonicalJSON, VOICE_RECIPES } from './lib/voices';

describe('audioCacheKey (content-addressed caching)', () => {
  it('is stable for the same voice + text', () => {
    const a = audioCacheKey('polly-zhiyu', '你好');
    const b = audioCacheKey('polly-zhiyu', '你好');
    expect(a).toBe(b);
  });

  it('produces a key prefixed by the voice id and ending in .mp3', () => {
    expect(audioCacheKey('elevenlabs-haoran', '你好')).toMatch(/^elevenlabs-haoran-[0-9a-f]{16}\.mp3$/);
  });

  it('changes when the text changes', () => {
    expect(audioCacheKey('polly-zhiyu', '你好')).not.toBe(audioCacheKey('polly-zhiyu', '再见'));
  });

  it('differs between voices for identical text', () => {
    expect(audioCacheKey('polly-zhiyu', '你好')).not.toBe(audioCacheKey('elevenlabs-haoran', '你好'));
  });

  it('changes when a recipe knob (e.g. sample rate) changes', () => {
    const text = '你好';
    const before = audioCacheKey('polly-zhiyu', text);
    const original = (VOICE_RECIPES['polly-zhiyu'] as { sampleRate: string }).sampleRate;
    (VOICE_RECIPES['polly-zhiyu'] as { sampleRate: string }).sampleRate = '16000';
    try {
      expect(audioCacheKey('polly-zhiyu', text)).not.toBe(before);
    } finally {
      (VOICE_RECIPES['polly-zhiyu'] as { sampleRate: string }).sampleRate = original;
    }
  });
});

describe('canonicalJSON', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalJSON({ a: 1, b: 2 })).toBe(canonicalJSON({ b: 2, a: 1 }));
  });
});
