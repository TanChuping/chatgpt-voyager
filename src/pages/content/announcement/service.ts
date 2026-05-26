/**
 * AnnouncementService — fetch, cache, dedupe.
 *
 * Two persistent flags drive "should we show the bubble":
 *   - SEEN_ID:  user explicitly acknowledged (× or open modal)
 *   - BUBBLE_SHOWN_FOR: this device auto-popped for that id at least once
 *
 * Bubble shows iff   current.id ≠ SEEN_ID  ∧  current.id ≠ BUBBLE_SHOWN_FOR.
 * Indicator dot shows iff   current.id ≠ SEEN_ID.
 *
 * On bubble dismiss (× / detail open): both flags ← current.id.
 * On bubble auto-pop: BUBBLE_SHOWN_FOR ← current.id (SEEN_ID untouched).
 *
 * That gives the user-promised behavior: "pops exactly once per new
 * announcement; if you click ×, never again; if you ignore it forever,
 * the dot stays but the bubble doesn't re-pop on every page reload".
 */
import { ANNOUNCEMENT_JSON_URL } from '@/core/constants/project';
import { StorageKeys } from '@/core/types/common';

import type {
  AnnouncementCacheEntry,
  RemoteAnnouncement,
  RemoteAnnouncementFile,
} from './types';

const CACHE_TTL_MS = 30 * 60 * 1000; // refetch at most every 30 min

type Listener = (current: RemoteAnnouncement | null) => void;

function isAnnouncement(value: unknown): value is RemoteAnnouncement {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.title === 'string' &&
    typeof v.summary === 'string' &&
    typeof v.bodyMarkdown === 'string'
  );
}

function isAnnouncementFile(value: unknown): value is RemoteAnnouncementFile {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.v !== 1) return false;
  return v.current === null || isAnnouncement(v.current);
}

async function readCache(): Promise<AnnouncementCacheEntry | null> {
  return new Promise((resolve) => {
    try {
      chrome.storage?.local?.get([StorageKeys.ANNOUNCEMENT_CACHE_V1], (res) => {
        const raw = res?.[StorageKeys.ANNOUNCEMENT_CACHE_V1];
        if (!raw || typeof raw !== 'object') return resolve(null);
        const cache = raw as Partial<AnnouncementCacheEntry>;
        if (typeof cache.fetchedAt !== 'number') return resolve(null);
        // `payload` may be null (we successfully fetched and the feed had
        // no current announcement) — that's a meaningful cache state.
        if (cache.payload !== null && !isAnnouncementFile(cache.payload)) {
          return resolve(null);
        }
        resolve({ fetchedAt: cache.fetchedAt, payload: cache.payload as RemoteAnnouncementFile | null });
      });
    } catch {
      resolve(null);
    }
  });
}

async function writeCache(entry: AnnouncementCacheEntry): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage?.local?.set({ [StorageKeys.ANNOUNCEMENT_CACHE_V1]: entry }, () => resolve());
    } catch {
      resolve();
    }
  });
}

