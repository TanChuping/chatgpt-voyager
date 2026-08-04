/**
 * Persistent per-conversation cache of turn text/attachments/image metadata.
 *
 * ChatGPT virtualises the inner `[data-message-author-role]` body of every
 * turn that is far outside the viewport. The outer `<section data-turn-id>`
 * stays alive (so the timeline dot keeps an anchor), but `extractTurnText`
 * returns "" until the inner is re-rendered. The result: in a very long
 * conversation, dots appear empty until the user scrolls past them once.
 *
 * This module persists the snapshot of `{summary, attachments, hasGeneratedImage}`
 * captured the first time we *do* see real content for a turn. On subsequent
 * timeline rebuilds — including a fresh page load — we fall back to the
 * cached snapshot whenever the live DOM is empty.
 *
 * Invalidation: the timeline manager calls `prune(currentTurnIds)` after every
 * reconcile pass. Any cached entry whose turn-id is no longer in the live
 * outer-wrapper set is removed. This handles ChatGPT's "edit message" feature,
 * which forks the conversation and replaces every subsequent turn-id with a
 * fresh uuid — the old uuids simply stop appearing in the DOM, and we drop
 * their stale snapshots on the next pass.
 *
 * Storage: extension-private storage, keyed
 * `gptTimelineTurnTextCache:<conversationId>`.
 * Capped at MAX_ENTRIES per conversation (LRU by lastSeenAt). Saves are
 * debounced so a long scroll session doesn't hammer extension storage.
 */
import type { AttachmentInfo } from './attachments';
import {
  TIMELINE_TURN_TEXT_CACHE_PREFIX,
  getTimelinePrivateItemSync,
  hydrateTimelinePrivateItem,
  listTimelinePrivateItems,
  removeTimelinePrivateItem,
  setTimelinePrivateItem,
  waitForTimelinePrivateStorage,
} from './timelinePrivateStorage';

export interface TurnTextCacheEntry {
  id: string;
  summary: string;
  attachments: ReadonlyArray<AttachmentInfo>;
  hasGeneratedImage: boolean;
  lastSeenAt: number;
  /**
   * Stable hash of (summary + attachments) used to detect content edits.
   * If a turn's live fingerprint differs from its cached fingerprint, the
   * user has edited that turn (or assistant regenerated it) — that's the
   * semantic signal we trigger cache invalidation on, instead of relying on
   * fragile "is this turnId still in the DOM" timing checks during ChatGPT's
   * progressive mount.
   */
  fingerprint: string;
}

/**
 * Build a fingerprint for a turn snapshot. We stick to summary text +
 * attachment names because they are exactly what the timeline tooltip /
 * preview show — if those change, the user-visible content has changed and
 * we want to invalidate. Pure string concat (no hash function needed): even
 * 1000 turns × 200-char summaries is well under a millisecond to compare.
 */
export function computeFingerprint(
  summary: string,
  attachments: ReadonlyArray<AttachmentInfo>,
): string {
  const attachKey = attachments
    .map((a) => a.name)
    .slice()
    .sort()
    .join('\x1f');
  return `${summary}\x1e${attachKey}`;
}

interface PersistedShape {
  v: 1;
  entries: TurnTextCacheEntry[];
}

const STORAGE_PREFIX = TIMELINE_TURN_TEXT_CACHE_PREFIX;
const MAX_ENTRIES = 500;
const SAVE_DEBOUNCE_MS = 400;
/**
 * Cap on how many conversations' caches we keep in extension storage at once.
 * Each cached conversation is roughly 20-50 KB serialized. Keeping 80
 * conversations bounds extension-local growth while preserving the prior
 * namespace and eviction policy. Eviction
 * sorts by the conversation's most-recent `lastSeenAt` and drops the
 * oldest first.
 */
const MAX_CONVERSATIONS = 80;

export class TurnTextCache {
  private map = new Map<string, TurnTextCacheEntry>();
  private conversationId: string | null = null;
  private saveTimer: number | null = null;
  private dirty = false;
  private hydrationGeneration = 0;
  private persistGeneration = 0;
  private maintenancePromise: Promise<void> = Promise.resolve();

  /** Switch the active conversation. Loads its persisted cache (replacing the
   * in-memory map). Safe to call repeatedly with the same id (no-op). */
  setConversation(conversationId: string | null): void {
    if (conversationId === this.conversationId) return;
    // Flush any pending writes for the previous conversation before swapping.
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.flushSync();
    this.hydrationGeneration += 1;
    this.conversationId = conversationId;
    this.map.clear();
    if (!conversationId) return;
    this.loadRaw(getTimelinePrivateItemSync(this.storageKey() ?? ''));
  }

