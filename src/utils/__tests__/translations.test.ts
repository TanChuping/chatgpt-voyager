import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_LANGUAGES } from '@/utils/language';
import { isTranslationKey } from '@/utils/translations';

const read = (lang: string) => JSON.parse(readFileSync(resolve('src/locales', lang, 'messages.json'), 'utf8')) as Record<string, { message: string }>;
const variables = (text: string) => [...text.matchAll(/\$\d+|\$[A-Z][A-Z0-9_]*\$|\{\{?\w+\}?\}/g)].map((m) => m[0]).sort();

describe('packaged seven-language dictionaries', () => {
  it('has complete nonempty keys and the same interpolation tokens in every language', () => {
    const en = read('en');
    for (const lang of APP_LANGUAGES) {
      const messages = read(lang);
      expect(Object.keys(messages).sort(), lang).toEqual(Object.keys(en).sort());
      for (const [key, value] of Object.entries(en)) {
        expect(messages[key].message.trim(), `${lang}/${key}`).not.toBe('');
        expect(variables(messages[key].message), `${lang}/${key}`).toEqual(variables(value.message));
      }
    }
  });
  it('recognizes the small startup fallback without importing complete dictionaries', () => {
    expect(isTranslationKey('extName')).toBe(true);
    expect(isTranslationKey('__not_a_real_key__')).toBe(false);
  });
});
