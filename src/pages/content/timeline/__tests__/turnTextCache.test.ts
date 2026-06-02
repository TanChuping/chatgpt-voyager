import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TurnTextCache, computeFingerprint } from '../turnTextCache';

const STORAGE_PREFIX = 'gptTimelineTurnTextCache:';

/** Enumerate localStorage keys in a way that works in both real browsers
 *  and JSDOM (where Storage isn't a real Object). */
function enumerateStorageKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k != null) out.push(k);
  }
  return out;
}

describe('TurnTextCache', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    // JSDOM doesn't expose `.key()` on the localStorage instance — the
    // real Storage API has it, but the JSDOM mock omits it. Production
    // code (real Chrome) uses .key for the eviction sweep, so we shim it
    // here by wrapping setItem/removeItem to track insertion order.
    if (typeof (localStorage as Storage).key !== 'function') {
      const tracked: string[] = [];
      const origSet = localStorage.setItem.bind(localStorage);
      const origRemove = localStorage.removeItem.bind(localStorage);
      const origClear = localStorage.clear.bind(localStorage);
      // Repopulate tracked list from whatever was set before the polyfill
      // attached (cleared at the start of beforeEach so usually empty).
      Object.defineProperty(localStorage, 'setItem', {
        configurable: true,
        writable: true,
        value(key: string, val: string) {
          if (!tracked.includes(key)) tracked.push(key);
          return origSet(key, val);
        },
      });
      Object.defineProperty(localStorage, 'removeItem', {
        configurable: true,
        writable: true,
        value(key: string) {
          const i = tracked.indexOf(key);
          if (i >= 0) tracked.splice(i, 1);
          return origRemove(key);
        },
      });
      Object.defineProperty(localStorage, 'clear', {
        configurable: true,
        writable: true,
        value() {
          tracked.length = 0;
          return origClear();
        },
      });
      Object.defineProperty(localStorage, 'key', {
        configurable: true,
        writable: true,
        value(n: number): string | null {
          return n >= 0 && n < tracked.length ? tracked[n] : null;
        },
      });
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  function makeEntry(id: string, summary = `text-${id}`) {
    const attachments = [] as const;
    return {
      id,
      summary,
      attachments,
      hasGeneratedImage: false,
      lastSeenAt: Date.now(),
      fingerprint: computeFingerprint(summary, attachments),
    };
  }

  it('persists entries to localStorage under per-conversation key', () => {
    const cache = new TurnTextCache();
    cache.setConversation('gpt:conv:abc');

    cache.set(makeEntry('t1', 'hello'));
    cache.flushSync();

    const raw = localStorage.getItem(`${STORAGE_PREFIX}gpt:conv:abc`);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.v).toBe(1);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].id).toBe('t1');
    expect(parsed.entries[0].summary).toBe('hello');
  });

  it('hydrates from localStorage when conversation is set', () => {
    localStorage.setItem(
      `${STORAGE_PREFIX}gpt:conv:xyz`,
      JSON.stringify({
        v: 1,
        entries: [
          {
            id: 'preexisting',
            summary: 'cached text',
            attachments: [],
            hasGeneratedImage: false,
            lastSeenAt: 1000,
          },
        ],
      }),
    );

    const cache = new TurnTextCache();
    cache.setConversation('gpt:conv:xyz');

    expect(cache.get('preexisting')?.summary).toBe('cached text');
  });

  it('isolates conversations: switching reloads the right cache', () => {
    const cache = new TurnTextCache();

    cache.setConversation('gpt:conv:a');
    cache.set(makeEntry('a1', 'A1'));
    cache.flushSync();

    cache.setConversation('gpt:conv:b');
    expect(cache.get('a1')).toBeUndefined();
    cache.set(makeEntry('b1', 'B1'));
    cache.flushSync();

    cache.setConversation('gpt:conv:a');
    expect(cache.get('a1')?.summary).toBe('A1');
    expect(cache.get('b1')).toBeUndefined();
  });

  it('prune drops entries not in the live turn-id set (edit-message invalidation)', () => {
    const cache = new TurnTextCache();
    cache.setConversation('gpt:conv:edit');

    cache.set(makeEntry('keep-1'));
    cache.set(makeEntry('drop-after-edit'));
    cache.set(makeEntry('keep-2'));

    const removed = cache.prune(new Set(['keep-1', 'keep-2']));
    expect(removed).toBe(1);
    expect(cache.get('drop-after-edit')).toBeUndefined();
    expect(cache.get('keep-1')).toBeDefined();
    expect(cache.get('keep-2')).toBeDefined();
  });

  it('prune refuses to wipe the cache when the live set is empty (transient DOM state)', () => {
    const cache = new TurnTextCache();
    cache.setConversation('gpt:conv:transient');

    cache.set(makeEntry('t1'));
    cache.set(makeEntry('t2'));
    cache.set(makeEntry('t3'));

    // Reconcile racing against a torn-down DOM should not nuke the cache.
    const removed = cache.prune(new Set<string>());
    expect(removed).toBe(0);
    expect(cache.size()).toBe(3);
  });

  it('debounces saves: multiple sets coalesce into one localStorage write', async () => {
    vi.useRealTimers();
    const cache = new TurnTextCache();
    cache.setConversation('gpt:conv:debounce');

    const setSpy = vi.spyOn(localStorage, 'setItem');

    cache.set(makeEntry('t1'));
    cache.set(makeEntry('t2'));
    cache.set(makeEntry('t3'));
    // All three sets queue exactly one debounced write — not three.
    expect(setSpy).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(setSpy).toHaveBeenCalledTimes(1);
    setSpy.mockRestore();
  });

  it('flushSync persists immediately on destroy', () => {
    const cache = new TurnTextCache();
    cache.setConversation('gpt:conv:flush');

    cache.set(makeEntry('t1', 'in flight'));
    // No timer advance — debounce hasn't fired.
    cache.flushSync();

    const raw = localStorage.getItem(`${STORAGE_PREFIX}gpt:conv:flush`);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).entries[0].summary).toBe('in flight');
  });

  it('ignores set() before a conversation is bound', () => {
    const cache = new TurnTextCache();
    cache.set(makeEntry('t1'));
    expect(cache.size()).toBe(0);
  });

  it('survives malformed persisted payloads', () => {
    localStorage.setItem(`${STORAGE_PREFIX}gpt:conv:bad`, '{not-json');
    const cache = new TurnTextCache();
    expect(() => cache.setConversation('gpt:conv:bad')).not.toThrow();
    expect(cache.size()).toBe(0);
  });

  it('backfills fingerprint when loading legacy entries that lack the field', () => {
    // Old-format payload from before fingerprints existed — still has summary
    // + attachments. The cache should regenerate the fingerprint on load so
    // edit detection works on these entries too.
    localStorage.setItem(
      `${STORAGE_PREFIX}gpt:conv:legacy`,
      JSON.stringify({
        v: 1,
        entries: [
          {
            id: 'old-entry',
            summary: 'legacy summary',
            attachments: [],
            hasGeneratedImage: false,
            lastSeenAt: 500,
            // no fingerprint field
          },
        ],
      }),
    );

    const cache = new TurnTextCache();
    cache.setConversation('gpt:conv:legacy');
    expect(cache.get('old-entry')?.fingerprint).toBe(computeFingerprint('legacy summary', []));
  });

  describe('edit-detection contract (fingerprint comparison)', () => {
    // These tests assert the *cache primitives* the manager uses to detect
    // edits — the actual mismatch-triggers-prune logic lives in
    // TimelineManager.recalculateAndRenderMarkers, but it boils down to:
    //
    //   1. on each turn with live content, compute fingerprint
    //   2. if cache has an entry AND cached.fingerprint !== live.fingerprint
    //      AND this isn't the trailing (streaming) turn → editDetected = true
    //   3. always update cache with latest fingerprint
    //   4. after the loop: if editDetected → prune(nextIds)
    //
    // The tests below simulate each scenario at the cache level.

    it('refresh of long conversation: fingerprints match, prune must NOT fire', () => {
      // Setup: 5 turns previously cached. User reloads — DOM progressive
      // mount only renders 2 of them so far. Both rendered ones have content
      // identical to the cache (they're the same conversation).
      const cache = new TurnTextCache();
      cache.setConversation('gpt:conv:refresh');
      for (let i = 1; i <= 5; i++) {
        cache.set({
          id: `t${i}`,
          summary: `turn ${i} body`,
          attachments: [],
          hasGeneratedImage: false,
          lastSeenAt: Date.now() - 1000,
          fingerprint: computeFingerprint(`turn ${i} body`, []),
        });
      }

      // Simulate the manager's per-turn check on the 2 currently-mounted turns.
      const liveTurns = [
        { id: 't1', summary: 'turn 1 body', attachments: [] as const },
        { id: 't2', summary: 'turn 2 body', attachments: [] as const },
      ];
      let editDetected = false;
      for (let idx = 0; idx < liveTurns.length; idx++) {
        const turn = liveTurns[idx];
        const cached = cache.get(turn.id);
        const liveFp = computeFingerprint(turn.summary, turn.attachments);
        if (cached && cached.fingerprint !== liveFp && idx < liveTurns.length - 1) {
          editDetected = true;
        }
      }

      expect(editDetected).toBe(false);
      // No prune ⇒ all 5 cached entries survive the partial-mount pass.
      expect(cache.size()).toBe(5);
    });

    it('user edits a mid-conversation turn: fingerprint mismatches, prune fires', () => {
      // Setup: cache has 6 entries from a previous session. User edits t3 → ChatGPT
      // forks at t3, so DOM now has t1, t2, t3' (new body), t4', t5' (all new ids).
      const cache = new TurnTextCache();
      cache.setConversation('gpt:conv:edit');
      for (let i = 1; i <= 6; i++) {
        cache.set({
          id: `t${i}`,
          summary: `original turn ${i}`,
          attachments: [],
          hasGeneratedImage: false,
          lastSeenAt: Date.now() - 1000,
          fingerprint: computeFingerprint(`original turn ${i}`, []),
        });
      }
      cache.flushSync();

      // ChatGPT's post-edit DOM: t1 and t2 unchanged, t3 has new content,
      // t4'/t5' are fresh turn-ids. We don't simulate t6 — the user trimmed it.
      const liveTurns = [
        { id: 't1', summary: 'original turn 1', attachments: [] as const },
        { id: 't2', summary: 'original turn 2', attachments: [] as const },
        { id: 't3', summary: 'EDITED turn 3', attachments: [] as const },
        { id: 't4-prime', summary: 'fresh assistant reply', attachments: [] as const },
        { id: 't5-prime', summary: 'fresh follow-up', attachments: [] as const },
      ];
      let editDetected = false;
      const nextIds: string[] = [];
      for (let idx = 0; idx < liveTurns.length; idx++) {
        const turn = liveTurns[idx];
        nextIds.push(turn.id);
        const cached = cache.get(turn.id);
        const liveFp = computeFingerprint(turn.summary, turn.attachments);
        if (cached && cached.fingerprint !== liveFp && idx < liveTurns.length - 1) {
          editDetected = true;
        }
        cache.set({
          id: turn.id,
          summary: turn.summary,
          attachments: turn.attachments,
          hasGeneratedImage: false,
          lastSeenAt: Date.now(),
          fingerprint: liveFp,
        });
      }

      expect(editDetected).toBe(true);
      const removed = cache.prune(new Set(nextIds));
      // t4, t5, t6 (orphaned old ids) should be gone. t3 stays because its
      // turn-id appears in the live DOM (just with new content, which we
      // already overwrote above).
      expect(removed).toBe(3);
      expect(cache.get('t4')).toBeUndefined();
      expect(cache.get('t5')).toBeUndefined();
      expect(cache.get('t6')).toBeUndefined();
      expect(cache.get('t4-prime')?.summary).toBe('fresh assistant reply');
    });

    it('streaming generation of the trailing turn does NOT trigger prune', () => {
      // Setup: 3 stable turns + 1 trailing turn that's mid-generation. The
      // trailing turn's live summary changes between reconcile passes, but
      // we treat that as "in flight" and skip it for edit detection.
      const cache = new TurnTextCache();
      cache.setConversation('gpt:conv:stream');
      for (let i = 1; i <= 4; i++) {
        cache.set({
          id: `t${i}`,
          summary: `stable text ${i}`,
          attachments: [],
          hasGeneratedImage: false,
          lastSeenAt: Date.now() - 1000,
          fingerprint: computeFingerprint(`stable text ${i}`, []),
        });
      }

      // Reconcile mid-stream: t4 has grown from "stable text 4" → "stable text 4 plus more"
      const liveTurns = [
        { id: 't1', summary: 'stable text 1', attachments: [] as const },
        { id: 't2', summary: 'stable text 2', attachments: [] as const },
        { id: 't3', summary: 'stable text 3', attachments: [] as const },
        { id: 't4', summary: 'stable text 4 plus more', attachments: [] as const },
      ];
      let editDetected = false;
      for (let idx = 0; idx < liveTurns.length; idx++) {
        const turn = liveTurns[idx];
        const cached = cache.get(turn.id);
        const liveFp = computeFingerprint(turn.summary, turn.attachments);
        // The manager's trailing-turn guard — `idx < length - 1` — means
        // changes to the very last turn never count as edits.
        if (cached && cached.fingerprint !== liveFp && idx < liveTurns.length - 1) {
          editDetected = true;
        }
      }

      expect(editDetected).toBe(false);
    });

    it('attachment changes count as content edits too', () => {
      const cache = new TurnTextCache();
      cache.setConversation('gpt:conv:attach');
      cache.set({
        id: 't1',
        summary: 'same text',
        attachments: [{ name: 'old.pdf', type: 'pdf' as const }],
        hasGeneratedImage: false,
        lastSeenAt: Date.now(),
        fingerprint: computeFingerprint('same text', [{ name: 'old.pdf', type: 'pdf' as const }]),
      });
      cache.set({
        id: 't2',
        summary: 'something else',
        attachments: [],
        hasGeneratedImage: false,
        lastSeenAt: Date.now(),
        fingerprint: computeFingerprint('something else', []),
      });

      // User re-edits with a different file (text content identical).
      const cached = cache.get('t1');
      const liveFp = computeFingerprint('same text', [{ name: 'new.pdf', type: 'pdf' as const }]);
      expect(cached?.fingerprint).not.toBe(liveFp);
    });
  });

  describe('cleanup audit (multiple writers, growth limits)', () => {
    it('idempotent set() does NOT trigger a localStorage write when fingerprint matches', async () => {
      vi.useRealTimers();
      const cache = new TurnTextCache();
      cache.setConversation('gpt:conv:idemp');
      cache.set(makeEntry('t1', 'hello'));
      await new Promise((r) => setTimeout(r, 500));
      const setSpy = vi.spyOn(localStorage, 'setItem');
      // Write the SAME content again — primer + reconcile typically race like this.
      cache.set(makeEntry('t1', 'hello'));
      cache.set(makeEntry('t1', 'hello'));
      cache.set(makeEntry('t1', 'hello'));
      await new Promise((r) => setTimeout(r, 500));
      expect(setSpy).not.toHaveBeenCalled();
      setSpy.mockRestore();
    });

    it('idempotent set() DOES trigger save when fingerprint changes', async () => {
      vi.useRealTimers();
      const cache = new TurnTextCache();
      cache.setConversation('gpt:conv:change');
      cache.set(makeEntry('t1', 'hello'));
      await new Promise((r) => setTimeout(r, 500));
      const setSpy = vi.spyOn(localStorage, 'setItem');
      cache.set(makeEntry('t1', 'world')); // different content
      await new Promise((r) => setTimeout(r, 500));
      expect(setSpy).toHaveBeenCalledTimes(1);
      setSpy.mockRestore();
    });

    it('evicts oldest conversations when localStorage exceeds the conversation cap', () => {
      vi.useRealTimers();
      // Seed 85 fake conversation cache entries with ascending lastSeenAt
      for (let i = 0; i < 85; i++) {
        const key = `${STORAGE_PREFIX}gpt:conv:bulk-${i}`;
        localStorage.setItem(
          key,
          JSON.stringify({
            v: 1,
            entries: [
              {
                id: `u-${i}`,
                summary: `seed-${i}`,
                attachments: [],
                hasGeneratedImage: false,
                lastSeenAt: i, // older = lower
                fingerprint: computeFingerprint(`seed-${i}`, []),
              },
            ],
          }),
        );
      }
      const before = enumerateStorageKeys().filter((k) => k.startsWith(STORAGE_PREFIX)).length;
      expect(before).toBe(85);

      // Loading a fresh conversation should trigger eviction down to MAX (80).
      const cache = new TurnTextCache();
      cache.setConversation('gpt:conv:current');

      const after = enumerateStorageKeys().filter((k) => k.startsWith(STORAGE_PREFIX)).length;
      // 80 cap, plus the newly-bound conversation is exempt from eviction
      // (and would be added when we call set/flush). Since we haven't
      // written anything yet, just check the others got trimmed.
      expect(after).toBeLessThanOrEqual(80);
      // The youngest 5 of the seeded 85 (lastSeenAt=80..84) must survive.
      expect(localStorage.getItem(`${STORAGE_PREFIX}gpt:conv:bulk-84`)).not.toBeNull();
      expect(localStorage.getItem(`${STORAGE_PREFIX}gpt:conv:bulk-80`)).not.toBeNull();
      // The oldest must be gone.
      expect(localStorage.getItem(`${STORAGE_PREFIX}gpt:conv:bulk-0`)).toBeNull();
    });

    it('never evicts the conversation we are about to load', () => {
      vi.useRealTimers();
      // Seed the active conversation with `lastSeenAt: 0` (oldest), plus 85 newer ones.
      localStorage.setItem(
        `${STORAGE_PREFIX}gpt:conv:active`,
        JSON.stringify({
          v: 1,
          entries: [
            {
              id: 'u-1',
              summary: 'keep me',
              attachments: [],
              hasGeneratedImage: false,
              lastSeenAt: 0,
              fingerprint: computeFingerprint('keep me', []),
            },
          ],
        }),
      );
      for (let i = 0; i < 85; i++) {
        localStorage.setItem(
          `${STORAGE_PREFIX}gpt:conv:other-${i}`,
          JSON.stringify({
            v: 1,
            entries: [
              {
                id: `u-x${i}`,
                summary: 'x',
                attachments: [],
                hasGeneratedImage: false,
                lastSeenAt: 100 + i,
                fingerprint: computeFingerprint('x', []),
              },
            ],
          }),
        );
      }
      const cache = new TurnTextCache();
      cache.setConversation('gpt:conv:active');
      // The active conversation must NOT have been evicted despite being
      // the oldest by lastSeenAt.
      expect(localStorage.getItem(`${STORAGE_PREFIX}gpt:conv:active`)).not.toBeNull();
      // And it should be readable.
      expect(cache.get('u-1')?.summary).toBe('keep me');
    });

    it('getConversationId returns the bound conversation (used by primer to filter cross-conv events)', () => {
      const cache = new TurnTextCache();
      expect(cache.getConversationId()).toBeNull();
      cache.setConversation('gpt:conv:x');
      expect(cache.getConversationId()).toBe('gpt:conv:x');
      cache.setConversation(null);
      expect(cache.getConversationId()).toBeNull();
    });
  });
});
