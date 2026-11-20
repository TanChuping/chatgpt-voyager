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
import { ANNOUNCEMENT_I18N_JSON_URL } from '@/core/constants/project';
import { StorageKeys } from '@/core/types/common';
import { addPageExitListener } from '@/core/utils/pageLifecycle';
import { getCachedLanguage, initI18n } from '@/utils/i18n';

import { isAnnouncementFile, localizeAnnouncement } from './localization';
import type { AnnouncementCacheEntry, RemoteAnnouncement, RemoteAnnouncementFile } from './types';

const CACHE_TTL_MS = 30 * 60 * 1000; // refetch at most every 30 min

/**
 * HARD COOLDOWN ON BUBBLE POPS (id-agnostic). At most one bubble per
 * 14 days per device, period. This is a failsafe ABOVE the id-based
 * `BUBBLE_SHOWN_FOR` flag — if that flag ever fails to commit, or a
 * publisher accidentally bumps the id twice in a week, or any future
 * detection bug flips `shouldPopBubble` back to true unexpectedly,
 * this ceiling holds the line and protects users from annoyance.
 *
 * 14 days was chosen as "longer than any normal release cadence but
 * short enough that genuinely-important news can still surface twice
 * a month." If you ever raise this, leave a comment explaining why
 * the previous cooldown wasn't long enough — the bias is to make it
 * LONGER, not shorter.
 */
const BUBBLE_HARD_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * HARD COOLDOWN ON DOT (id-agnostic). After the user explicitly
 * acknowledges (× / detail / megaphone-open → markSeen), the red
 * dot CANNOT light up again for 24 hours, even if a brand-new
 * announcement id arrives. Paired with BUBBLE_HARD_COOLDOWN_MS so
 * the "I just dealt with this, leave me alone" contract is enforced
 * at the storage layer rather than relying on policy-only code paths.
 *
 * 24h is short enough that genuinely-new content surfaces by the
 * next day, but long enough that a publisher mis-clicking republish
 * doesn't immediately re-annoy a user who literally just clicked ×.
 */
const DOT_HARD_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/**
 * Coarse cache-buster window for non-forced fetches. raw.githubusercontent.com
 * sits behind a CDN that aggressively caches GETs; without a buster a freshly-
 * pushed JSON can be invisible to clients for several minutes even when the
 * blob is already updated at origin. 5 min is short enough that a publisher
 * pushing a new announcement sees it propagate fast, but long enough that
 * background polling doesn't hammer the CDN.
 *
 * Forced fetches (the modal-open path) bypass this and use a per-call timestamp,
 * so a user clicking the megaphone immediately after a push gets the latest
 * content.
 */
const CDN_BUST_WINDOW_MS = 5 * 60 * 1000;

type Listener = (current: RemoteAnnouncement | null) => void;

async function readCache(): Promise<AnnouncementCacheEntry | null> {
  return new Promise((resolve) => {
    try {
      if (!chrome.storage?.local?.get) return resolve(null);
      chrome.storage.local.get([StorageKeys.ANNOUNCEMENT_CACHE_V2], (res) => {
        const raw = res?.[StorageKeys.ANNOUNCEMENT_CACHE_V2];
        if (!raw || typeof raw !== 'object') return resolve(null);
        const cache = raw as Partial<AnnouncementCacheEntry>;
        if (typeof cache.fetchedAt !== 'number' || !Number.isFinite(cache.fetchedAt))
          return resolve(null);
        if (!isAnnouncementFile(cache.payload)) {
          return resolve(null);
        }
        resolve({
          fetchedAt: cache.fetchedAt,
          payload: cache.payload as RemoteAnnouncementFile,
        });
      });
    } catch {
      resolve(null);
    }
  });
}

/** Callback APIs report quota/context errors through lastError, not thrown exceptions. */
async function writeLocal(values: Record<string, unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      if (!chrome.storage?.local?.set) return resolve(false);
      chrome.storage.local.set(values, () => {
        const error = chrome.runtime?.lastError;
        if (error) {
          console.warn('[GPT-Voyager] announcement storage write failed:', error.message);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    } catch {
      resolve(false);
    }
  });
}

async function writeCache(entry: AnnouncementCacheEntry): Promise<boolean> {
  return writeLocal({ [StorageKeys.ANNOUNCEMENT_CACHE_V2]: entry });
}

