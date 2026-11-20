import { describe, expect, it } from 'vitest';

import { APP_LANGUAGES } from '@/utils/language';

import { isAnnouncementFile, localizeAnnouncement } from '../localization';
import legacy from './fixtures/current-v1.json';
import multilingual from './fixtures/current-v2.json';

/** Exact v1 predicate logic from e02c031 announcement/service.ts (types elided). */
function legacyIsAnnouncement(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.title === 'string' &&
    typeof v.summary === 'string' &&
    typeof v.bodyMarkdown === 'string'
  );
}
function legacyIsAnnouncementFile(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.v !== 1) return false;
  return v.current === null || legacyIsAnnouncement(v.current);
}

describe('actual 2026-10-03 support announcement compatibility fixture', () => {
  it('the unchanged root sample remains accepted by the exact old parser logic', () => {
    expect(legacyIsAnnouncementFile(legacy)).toBe(true);
    expect(legacyIsAnnouncementFile(multilingual)).toBe(false);
  });
  it('the new client accepts only its independent V2 schema', () => {
    expect(isAnnouncementFile(multilingual)).toBe(true);
    expect(isAnnouncementFile(legacy)).toBe(false);
  });
  it('ID, date, version, shared image and the seven-language key set are preserved', () => {
    expect(multilingual.current.id).toBe(legacy.current.id);
    expect(multilingual.current.publishedAt).toBe(legacy.current.publishedAt);
    expect(multilingual.current.version).toBe(legacy.current.version);
    expect(multilingual.current.primaryImageUrl).toBe(legacy.current.primaryImageUrl);
    expect(Object.keys(multilingual.current.locales).sort()).toEqual([...APP_LANGUAGES].sort());
  });
  it.each(APP_LANGUAGES)('selects exactly the published %s title, summary and body', (language) => {
    const selected = localizeAnnouncement(multilingual.current, language)!;
    expect(selected.id).toBe(legacy.current.id);
    expect(selected.language).toBe(language);
    expect(selected.requestedLanguage).toBe(language);
    for (const field of ['title', 'summary', 'bodyMarkdown'] as const) {
      expect(selected[field]).toBe(multilingual.current.locales[language][field]);
      expect(selected[field].trim()).not.toBe('');
    }
    // The supplied original has no Markdown link/image URLs; no destination is invented.
    const urls = (text: string) =>
      [...text.matchAll(/\]\((https?:[^)\s]+)/g)].map((match) => match[1]).sort();
    expect(urls(selected.bodyMarkdown)).toEqual(urls(legacy.current.bodyMarkdown));
  });
});
