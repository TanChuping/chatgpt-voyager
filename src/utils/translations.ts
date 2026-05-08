import enMessages from '@locales/en/messages.json';
import zhMessages from '@locales/zh/messages.json';

import type { AppLanguage } from './language';

type RawLocaleMessages = typeof enMessages;

const rawMessagesByLanguage = {
  en: enMessages,
  zh: zhMessages,
} satisfies Record<AppLanguage, RawLocaleMessages>;

export type TranslationKey = keyof RawLocaleMessages;
export type Translation = Record<TranslationKey, string>;

function extractTranslations<M extends Record<string, { message: string }>>(
  raw: M,
): Record<keyof M, string> {
  const out = {} as Record<keyof M, string>;
  for (const key of Object.keys(raw) as Array<keyof M>) {
    out[key] = raw[key].message;
  }
  return out;
}

export const TRANSLATIONS: Record<AppLanguage, Translation> = {
  en: extractTranslations(rawMessagesByLanguage.en),
  zh: extractTranslations(rawMessagesByLanguage.zh),
};

export function isTranslationKey(value: string): value is TranslationKey {
  return value in rawMessagesByLanguage.en;
}
