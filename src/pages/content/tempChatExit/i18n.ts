/**
 * Tiny shared i18n helpers for the temp-chat-regret module.
 *
 * Why a local helper instead of using `getTranslationSync` directly:
 *  - We need `{placeholder}` substitution for messages like "Loaded
 *    {count} messages…", and the existing i18n layer doesn't include
 *    a formatter — every caller would otherwise hand-roll the same
 *    `replace` chain.
 *  - Content bootstrap waits for initI18n before mounting this feature. The
 *    defensive catch keeps an unavailable translation from breaking user actions;
 *    the loader owns the small emergency fallback when packaged files fail.
 */
import { getTranslationSync } from '@/utils/i18n';
import type { TranslationKey } from '@/utils/translations';

export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  let raw: string;
  try {
    raw = getTranslationSync(key);
  } catch {
    raw = key;
  }
  if (!vars) return raw;
  let out = raw;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(String(v));
  }
  return out;
}