  /**
   * Hydrate the active conversation from extension-private storage. Callers
   * can keep using synchronous get() immediately; a late result is ignored
   * after a conversation switch or teardown.
   */
  async hydrate(): Promise<void> {
    const key = this.storageKey();
    if (!key) return;
    const generation = this.hydrationGeneration;
    const raw = await hydrateTimelinePrivateItem(key);
    if (generation !== this.hydrationGeneration || key !== this.storageKey()) return;
    this.loadRaw(raw, this.dirty);
    this.maintenancePromise = this.evictOldConversations();
    await this.maintenancePromise;
  }

  /** Expose for callers that need to filter cross-conversation traffic
   * (e.g. the API-capture primer skips events for other conversations). */
  getConversationId(): string | null {
    return this.conversationId;
  }

  get(turnId: string): TurnTextCacheEntry | undefined {
    return this.map.get(turnId);
  }

  /**
   * Every cached turn id for the bound conversation. Used to re-anchor the
   * timeline onto turns ChatGPT has virtualised out of the DOM — the cache is
   * the only place that still knows they exist.
   */
  turnIds(): string[] {
    return Array.from(this.map.keys());
  }

  /**
   * Insert/refresh a snapshot. Should only be called when the live DOM
   * (or the API capture) produced non-empty content for this turn —
   * caching an empty snapshot would mask the fallback mechanism.
   *
   * Idempotent re-writes (same fingerprint as the cached entry) only
   * refresh `lastSeenAt` and DO NOT schedule a save. This matters because
   * both the DOM-reconcile path and the API-prime path write through this
   * method; if every reconcile pass scheduled a fresh debounced save, we'd
   * churn persistence on every scroll. With the short-circuit, only
   * actual content changes hit disk.
   */
  set(entry: TurnTextCacheEntry): void {
    if (!this.conversationId) return;
    const existing = this.map.get(entry.id);
    if (
      existing &&
      existing.fingerprint === entry.fingerprint &&
      existing.hasGeneratedImage === entry.hasGeneratedImage
    ) {
      existing.lastSeenAt = entry.lastSeenAt;
      return;
    }
    this.map.set(entry.id, { ...entry });
    this.scheduleSave();
  }

  /** Update lastSeenAt without changing the snapshot (call this when a cached
   * entry was used as the fallback). Helps LRU eviction keep recently-shown
   * turns. */
  touch(turnId: string): void {
    const existing = this.map.get(turnId);
    if (!existing) return;
    existing.lastSeenAt = Date.now();
    this.scheduleSave();
  }