async function readFlag(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      if (!chrome.storage?.local?.get) return resolve(null);
      chrome.storage.local.get([key], (res) => {
        const v = res?.[key];
        resolve(typeof v === 'string' && v.length > 0 ? v : null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function writeFlag(key: string, value: string): Promise<boolean> {
  return writeLocal({ [key]: value });
}

/**
 * Numeric flag readers/writers for the timestamp-based hard cooldowns.
 * Stored as plain numbers (ms since epoch). Missing / non-number values
 * read as 0 — i.e. "never set" — which lets the cooldown predicate
 * `now - lastBubbleAt < BUBBLE_HARD_COOLDOWN_MS` correctly evaluate to
 * FALSE for fresh installs (so the first bubble can pop).
 */
async function readTimestamp(key: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      if (!chrome.storage?.local?.get) return resolve(0);
      chrome.storage.local.get([key], (res) => {
        const v = res?.[key];
        resolve(typeof v === 'number' && isFinite(v) ? v : 0);
      });
    } catch {
      resolve(0);
    }
  });
}

async function writeTimestamp(key: string, value: number): Promise<boolean> {
  return writeLocal({ [key]: value });
}

// A tiny, bounded fallback for this content-script lifetime only. It never
// rewrites user data and cannot promise persistence across a full page reload.
let sessionSeenId: string | null = null;
let sessionBubbleShownFor: string | null = null;
let sessionLastBubbleAt = 0;
let sessionLastSeenAt = 0;

/**
 * Fetch the remote feed via plain GET. The cache-buster strategy is:
 *
 *   - background poll (force=false): a 5-min bucket. Within any given
 *     5-min window the same `?t=N` value is reused, so the CDN can serve
 *     a cached response and we don't burn bandwidth on every focus event.
 *
 *   - user-initiated fetch (force=true): a per-call millisecond timestamp.
 *     Guarantees a CDN miss so a freshly-pushed announcement shows up the
 *     moment the user clicks the megaphone or opens the modal — important
 *     for the publish→see-it-immediately authoring loop.
 */
async function fetchRemote(force: boolean): Promise<RemoteAnnouncementFile | null> {
  const cacheBuster = force ? `f${Date.now()}` : `b${Math.floor(Date.now() / CDN_BUST_WINDOW_MS)}`;
  const url = `${ANNOUNCEMENT_I18N_JSON_URL}?t=${cacheBuster}`;
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      credentials: 'omit',
      cache: 'no-cache',
      signal: controller.signal,
    });
    if (!res.ok) {
      // Missing V2 or a partially published resource is not a withdrawal.
      // Only a valid v=2/current=null payload may clear the cached announcement.
      return null;
    }
    const json = (await res.json()) as unknown;
    if (!isAnnouncementFile(json)) return null;
    return json;
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export interface AnnouncementSnapshot {
  current: RemoteAnnouncement | null;
  status: 'ready' | 'empty' | 'stale' | 'unavailable';
  /** True iff the bubble should currently auto-pop. */
  shouldPopBubble: boolean;
  /** True iff the button's "unread" indicator dot should be lit. */
  hasUnread: boolean;
}

