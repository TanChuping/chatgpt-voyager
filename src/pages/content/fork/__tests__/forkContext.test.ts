import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { APP_LANGUAGES } from '@/utils/language';
import { installTranslations } from '@/utils/translations';
import { composeForkInputWithContext } from '../forkContext';

describe('composeForkInputWithContext', () => {
  it.each(APP_LANGUAGES)('uses the active %s dictionary while preserving supplied conversation content', (language) => {
    const raw = JSON.parse(readFileSync(resolve('src/locales', language, 'messages.json'), 'utf8'));
    const dict = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, (value as {message: string}).message]));
    installTranslations(dict);
    const history = '# 私有 title\n\n### 👤 User\n\nhello ${untouched} [link](https://example.com/x)';
    const output = composeForkInputWithContext(history);
    expect(output).toBe(`${dict.forkContextPrefix}\n# ${dict.forkHistoryHeading}\n${history}\n`);
    expect(output).toContain(history);
  });
});
