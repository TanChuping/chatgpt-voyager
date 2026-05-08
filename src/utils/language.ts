export const APP_LANGUAGES = ['en', 'zh'] as const;

export type AppLanguage = (typeof APP_LANGUAGES)[number];

export const APP_LANGUAGE_LABELS: Record<AppLanguage, string> = {
  en: 'English',
  zh: '\u7b80\u4f53\u4e2d\u6587',
};

export function isAppLanguage(value: unknown): value is AppLanguage {
  return typeof value === 'string' && (APP_LANGUAGES as readonly string[]).includes(value);
}

export function normalizeLanguage(lang: string | undefined | null): AppLanguage {
  if (!lang) return 'en';
  return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function getNextLanguage(current: AppLanguage): AppLanguage {
  const idx = APP_LANGUAGES.indexOf(current);
  if (idx < 0) return 'en';
  return APP_LANGUAGES[(idx + 1) % APP_LANGUAGES.length];
}
