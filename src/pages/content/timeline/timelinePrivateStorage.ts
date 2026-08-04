/**
 * Compatibility surface for Timeline persistence.
 *
 * The lifecycle/lazy-loading code expects async helpers, but v1.7.5
 * localStorage keys remain the sole source of truth. Nothing is migrated,
 * renamed, mirrored, or deleted from another backend.
 */
export const TIMELINE_TURN_TEXT_CACHE_PREFIX = 'gptTimelineTurnTextCache:';
export const TIMELINE_TEXT_PINS_PREFIX = 'gptTimelineTextPins:';
export const TIMELINE_STARS_PREFIX = 'gptTimelineStars:';

export interface TimelinePrivateMigrationResult {
  discovered: number;
  migrated: number;
  retained: number;
}

const memory = new Map<string, string>();

function readLegacyItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function migrateLegacyTimelineStorage(): Promise<TimelinePrivateMigrationResult> {
  return { discovered: 0, migrated: 0, retained: 0 };
}

export function getTimelinePrivateItemSync(key: string): string | null {
  if (memory.has(key)) return memory.get(key) ?? null;
  const value = readLegacyItem(key);
  if (value !== null) memory.set(key, value);
  return value;
}

export function applyTimelinePrivateStorageChange(key: string, value: unknown): void {
  if (typeof value === 'string') memory.set(key, value);
  else memory.delete(key);
}

export async function hydrateTimelinePrivateItem(key: string): Promise<string | null> {
  return getTimelinePrivateItemSync(key);
}

export async function setTimelinePrivateItem(key: string, value: string): Promise<boolean> {
  try {
    localStorage.setItem(key, value);
    const saved = localStorage.getItem(key) === value;
    if (saved) memory.set(key, value);
    return saved;
  } catch {
    return false;
  }
}

export async function removeTimelinePrivateItem(key: string): Promise<boolean> {
  try {
    localStorage.removeItem(key);
    memory.delete(key);
    return localStorage.getItem(key) === null;
  } catch {
    return false;
  }
}

export async function listTimelinePrivateItems(prefix: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) {
        result.set(key, value);
        memory.set(key, value);
      }
    }
  } catch {
    // Return the entries collected before an unavailable storage backend.
  }
  return result;
}

export async function waitForTimelinePrivateStorage(keys?: Iterable<string>): Promise<void> {
  if (!keys) return;
  for (const key of keys) getTimelinePrivateItemSync(key);
}

export function resetTimelinePrivateStorageForTests(): void {
  memory.clear();
}
