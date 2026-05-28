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
 * Numeric flag readers/writers for the timestamp-based hard cooldowns.
 * Stored as plain numbers (ms since epoch). Missing / non-number values
 * read as 0 — i.e. "never set" — which lets the cooldown predicate
 * `now - lastBubbleAt < BUBBLE_HARD_COOLDOWN_MS` correctly evaluate to
 * FALSE for fresh installs (so the first bubble can pop).
 */
async function readTimestamp(key: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      chrome.storage?.local?.get([key], (res) => {
        const v = res?.[key];
        resolve(typeof v === 'number' && isFinite(v) ? v : 0);
      });
    } catch {
      resolve(0);
    }
  });
}

async function writeTimestamp(key: string, value: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage?.local?.set({ [key]: value }, () => resolve());
    } catch {
      resolve();
    }
  });
}

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
  const [seenId, bubbleShownFor, lastBubbleAt, lastSeenAt] = await Promise.all([
    readFlag(StorageKeys.ANNOUNCEMENT_SEEN_ID),
    readFlag(StorageKeys.ANNOUNCEMENT_BUBBLE_SHOWN_FOR),
    readTimestamp(StorageKeys.ANNOUNCEMENT_LAST_BUBBLE_AT),
    readTimestamp(StorageKeys.ANNOUNCEMENT_LAST_SEEN_AT),
  ]);
  const now = Date.now();

  // ---- Detection layer (id-based) ----------------------------------
  const idsSayShouldPop = current.id !== seenId && current.id !== bubbleShownFor;
  const idsSayHasUnread = current.id !== seenId;

  // ---- HARD GUARDS (timestamp-based, id-agnostic) ------------------
  // These are absolute ceilings: even if the id-based detection above
  // says "pop" or "light dot", the timestamp gates can VETO. The
  // reverse never applies — guards can only suppress, never force.
  // This makes the user-protection contract robust against any future
  // detection bug.
  const bubbleCooldownActive = now - lastBubbleAt < BUBBLE_HARD_COOLDOWN_MS;
  const dotCooldownActive = now - lastSeenAt < DOT_HARD_COOLDOWN_MS;

  return {
    current,
    shouldPopBubble: idsSayShouldPop && !bubbleCooldownActive,
    hasUnread: idsSayHasUnread && !dotCooldownActive,
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
    const remote = await fetchRemote(force);
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
 *
 * Refreshes the snapshot synchronously after the write so any in-tab
 * listener (e.g., applyUnreadState in the bootstrap) sees the new
 * state without waiting on the chrome.storage.onChanged round-trip.
 * Belt-and-suspenders with the existing onChanged listener — both
 * fire applySnapshot, second one is a no-op.
 */
export async function markBubbleShown(id: string): Promise<void> {
  // Two writes: the id-keyed flag (existing detection layer) AND the
  // id-agnostic timestamp ceiling (hard cooldown). The cooldown wins
  // ANY contention with the id-based logic — even if a new id arrives
  // tomorrow, the bubble stays silent for the full 14-day window.
  await Promise.all([
    writeFlag(StorageKeys.ANNOUNCEMENT_BUBBLE_SHOWN_FOR, id),
    writeTimestamp(StorageKeys.ANNOUNCEMENT_LAST_BUBBLE_AT, Date.now()),
  ]);
  await refreshSnapshot();
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
export async function markSeen(id: string): Promise<void> {
  // Four writes (parallel): the two id-keyed flags (existing detection),
  // plus BOTH hard-cooldown timestamps. Explicit dismiss arms both
  // ceilings:
  //   - LAST_BUBBLE_AT (14 d): no bubble pops for 2 weeks regardless
  //     of new ids — user told us they "saw it", honour that.
  //   - LAST_SEEN_AT (24 h): no red dot for the next day even if a
  //     brand-new id arrives — "I just dealt with this, leave me alone".
  // Both ceilings are belt-and-suspenders on top of SEEN_ID. If
  // SEEN_ID ever gets dropped or de-synced from current.id, the
  // timestamps still hold the line for their respective windows.
  const now = Date.now();
  await Promise.all([
    writeFlag(StorageKeys.ANNOUNCEMENT_SEEN_ID, id),
    writeFlag(StorageKeys.ANNOUNCEMENT_BUBBLE_SHOWN_FOR, id),
    writeTimestamp(StorageKeys.ANNOUNCEMENT_LAST_BUBBLE_AT, now),
    writeTimestamp(StorageKeys.ANNOUNCEMENT_LAST_SEEN_AT, now),
  ]);
  await refreshSnapshot();
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
      changes[StorageKeys.ANNOUNCEMENT_CACHE_V1] ||
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
