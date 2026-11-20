import { getTranslationSync } from '@/utils/i18n';
import type { AppLanguage } from '@/utils/language';

export type ForkLanguage = AppLanguage;

export function composeForkInputWithContext(historyMarkdown: string): string {
  const prefix = getTranslationSync('forkContextPrefix');
  const normalizedHistory = historyMarkdown.trim();
  return `${prefix}\n# ${getTranslationSync('forkHistoryHeading')}\n${normalizedHistory}\n`;
}
