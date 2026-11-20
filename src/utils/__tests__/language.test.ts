import { describe, expect, it } from 'vitest';

import { APP_LANGUAGES, isAppLanguage, normalizeLanguage } from '@/utils/language';
import { extractMessageDictionary } from '@/utils/localeMessages';

describe('normalizeLanguage', () => {
  it('normalizes empty values to en', () => {
    expect(normalizeLanguage(undefined)).toBe('en');
    expect(normalizeLanguage(null)).toBe('en');
  });

  it('normalizes common language codes', () => {
    expect(normalizeLanguage('en')).toBe('en');
    expect(normalizeLanguage('en-US')).toBe('en');
    expect(normalizeLanguage('zh')).toBe('zh');
    expect(normalizeLanguage('zh-CN')).toBe('zh');
    expect(normalizeLanguage('zh-TW')).toBe('zh');
    expect(normalizeLanguage('zh-HK')).toBe('zh');
  });

  it('falls back to en for unknown languages', () => {
    expect(normalizeLanguage('it-IT')).toBe('en');
    expect(normalizeLanguage('ko-KR')).toBe('en');
    expect(normalizeLanguage('not-a-language')).toBe('en');
  });

  it.each([
    ['ja-JP', 'ja'],
    ['fr-CA', 'fr'],
    ['de-DE', 'de'],
    ['es-MX', 'es'],
    ['ru-RU', 'ru'],
    [' FR_ca ', 'fr'],
  ])('normalizes supported regional preference %s to %s', (input, expected) => {
    expect(normalizeLanguage(input)).toBe(expected);
  });
});

describe('isAppLanguage', () => {
  it('accepts exactly supported language tags', () => {
    for (const lang of APP_LANGUAGES) {
      expect(isAppLanguage(lang)).toBe(true);
    }
  });

  it('rejects non-canonical tags', () => {
    expect(isAppLanguage('en-US')).toBe(false);
    expect(isAppLanguage('zh-CN')).toBe(false);
    expect(isAppLanguage('ja-JP')).toBe(false);
    expect(isAppLanguage('zh_TW')).toBe(false);
    expect(isAppLanguage('')).toBe(false);
  });
});

describe('extractMessageDictionary', () => {
  it('extracts {key: {message}} into a flat dictionary', () => {
    const dict = extractMessageDictionary({
      hello: { message: 'Hello' },
      broken: { message: 123 },
      empty: {},
    });
    expect(dict).toEqual({ hello: 'Hello' });
  });

  it('handles Vite JSON dynamic import module shape', () => {
    const dict = extractMessageDictionary({
      default: {
        hello: { message: 'Hello' },
      },
    });
    expect(dict).toEqual({ hello: 'Hello' });
  });
});