async function readFlag(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      chrome.storage?.local?.get([key], (res) => {
        const v = res?.[key];
        resolve(typeof v === 'string' && v.length > 0 ? v : null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function writeFlag(key: string, value: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage?.local?.set({ [key]: value }, () => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Fetch the remote feed via plain GET. We deliberately bust HTTP caching
 * via a `?t=<timestamp>` cache-buster keyed off our own TTL window so
 * users get the new announcement promptly without hammering the CDN.
 */
async function fetchRemote(): Promise<RemoteAnnouncementFile | null> {
  const cacheBuster = Math.floor(Date.now() / CACHE_TTL_MS);
  const url = `${ANNOUNCEMENT_JSON_URL}?t=${cacheBuster}`;
  try {
    const res = await fetch(url, { credentials: 'omit', cache: 'no-cache' });
    if (!res.ok) {
      // 404 is meaningful — the feed file hasn't been published yet.
      // Don't treat it as a hard error; just cache "no current".
      if (res.status === 404) return { v: 1, current: null };
      return null;
    }
    const json = (await res.json()) as unknown;
    if (!isAnnouncementFile(json)) return null;
    return json;
  } catch {
    return null;
  }
}

export interface AnnouncementSnapshot {
  current: RemoteAnnouncement | null;
  /** True iff the bubble should currently auto-pop. */
  shouldPopBubble: boolean;
  /** True iff the button's "unread" indicator dot should be lit. */
  hasUnread: boolean;
}

async function evaluate(payload: RemoteAnnouncementFile | null): Promise<AnnouncementSnapshot> {
  const current = payload?.current ?? null;
  if (!current) {
    return { current: null, shouldPopBubble: false, hasUnread: false };
  }
  const [seenId, bubbleShownFor] = await Promise.all([
    readFlag(StorageKeys.ANNOUNCEMENT_SEEN_ID),
    readFlag(StorageKeys.ANNOUNCEMENT_BUBBLE_SHOWN_FOR),
  ]);
  return {
    current,
    shouldPopBubble: current.id !== seenId && current.id !== bubbleShownFor,
    hasUnread: current.id !== seenId,
  };
}

const listeners = new Set<Listener>();
let lastSnapshot: AnnouncementSnapshot = { current: null, shouldPopBubble: false, hasUnread: false };
let installed = false;
let pollTimer: number | null = null;

function notify(snapshot: AnnouncementSnapshot) {
  lastSnapshot = snapshot;
  for (const cb of listeners) {
    try {
      cb(snapshot.current);
    } catch (err) {
      console.warn('[GPT-Voyager] announcement listener threw', err);
    }
  }
}

/** Public API — call this on storage changes / manual refresh. */
export async function refreshSnapshot(force = false): Promise<AnnouncementSnapshot> {
  const cache = await readCache();
  const fresh = cache && !force && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  let payload: RemoteAnnouncementFile | null;
  if (fresh) {
    payload = cache!.payload;
  } else {
    const remote = await fetchRemote();
    if (remote) {
      payload = remote;
      await writeCache({ fetchedAt: Date.now(), payload });
    } else {
      // Remote fetch failed — keep using cache if we have one (so a flaky
      // network doesn't make the button flicker between states).
      payload = cache?.payload ?? null;
    }
  }
  const snapshot = await evaluate(payload);
  notify(snapshot);
  return snapshot;
}

export function getLastSnapshot(): AnnouncementSnapshot {
  return lastSnapshot;
}

/**
 * Mark the bubble as having auto-popped for `id`. Idempotent — calling
 * twice for the same id is a no-op storage-wise.
 */
export async function markBubbleShown(id: string): Promise<void> {
  await writeFlag(StorageKeys.ANNOUNCEMENT_BUBBLE_SHOWN_FOR, id);
}

/**
 * Mark `id` as fully acknowledged. Called when the user clicks × on the
 * bubble or opens the detail modal. Updates both flags so any other tab
 * also dismisses immediately (via the storage.onChanged listener below).
 */
export async function markSeen(id: string): Promise<void> {
  await Promise.all([
    writeFlag(StorageKeys.ANNOUNCEMENT_SEEN_ID, id),
    writeFlag(StorageKeys.ANNOUNCEMENT_BUBBLE_SHOWN_FOR, id),
  ]);
}

export function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Install storage-change watchers + start the periodic refresh loop.
 * Safe to call multiple times — second call is a no-op.
 */
export function installAnnouncementWatchers(onChange: (snapshot: AnnouncementSnapshot) => void): void {
  if (installed) return;
  installed = true;

  // Storage change watcher: any tab marking SEEN or BUBBLE_SHOWN should
  // propagate to this tab's bubble/dot immediately.
  const onStorage = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'local') return;
    if (
      changes[StorageKeys.ANNOUNCEMENT_SEEN_ID] ||
      changes[StorageKeys.ANNOUNCEMENT_BUBBLE_SHOWN_FOR] ||
      changes[StorageKeys.ANNOUNCEMENT_CACHE_V1]
    ) {
      void refreshSnapshot().then((snap) => onChange(snap));
    }
  };
  try {
    chrome.storage?.onChanged?.addListener(onStorage);
  } catch {
    /* extension context invalidated — fall through */
  }

  // Subscribe pass-through to the host callback.
  subscribe(() => onChange(lastSnapshot));

  // Periodic refresh — every 30 min, plus on visibilitychange when the
  // tab is brought to the foreground after a long idle. Skipping the
  // refresh while the tab is hidden avoids waking up sleeping tabs.
  const tick = () => {
    if (document.visibilityState === 'visible') {
      void refreshSnapshot();
    }
  };
  pollTimer = window.setInterval(tick, CACHE_TTL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Lazy refresh — refresh respects its own TTL so this is cheap.
      void refreshSnapshot();
    }
  });

  window.addEventListener(
    'beforeunload',
    () => {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
      try {
        chrome.storage?.onChanged?.removeListener(onStorage);
      } catch {
        /* ignore */
      }
    },
    { once: true },
  );
}

/** Test-only: reset module state. */
export function __resetAnnouncementServiceForTests(): void {
  listeners.clear();
  lastSnapshot = { current: null, shouldPopBubble: false, hasUnread: false };
  installed = false;
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}