  /**
   * Remove any cached entry whose turn-id is NOT in `liveTurnIds`. Caller
   * should pass the full set of outer-wrapper turn-ids currently in the DOM
   * (not just visible ones) — ChatGPT keeps outers around even when virtualised.
   *
   * Pass `expectMinimum = true` (default) to bail out when `liveTurnIds` is
   * tiny: prevents wiping the cache during transient empty-DOM states (route
   * change, fresh page load before turns are rendered, etc).
   */
  prune(liveTurnIds: Set<string>, expectMinimum: boolean = true): number {
    if (!this.conversationId) return 0;
    // Refuse to prune from a near-empty DOM — almost always a transient
    // "ChatGPT is rerendering" state, not a real conversation that lost turns.
    if (expectMinimum && liveTurnIds.size === 0 && this.map.size > 2) return 0;

    let removed = 0;
    for (const id of this.map.keys()) {
      if (!liveTurnIds.has(id)) {
        this.map.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.scheduleSave();
    return removed;
  }

  /** Trim LRU when over MAX_ENTRIES. Called from set() / load(). */
  private trim(): void {
    if (this.map.size <= MAX_ENTRIES) return;
    const sorted = Array.from(this.map.values()).sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    while (this.map.size > MAX_ENTRIES) {
      const oldest = sorted.shift();
      if (!oldest) break;
      this.map.delete(oldest.id);
    }
  }

  size(): number {
    return this.map.size;
  }

  private storageKey(): string | null {
    return this.conversationId ? `${STORAGE_PREFIX}${this.conversationId}` : null;
  }

  private loadRaw(raw: string | null, mergeCurrent = false): void {
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedShape>;
      if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.entries)) return;
      const loaded = new Map<string, TurnTextCacheEntry>();
      for (const entry of parsed.entries) {
        if (!entry || typeof entry.id !== 'string') continue;
        if (typeof entry.summary !== 'string') continue;
        const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
        // Persisted entries from before fingerprints existed: regenerate from
        // their stored summary/attachments. Worst-case the regenerated print
        // matches future reads exactly (same summary text), so old entries
        // are still useful as fallback content.
        const fingerprint =
          typeof entry.fingerprint === 'string'
            ? entry.fingerprint
            : computeFingerprint(entry.summary, attachments);
        loaded.set(entry.id, {
          id: entry.id,
          summary: entry.summary,
          attachments,
          hasGeneratedImage: !!entry.hasGeneratedImage,
          lastSeenAt:
            typeof entry.lastSeenAt === 'number' && Number.isFinite(entry.lastSeenAt)
              ? entry.lastSeenAt
              : 0,
          fingerprint,
        });
      }
      if (mergeCurrent) {
        for (const [id, entry] of this.map) loaded.set(id, entry);
      }
      this.map = loaded;
      this.trim();
    } catch (err) {
      console.warn('[Timeline] turn-text cache load failed:', err);
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) this.flushSync();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Serialize immediately; extension persistence continues asynchronously. */
  flushSync(): void {
    if (!this.dirty) return;
    const key = this.storageKey();
    if (!key) {
      this.dirty = false;
      return;
    }
    this.trim();
    try {
      const payload: PersistedShape = {
        v: 1,
        entries: Array.from(this.map.values()),
      };
      const persistGeneration = ++this.persistGeneration;
      this.dirty = false;
      void setTimelinePrivateItem(key, JSON.stringify(payload)).then((saved) => {
        if (!saved && persistGeneration === this.persistGeneration && key === this.storageKey()) {
          this.dirty = true;
        }
      });
    } catch (err) {
      // Quota exceeded / private browsing — keep state in memory, retry later.
      console.warn('[Timeline] turn-text cache save failed:', err);
    }
  }

  /** Wait until the active conversation's queued extension write is settled. */
  async flush(): Promise<void> {
    const key = this.storageKey();
    this.flushSync();
    if (key) await waitForTimelinePrivateStorage([key]);
  }

  /** Drop everything (used by tests). */
  clear(): void {
    this.map.clear();
    this.dirty = true;
    this.scheduleSave();
  }

  /**
   * Sweep extension storage for `gptTimelineTurnTextCache:*` keys and evict the
   * least-recently-touched conversations down to `MAX_CONVERSATIONS`. Each
   * persisted payload's "most-recent activity" is the max `lastSeenAt` of
   * its entries (cheap to compute since entries are already in memory when
   * we read them).
   *
   * Called after active-conversation hydration so the user pays this cost at conversation
   * switch — never during scroll or other interactive paths. NEVER evicts
   * the currently-active conversation regardless of its recency rank.
   */
  private async evictOldConversations(): Promise<void> {
    try {
      const entries: Array<{ key: string; convId: string; mostRecent: number }> = [];
      const stored = await listTimelinePrivateItems(STORAGE_PREFIX);
      for (const [k, raw] of stored) {
        const convId = k.slice(STORAGE_PREFIX.length);
        let mostRecent = 0;
        try {
          const parsed = JSON.parse(raw) as Partial<PersistedShape>;
          if (Array.isArray(parsed.entries)) {
            for (const e of parsed.entries) {
              if (typeof e?.lastSeenAt === 'number' && e.lastSeenAt > mostRecent) {
                mostRecent = e.lastSeenAt;
              }
            }
          }
        } catch {
          // Malformed entry — leave at mostRecent=0 so it gets evicted first.
        }
        entries.push({ key: k, convId, mostRecent });
      }
      if (entries.length <= MAX_CONVERSATIONS) return;
      entries.sort((a, b) => a.mostRecent - b.mostRecent); // oldest first
      const evictCount = entries.length - MAX_CONVERSATIONS;
      const targets = entries
        .filter((entry) => entry.convId !== this.conversationId)
        .slice(0, evictCount);
      for (const target of targets) {
        // NEVER drop the conversation we are about to load / are inside.
        if (target.convId === this.conversationId) continue;
        try {
          await removeTimelinePrivateItem(target.key);
        } catch {
          /* ignore — single failure shouldn't poison the sweep */
        }
      }
    } catch {
      // localStorage walk failed (private mode, etc.) — non-fatal.
    }
  }

  /** Invalidate late hydration while preserving queued persistence. */
  destroy(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.flushSync();
    this.hydrationGeneration += 1;
  }
}
