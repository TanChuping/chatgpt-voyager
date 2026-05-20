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
 * Storage: localStorage, keyed `gptTimelineTurnTextCache:<conversationId>`.
 * Capped at MAX_ENTRIES per conversation (LRU by lastSeenAt). Saves are
 * debounced so a long scroll session doesn't hammer localStorage.
 */

import type { AttachmentInfo } from './attachments';

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

const STORAGE_PREFIX = 'gptTimelineTurnTextCache:';
const MAX_ENTRIES = 500;
const SAVE_DEBOUNCE_MS = 400;

export class TurnTextCache {
  private map = new Map<string, TurnTextCacheEntry>();
  private conversationId: string | null = null;
  private saveTimer: number | null = null;
  private dirty = false;

  /** Switch the active conversation. Loads its persisted cache (replacing the
   * in-memory map). Safe to call repeatedly with the same id (no-op). */
  setConversation(conversationId: string | null): void {
    if (conversationId === this.conversationId) return;
    // Flush any pending writes for the previous conversation before swapping.
    this.flushSync();
    this.conversationId = conversationId;
    this.map.clear();
    if (!conversationId) return;
    this.load();
  }

  get(turnId: string): TurnTextCacheEntry | undefined {
    return this.map.get(turnId);
  }

  /** Insert/refresh a snapshot. Should only be called when the live DOM
   * produced non-empty content for this turn — caching an empty snapshot
   * would mask the fallback mechanism. */
  set(entry: TurnTextCacheEntry): void {
    if (!this.conversationId) return;
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

  private load(): void {
    const key = this.storageKey();
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<PersistedShape>;
      if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.entries)) return;
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
        this.map.set(entry.id, {
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

  /** Write the current map to localStorage immediately. Called by the
   * debounced timer and on conversation switch. */
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
      localStorage.setItem(key, JSON.stringify(payload));
      this.dirty = false;
    } catch (err) {
      // Quota exceeded / private browsing — keep state in memory, retry later.
      console.warn('[Timeline] turn-text cache save failed:', err);
    }
  }

  /** Drop everything (used by tests). */
  clear(): void {
    this.map.clear();
    this.dirty = true;
    this.scheduleSave();
  }
}
