import { describe, it, expect } from 'vitest';
import {
  audioCacheKey,
  audioCacheUrl,
  audioIsCurrent,
  isCasUrl,
  canonicalJSON,
  VOICE_RECIPES,
} from './lib/voices';

const BASE = 'https://pub-test.r2.dev';

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

describe('audioIsCurrent (regeneration decision)', () => {
  it('returns false when there is no URL (needs generation)', () => {
    expect(audioIsCurrent(undefined, 'elevenlabs-haoran', '你好', BASE)).toBe(false);
  });

  it('returns true for the matching content-addressed URL', () => {
    const url = audioCacheUrl('polly-zhiyu', '你好', BASE);
    expect(audioIsCurrent(url, 'polly-zhiyu', '你好', BASE)).toBe(true);
  });

  it('returns false for a CAS URL of this voice that no longer matches (text changed)', () => {
    const staleUrl = audioCacheUrl('polly-zhiyu', '你好', BASE); // generated for old text
    expect(audioIsCurrent(staleUrl, 'polly-zhiyu', '再见', BASE)).toBe(false);
  });

  it('respects a legacy (pre-CAS) URL instead of regenerating it', () => {
    // This is the migrated Polly case: old short-scheme filename, not a CAS key.
    const legacy = `${BASE}/hsk1-s-0001.mp3`;
    expect(audioIsCurrent(legacy, 'polly-zhiyu', '你好', BASE)).toBe(true);
  });
});

describe('isCasUrl', () => {
  it('recognizes a CAS key for the voice', () => {
    expect(isCasUrl(audioCacheUrl('polly-zhiyu', 'x', BASE), 'polly-zhiyu')).toBe(true);
  });
  it('rejects a legacy filename', () => {
    expect(isCasUrl(`${BASE}/hsk1-s-0001.mp3`, 'polly-zhiyu')).toBe(false);
  });
  it('does not match a CAS key belonging to a different voice', () => {
    expect(isCasUrl(audioCacheUrl('elevenlabs-haoran', 'x', BASE), 'polly-zhiyu')).toBe(false);
  });
});

describe('canonicalJSON', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalJSON({ a: 1, b: 2 })).toBe(canonicalJSON({ b: 2, a: 1 }));
  });
});