async function evaluate(
  payload: RemoteAnnouncementFile | null,
  failed = false,
): Promise<AnnouncementSnapshot> {
  await initI18n();
  const language = getCachedLanguage();
  const current = payload?.current ? localizeAnnouncement(payload.current, language) : null;
  const status = failed ? (current ? 'stale' : 'unavailable') : current ? 'ready' : 'empty';
  if (!current) {
    return { current: null, status, shouldPopBubble: false, hasUnread: false };
  }
  const [seenId, bubbleShownFor, lastBubbleAt, lastSeenAt] = await Promise.all([
    readFlag(StorageKeys.ANNOUNCEMENT_SEEN_ID),
    readFlag(StorageKeys.ANNOUNCEMENT_BUBBLE_SHOWN_FOR),
    readTimestamp(StorageKeys.ANNOUNCEMENT_LAST_BUBBLE_AT),
    readTimestamp(StorageKeys.ANNOUNCEMENT_LAST_SEEN_AT),
  ]);
  const now = Date.now();

  // ---- Detection layer (id-based) ----------------------------------
  const idsSayShouldPop =
    current.id !== seenId &&
    current.id !== bubbleShownFor &&
    current.id !== sessionSeenId &&
    current.id !== sessionBubbleShownFor;
  const idsSayHasUnread = current.id !== seenId && current.id !== sessionSeenId;

  // ---- HARD GUARDS (timestamp-based, id-agnostic) ------------------
  // These are absolute ceilings: even if the id-based detection above
  // says "pop" or "light dot", the timestamp gates can VETO. The
  // reverse never applies — guards can only suppress, never force.
  // This makes the user-protection contract robust against any future
  // detection bug.
  const bubbleCooldownActive =
    now - Math.max(lastBubbleAt, sessionLastBubbleAt) < BUBBLE_HARD_COOLDOWN_MS;
  const dotCooldownActive = now - Math.max(lastSeenAt, sessionLastSeenAt) < DOT_HARD_COOLDOWN_MS;

  return {
    current,
    status,
    shouldPopBubble: idsSayShouldPop && !bubbleCooldownActive,
    hasUnread: idsSayHasUnread && !dotCooldownActive,
  };
}

const listeners = new Set<Listener>();
let lastSnapshot: AnnouncementSnapshot = {
  current: null,
  status: 'unavailable',
  shouldPopBubble: false,
  hasUnread: false,
};
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

let remoteRequest: Promise<RemoteAnnouncementFile | null> | null = null;
let refreshGeneration = 0;
let latestRefresh: Promise<AnnouncementSnapshot> | null = null;
let lastFetchFailed = false;

function fetchShared(force: boolean): Promise<RemoteAnnouncementFile | null> {
  if (!remoteRequest) {
    remoteRequest = (async () => {
      const remote = await fetchRemote(force);
      lastFetchFailed = !remote;
      if (remote) await writeCache({ fetchedAt: Date.now(), payload: remote });
      return remote;
    })().finally(() => {
      remoteRequest = null;
    });
  }
  return remoteRequest;
}

/**
 * One remote request is shared by simultaneous callers. Newer refreshes win;
 * an older language/result cannot overwrite the latest choice or withdrawal.
 */
export function refreshSnapshot(force = false): Promise<AnnouncementSnapshot> {
  const generation = ++refreshGeneration;
  const promise = (async (): Promise<AnnouncementSnapshot> => {
    const cache = await readCache();
    const fresh = cache && !force && !remoteRequest && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
    let fetched = false;
    let payload: RemoteAnnouncementFile | null;
    let failed = lastFetchFailed;
    if (fresh) {
      payload = cache.payload;
    } else {
      const remote = await fetchShared(force);
      failed = !remote;
      fetched = !!remote;
      payload = remote ?? cache?.payload ?? null;
    }
    const snapshot = await evaluate(payload, failed);
    if (generation !== refreshGeneration && latestRefresh) {
      // A newer language-only refresh must not discard a successful forced
      // fetch. Re-evaluate the newest stored feed, never the older local copy.
      return fetched ? refreshSnapshot() : latestRefresh;
    }
    notify(snapshot);
    return snapshot;
  })();
  latestRefresh = promise;
  return promise;
}

export function getLastSnapshot(): AnnouncementSnapshot {
  return lastSnapshot;
}

/**
 * Mark the bubble as having auto-popped for `id`. Idempotent — calling
 * twice for the same id is a no-op storage-wise. Returns true only if the
 * persisted flag is present or both writes succeeded; false means session-only.
 *
 * Refreshes the snapshot synchronously after the write so any in-tab
 * listener (e.g., applyUnreadState in the bootstrap) sees the new
 * state without waiting on the chrome.storage.onChanged round-trip.
 * Belt-and-suspenders with the existing onChanged listener — both
 * fire applySnapshot, second one is a no-op.
 */
