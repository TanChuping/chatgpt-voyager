import type { AppLanguage } from '@/utils/language';

/** Text in one language. Metadata and the read/dedupe ID are shared. */
export interface AnnouncementTranslation {
  title: string;
  summary: string;
  bodyMarkdown: string;
}

export interface AnnouncementMetadata {
  id: string;
  version?: string;
  publishedAt?: string;
  primaryImageUrl?: string;
}

/**
 * V2 has its own URL and cache key. The old root announcements.json remains
 * v=1 with string fields: old clients explicitly reject every other version.
 * The publisher requires all seven locales in this single atomic payload;
 * readers tolerate a missing locale and select one complete fallback.
 */
export interface MultilingualAnnouncement extends AnnouncementMetadata {
  locales: Partial<Record<AppLanguage, AnnouncementTranslation>>;
}

export interface RemoteAnnouncementFile {
  v: 2;
  current: MultilingualAnnouncement | null;
}

/** A single visible language, with the source retained for in-modal selection. */
export interface RemoteAnnouncement extends AnnouncementMetadata, AnnouncementTranslation {
  locales?: MultilingualAnnouncement['locales'];
  language?: AppLanguage;
  requestedLanguage?: AppLanguage;
}

/** Exactly one V2 feed is retained; V1 and user-owned data are untouched. */
export interface AnnouncementCacheEntry {
  fetchedAt: number;
  payload: RemoteAnnouncementFile;
}
