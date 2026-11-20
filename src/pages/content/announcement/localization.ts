import { APP_LANGUAGES, type AppLanguage } from '@/utils/language';

import type {
  AnnouncementTranslation,
  MultilingualAnnouncement,
  RemoteAnnouncement,
  RemoteAnnouncementFile,
} from './types';

export function isAnnouncementTranslation(value: unknown): value is AnnouncementTranslation {
  if (!value || typeof value !== 'object') return false;
  const text = value as Record<string, unknown>;
  return ['title', 'summary', 'bodyMarkdown'].every(
    (key) => typeof text[key] === 'string' && (text[key] as string).trim().length > 0,
  );
}

export function isAnnouncementFile(value: unknown): value is RemoteAnnouncementFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as Record<string, unknown>;
  if (file.v !== 2) return false;
  if (file.current === null) return true;
  if (!file.current || typeof file.current !== 'object') return false;
  const current = file.current as Record<string, unknown>;
  if (typeof current.id !== 'string' || !current.id.trim()) return false;
  if (!current.locales || typeof current.locales !== 'object') return false;
  for (const key of ['version', 'publishedAt', 'primaryImageUrl']) {
    if (current[key] !== undefined && typeof current[key] !== 'string') return false;
  }
  const locales = current.locales as Record<string, unknown>;
  return APP_LANGUAGES.some((language) => isAnnouncementTranslation(locales[language]));
}

/** Fallback is a whole translation, never a mixture of languages or of IDs. */
export function localizeAnnouncement(
  announcement: MultilingualAnnouncement,
  requestedLanguage: AppLanguage,
): RemoteAnnouncement | null {
  const order = [...new Set([requestedLanguage, 'en', 'zh', ...APP_LANGUAGES])] as AppLanguage[];
  const language = order.find((candidate) =>
    isAnnouncementTranslation(announcement.locales[candidate]),
  );
  if (!language) return null;
  const text = announcement.locales[language]!;
  return {
    id: announcement.id,
    version: announcement.version,
    publishedAt: announcement.publishedAt,
    primaryImageUrl: announcement.primaryImageUrl,
    title: text.title,
    summary: text.summary,
    bodyMarkdown: text.bodyMarkdown,
    locales: announcement.locales,
    language,
    requestedLanguage,
  };
}