export async function markBubbleShown(id: string): Promise<boolean> {
  if (sessionBubbleShownFor === id) {
    await refreshSnapshot();
    return false;
  }
  if ((await readFlag(StorageKeys.ANNOUNCEMENT_BUBBLE_SHOWN_FOR)) === id) {
    await refreshSnapshot();
    return true;
  }
  const now = Date.now();
  // Protect this runtime while asynchronous writes are pending, and retain
  // that protection if persistence is rejected. No automatic write retry.
  sessionBubbleShownFor = id;
  sessionLastBubbleAt = now;
  const results = await Promise.all([
    writeFlag(StorageKeys.ANNOUNCEMENT_BUBBLE_SHOWN_FOR, id),
    writeTimestamp(StorageKeys.ANNOUNCEMENT_LAST_BUBBLE_AT, now),
  ]);
  const persisted = results.every(Boolean);
  if (persisted && sessionBubbleShownFor === id && sessionLastBubbleAt === now) {
    sessionBubbleShownFor = null;
    sessionLastBubbleAt = 0;
  }
  await refreshSnapshot();
  return persisted;
}

/**
 * Mark `id` as fully acknowledged. Called when the user clicks × on the
 * bubble or opens the detail modal. Updates both flags so any other tab
 * also dismisses immediately (via the storage.onChanged listener below).
 *
 * Force-refreshes the snapshot afterwards so the calling tab's dot
 * turns off immediately without depending on the onChanged round-trip
 * timing (which was previously prone to dropping the unread-state
 * update if ChatGPT remounted the header in the same frame).
 */
/** Returns true only when all four existing ID/cooldown writes persisted. */
export async function markSeen(id: string): Promise<boolean> {
  const now = Date.now();
  sessionSeenId = id;
  sessionBubbleShownFor = id;
  sessionLastBubbleAt = now;
  sessionLastSeenAt = now;
  const results = await Promise.all([
    writeFlag(StorageKeys.ANNOUNCEMENT_SEEN_ID, id),
    writeFlag(StorageKeys.ANNOUNCEMENT_BUBBLE_SHOWN_FOR, id),
    writeTimestamp(StorageKeys.ANNOUNCEMENT_LAST_BUBBLE_AT, now),
    writeTimestamp(StorageKeys.ANNOUNCEMENT_LAST_SEEN_AT, now),
  ]);
  const persisted = results.every(Boolean);
  if (persisted && sessionSeenId === id && sessionLastSeenAt === now) {
    sessionSeenId = null;
    sessionLastSeenAt = 0;
    if (sessionBubbleShownFor === id && sessionLastBubbleAt === now) {
      sessionBubbleShownFor = null;
      sessionLastBubbleAt = 0;
    }
  }
  await refreshSnapshot();
  return persisted;
}

export function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Install storage-change watchers + start the periodic refresh loop.
 * Safe to call multiple times — second call is a no-op.
 */
export function installAnnouncementWatchers(
  onChange: (snapshot: AnnouncementSnapshot) => void,
): void {
  if (installed) return;
  installed = true;

  // Storage change watcher: any tab marking SEEN or BUBBLE_SHOWN should
  // propagate to this tab's bubble/dot immediately.
  const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local') return;
    if (
      changes[StorageKeys.ANNOUNCEMENT_SEEN_ID] ||
      changes[StorageKeys.ANNOUNCEMENT_BUBBLE_SHOWN_FOR] ||
      changes[StorageKeys.ANNOUNCEMENT_CACHE_V2] ||
      changes[StorageKeys.ANNOUNCEMENT_LAST_BUBBLE_AT] ||
      changes[StorageKeys.ANNOUNCEMENT_LAST_SEEN_AT]
    ) {
      // Don't chain .then(onChange) — refreshSnapshot's own notify()
      // already fans out to every subscriber (including the one
      // registered below pointing at `onChange`). A second call would
      // race the eager-mark→refresh chain and produce the bubble-
      // flashing regression. The notify path is enough.
      void refreshSnapshot();
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

  addPageExitListener(() => {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    try {
      chrome.storage?.onChanged?.removeListener(onStorage);
    } catch {
      /* ignore */
    }
  });
}

/** Test-only: reset module state. */
export function __resetAnnouncementServiceForTests(): void {
  listeners.clear();
  refreshGeneration++;
  sessionSeenId = null;
  sessionBubbleShownFor = null;
  sessionLastBubbleAt = 0;
  sessionLastSeenAt = 0;
  remoteRequest = null;
  latestRefresh = null;
  lastFetchFailed = false;
  lastSnapshot = { current: null, status: 'unavailable', shouldPopBubble: false, hasUnread: false };
  installed = false;
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}
