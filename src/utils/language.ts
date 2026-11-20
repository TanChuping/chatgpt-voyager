export const APP_LANGUAGES = ['en', 'zh', 'ja', 'fr', 'de', 'es', 'ru'] as const;

export type AppLanguage = (typeof APP_LANGUAGES)[number];

export const APP_LANGUAGE_LABELS: Record<AppLanguage, string> = {
  en: 'English',
  zh: '\u7b80\u4f53\u4e2d\u6587',
  ja: '日本語',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  ru: 'Русский',
};

export function isAppLanguage(value: unknown): value is AppLanguage {
  return typeof value === 'string' && (APP_LANGUAGES as readonly string[]).includes(value);
}

export function normalizeLanguage(lang: string | undefined | null): AppLanguage {
  if (!lang) return 'en';
  const base = lang.trim().toLowerCase().replace(/_/g, '-').split('-')[0];
  return isAppLanguage(base) ? base : 'en';
}

export function getNextLanguage(current: AppLanguage): AppLanguage {
  const idx = APP_LANGUAGES.indexOf(current);
  if (idx < 0) return 'en';
  return APP_LANGUAGES[(idx + 1) % APP_LANGUAGES.length];
}
