/**
 * Behaviour tests for the AnnouncementService dedupe state machine.
 *
 * Coverage matrix:
 *   1. New install, current=A     → bubble pops, dot on
 *   2. After markBubbleShown(A)   → bubble does NOT pop again, dot still on
 *   3. After markSeen(A)          → bubble does NOT pop, dot OFF
 *   4. Server publishes B ≠ A     → bubble pops, dot on
 *   5. Server publishes nothing   → bubble doesn't pop, dot off
 *   6. Malformed JSON             → treated as no current; cache preserved
 *   7. 30-min TTL                 → cached fetch reused; no network on refresh
 *
 * The point of these is to act as a safety net for the user-stated
 * requirement: "气泡只弹一次, 用户点叉了一次就不会再弹除非有新公告".
 * A regression in the dedupe logic would be the worst kind of bug —
 * the user just sees the bubble pop on every page load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import type { RemoteAnnouncementFile } from '../types';

// chrome.storage shim — same shape we used for chatFontFamily tests.
type StorageListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  area: string,
) => void;
const sync: Record<string, unknown> = {};
const local: Record<string, unknown> = {};
const listeners: StorageListener[] = [];

function fire(area: 'sync' | 'local', changes: Record<string, unknown>) {
  const p: Record<string, { newValue?: unknown }> = {};
  for (const [k, v] of Object.entries(changes)) p[k] = { newValue: v };
  for (const cb of listeners) cb(p, area);
}

(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    sync: {
      get: (keys: string[], cb: (r: Record<string, unknown>) => void) => {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in sync) out[k] = sync[k];
        queueMicrotask(() => cb(out));
      },
      set: (items: Record<string, unknown>, cb?: () => void) => {
        Object.assign(sync, items);
        fire('sync', items);
        if (cb) queueMicrotask(cb);
      },
    },
    local: {
      get: (keys: string[], cb: (r: Record<string, unknown>) => void) => {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in local) out[k] = local[k];
        queueMicrotask(() => cb(out));
      },
      set: (items: Record<string, unknown>, cb?: () => void) => {
        Object.assign(local, items);
        fire('local', items);
        if (cb) queueMicrotask(cb);
      },
    },
    onChanged: {
      addListener: (cb: StorageListener) => listeners.push(cb),
      removeListener: (cb: StorageListener) => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      },
    },
  },
};

let mockResponse: RemoteAnnouncementFile | { broken: true } | null = null;
let mockStatus = 200;
const fetchSpy = vi.fn(async () => {
  if (mockStatus !== 200) {
    return new Response('', { status: mockStatus });
  }
  return new Response(JSON.stringify(mockResponse), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

// Import AFTER chrome + fetch are installed so the module captures
// the right references.
const {
  refreshSnapshot,
  markBubbleShown,
  markSeen,
  getLastSnapshot,
  subscribe,
  __resetAnnouncementServiceForTests,
} = await import('../service');

function setRemote(file: RemoteAnnouncementFile | null) {
  mockResponse = file;
  mockStatus = 200;
}

const sample = (id: string): RemoteAnnouncementFile => ({
  v: 1,
  current: {
    id,
    title: `Title ${id}`,
    summary: 'A short summary.',
    bodyMarkdown: '# Body',
  },
});

beforeEach(() => {
  for (const k of Object.keys(sync)) delete sync[k];
  for (const k of Object.keys(local)) delete local[k];
  listeners.length = 0;
  __resetAnnouncementServiceForTests();
  fetchSpy.mockClear();
  mockResponse = null;
  mockStatus = 200;
});

afterEach(() => {
  __resetAnnouncementServiceForTests();
});

describe('AnnouncementService — dedupe state machine', () => {
  it('new install with a current announcement → bubble pops, dot on', async () => {
    setRemote(sample('A'));
    const snap = await refreshSnapshot();
    expect(snap.current?.id).toBe('A');
    expect(snap.shouldPopBubble).toBe(true);
    expect(snap.hasUnread).toBe(true);
  });

  it('after markBubbleShown, bubble does NOT pop again but dot stays on', async () => {
    setRemote(sample('A'));
    await refreshSnapshot();
    await markBubbleShown('A');
    const snap = await refreshSnapshot(true);
    expect(snap.shouldPopBubble).toBe(false);
    expect(snap.hasUnread).toBe(true);
  });

  it('after markSeen, bubble does not pop and dot is off', async () => {
    setRemote(sample('A'));
    await refreshSnapshot();
    await markSeen('A');
    const snap = await refreshSnapshot(true);
    expect(snap.shouldPopBubble).toBe(false);
    expect(snap.hasUnread).toBe(false);
  });

  it('server publishes a new id → bubble pops again ONCE the hard cooldowns have elapsed', async () => {
    // Pre-1.6.6: bubble re-popped immediately for a new id after
    // markSeen. Post-1.6.6: hard cooldowns veto for 14 days (bubble)
    // and 24 hours (dot). We backdate both ceilings here so the test
    // exercises the pure id-based "new id triggers pop" contract, not
    // the cooldown veto. The dedicated cooldown tests below cover the
    // veto path explicitly.
    setRemote(sample('A'));
    await refreshSnapshot();
    await markSeen('A');
    // Step out of both cooldown windows.
    local[StorageKeys.ANNOUNCEMENT_LAST_BUBBLE_AT] = Date.now() - 15 * 24 * 60 * 60 * 1000;
    local[StorageKeys.ANNOUNCEMENT_LAST_SEEN_AT] = Date.now() - 25 * 60 * 60 * 1000;
    setRemote(sample('B'));
    const snap = await refreshSnapshot(true);
    expect(snap.current?.id).toBe('B');
    expect(snap.shouldPopBubble).toBe(true);
    expect(snap.hasUnread).toBe(true);
  });

  it('feed with current: null → no bubble, no dot', async () => {
    setRemote({ v: 1, current: null });
    const snap = await refreshSnapshot();
    expect(snap.current).toBeNull();
    expect(snap.shouldPopBubble).toBe(false);
    expect(snap.hasUnread).toBe(false);
  });

  it('404 → treated as no current; cache stored', async () => {
    mockStatus = 404;
    const snap = await refreshSnapshot();
    expect(snap.current).toBeNull();
    expect(snap.shouldPopBubble).toBe(false);
  });

  it('malformed JSON → falls back to cache; does not crash or flip flags', async () => {
    setRemote(sample('A'));
    await refreshSnapshot();
    await markSeen('A');
    // Now serve garbage
    mockResponse = { broken: true } as unknown as RemoteAnnouncementFile;
    const snap = await refreshSnapshot(true);
    // Cached A is still what we evaluate; user seen it → no bubble, no dot.
    expect(snap.current?.id).toBe('A');
    expect(snap.shouldPopBubble).toBe(false);
    expect(snap.hasUnread).toBe(false);
  });

  it('cache hit within TTL → no network fetch', async () => {
    setRemote(sample('A'));
    await refreshSnapshot();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await refreshSnapshot(); // not forced
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('force=true bypasses cache', async () => {
    setRemote(sample('A'));
    await refreshSnapshot();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await refreshSnapshot(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('markSeen also marks bubble as shown so a same-id refresh doesn\'t re-pop', async () => {
    setRemote(sample('A'));
    await refreshSnapshot();
    await markSeen('A');
    // Simulate a fresh tab init (cache only, no force):
    const snap = await refreshSnapshot();
    expect(snap.shouldPopBubble).toBe(false);
    expect(local[StorageKeys.ANNOUNCEMENT_BUBBLE_SHOWN_FOR]).toBe('A');
    expect(local[StorageKeys.ANNOUNCEMENT_SEEN_ID]).toBe('A');
  });

  it('rejects payload missing required fields (id / title / summary / bodyMarkdown)', async () => {
    mockResponse = {
      v: 1,
      current: { id: 'X', title: 'no summary' },
    } as unknown as RemoteAnnouncementFile;
    const snap = await refreshSnapshot();
    expect(snap.current).toBeNull();
    expect(snap.shouldPopBubble).toBe(false);
  });

  it('rejects payload with wrong schema version', async () => {
    mockResponse = {
      v: 2,
      current: sample('A').current,
    } as unknown as RemoteAnnouncementFile;
    const snap = await refreshSnapshot();
    expect(snap.current).toBeNull();
  });

  // ---- 1.6.6+ contract: eager-mark + force-refresh ------------------

  it('markBubbleShown refreshes lastSnapshot synchronously after the write', async () => {
    // Pre-fix: markBubbleShown only wrote storage; callers had to wait
    // on the chrome.storage.onChanged → refreshSnapshot round-trip for
    // shouldPopBubble to flip false. In a rapid-navigate test loop the
    // round-trip didn't complete before unload and the next page saw
    // an empty flag, popping the bubble all over again.
    setRemote(sample('A'));
    const snap1 = await refreshSnapshot();
    expect(snap1.shouldPopBubble).toBe(true);
    await markBubbleShown('A');
    expect(getLastSnapshot().shouldPopBubble).toBe(false);
    expect(getLastSnapshot().hasUnread).toBe(true);
    expect(local[StorageKeys.ANNOUNCEMENT_BUBBLE_SHOWN_FOR]).toBe('A');
  });

  it('markSeen refreshes lastSnapshot synchronously so the dot turns off immediately', async () => {
    setRemote(sample('A'));
    await refreshSnapshot();
    expect(getLastSnapshot().hasUnread).toBe(true);
    await markSeen('A');
    expect(getLastSnapshot().hasUnread).toBe(false);
    expect(getLastSnapshot().shouldPopBubble).toBe(false);
  });

  it('markSeen notifies subscribers synchronously (host applySnapshot sees fresh state)', async () => {
    setRemote(sample('A'));
    await refreshSnapshot();
    const received: boolean[] = [];
    subscribe(() => {
      received.push(getLastSnapshot().hasUnread);
    });
    await markSeen('A');
    // We expect at least one notify to have fired with hasUnread=false
    // (could be more than one — chrome.storage.onChanged also re-fires
    // refreshSnapshot; both notify with the same final state).
    expect(received).toContain(false);
  });

  it('eager-mark contract: marking A as shown does NOT suppress a later push of new id B (after cooldown)', async () => {
    // The eager write must PREVENT same-id re-pop without permanently
    // killing the new-announcement workflow. Under the 1.6.6+ hard
    // cooldown the new pop is delayed by 14 d (bubble) / 24 h (dot)
    // — after that, the new id surfaces normally. We backdate the
    // ceilings to exercise that path here; the cooldown-VETO path
    // is covered by its own test.
    setRemote(sample('A'));
    await refreshSnapshot();
    await markBubbleShown('A');
    expect(getLastSnapshot().shouldPopBubble).toBe(false);
    // Step out of the cooldown window.
    local[StorageKeys.ANNOUNCEMENT_LAST_BUBBLE_AT] = Date.now() - 15 * 24 * 60 * 60 * 1000;
    // Publisher releases B.
    setRemote(sample('B'));
    const snap = await refreshSnapshot(true);
    expect(snap.current?.id).toBe('B');
    expect(snap.shouldPopBubble).toBe(true);
    expect(snap.hasUnread).toBe(true);
  });

  it('eager-mark survives across simulated tab reload (storage persistence)', async () => {
    // Tab 1: fetch + eagerly mark.
    setRemote(sample('A'));
    await refreshSnapshot();
    await markBubbleShown('A');
    // Tab 2: simulate a fresh content-script bootstrap by resetting
    // the module state (storage backing store stays). Cache should be
    // reused (TTL fresh), flag should still be there, no re-pop.
    __resetAnnouncementServiceForTests();
    const tab2Snap = await refreshSnapshot();
    expect(tab2Snap.current?.id).toBe('A');
    expect(tab2Snap.shouldPopBubble).toBe(false);
    expect(tab2Snap.hasUnread).toBe(true);
  });

  it('eager-mark is id-keyed: clearing the flag for one id does not affect another (post-cooldown)', async () => {
    // Publisher pushed B → user dismissed → after cooldowns expire,
    // a future B' release pops normally. The B id-flag must not
    // survive into B'. Hard cooldowns backdated so we exercise the
    // id-key contract, not the cooldown veto.
    setRemote(sample('B'));
    await refreshSnapshot();
    await markSeen('B');
    local[StorageKeys.ANNOUNCEMENT_LAST_BUBBLE_AT] = Date.now() - 15 * 24 * 60 * 60 * 1000;
    local[StorageKeys.ANNOUNCEMENT_LAST_SEEN_AT] = Date.now() - 25 * 60 * 60 * 1000;
    setRemote(sample('B-prime'));
    const snap = await refreshSnapshot(true);
    expect(snap.shouldPopBubble).toBe(true);
    expect(snap.hasUnread).toBe(true);
  });

  // ---- 1.6.6+ HARD COOLDOWNS (id-agnostic ceilings) -----------------
  // These guarantee user-protection at the storage layer, not just by
  // policy: even if the id-based detection above flips shouldPopBubble
  // to true for any reason (race, corruption, publisher mistake), the
  // bubble physically cannot pop more than once per 14 days, and the
  // dot cannot light up within 24 hours of explicit dismiss.

  it('bubble hard cooldown: same-id refresh in cooldown stays silent (existing contract)', async () => {
    setRemote(sample('A'));
    await refreshSnapshot();
    await markBubbleShown('A');
    const snap = await refreshSnapshot();
    expect(snap.shouldPopBubble).toBe(false);
  });

  it('bubble hard cooldown: VETOES a new-id pop if cooldown window is still active', async () => {
    // Simulate "publisher accidentally bumps id" or "any future
    // detection bug flips shouldPopBubble true again". The 14-day
    // ceiling must win.
    setRemote(sample('A'));
    await refreshSnapshot();
    await markBubbleShown('A');
    // Publisher bumps id immediately. id-based detection alone would
    // happily pop; the hard cooldown is the safety net.
    setRemote(sample('B'));
    const snap = await refreshSnapshot(true);
    expect(snap.current?.id).toBe('B');
    // shouldPopBubble vetoed by hard cooldown even though current.id
    // is different from both seenId (empty) and BUBBLE_SHOWN_FOR ('A').
    expect(snap.shouldPopBubble).toBe(false);
    // Dot still works as normal — that's the detection layer's job.
    expect(snap.hasUnread).toBe(true);
  });

  it('bubble hard cooldown: pop allowed again once 14 days have elapsed', async () => {
    setRemote(sample('A'));
    await refreshSnapshot();
    await markBubbleShown('A');
    // Backdate LAST_BUBBLE_AT by 15 days to step OUT of the cooldown.
    local[StorageKeys.ANNOUNCEMENT_LAST_BUBBLE_AT] = Date.now() - 15 * 24 * 60 * 60 * 1000;
    setRemote(sample('B'));
    const snap = await refreshSnapshot(true);
    expect(snap.shouldPopBubble).toBe(true);
  });

  it('dot hard cooldown: VETOES the dot for 24h after markSeen even if new id arrives', async () => {
    setRemote(sample('A'));
    await refreshSnapshot();
    await markSeen('A');
    expect(getLastSnapshot().hasUnread).toBe(false);
    // Publisher pushes a brand-new id 1 hour later. Detection would
    // normally light the dot (new id != seenId 'A'). Cooldown vetoes.
    setRemote(sample('B'));
    const snap = await refreshSnapshot(true);
    expect(snap.current?.id).toBe('B');
    expect(snap.hasUnread).toBe(false);
    // Also no bubble (hard cooldown still in 14-day window).
    expect(snap.shouldPopBubble).toBe(false);
  });

  it('dot hard cooldown: dot lights up after 24h elapsed even with same dismiss state', async () => {
    setRemote(sample('A'));
    await refreshSnapshot();
    await markSeen('A');
    // Backdate LAST_SEEN_AT by 25h, but new id 'B' arrives.
    local[StorageKeys.ANNOUNCEMENT_LAST_SEEN_AT] = Date.now() - 25 * 60 * 60 * 1000;
    setRemote(sample('B'));
    const snap = await refreshSnapshot(true);
    expect(snap.hasUnread).toBe(true);
  });

  it('hard cooldown ALSO survives an id-detection regression (corrupted BUBBLE_SHOWN_FOR flag)', async () => {
    // Simulate the worst case: id-based flag got blown away somehow
    // (extension upgrade migration bug, manual storage edit, etc.).
    // The cooldown is the last line of defense.
    setRemote(sample('A'));
    await refreshSnapshot();
    await markBubbleShown('A');
    // Sabotage the id-based flag.
    delete local[StorageKeys.ANNOUNCEMENT_BUBBLE_SHOWN_FOR];
    // Same id, fresh refresh — id detection alone would pop.
    const snap = await refreshSnapshot(true);
    expect(snap.shouldPopBubble).toBe(false);
  });

  it('refreshSnapshot notifies subscribers EXACTLY ONCE per call (no double-fire)', async () => {
    // Regression guard for the index.ts flashing bug: pre-fix, the
    // `void refreshSnapshot().then(applySnapshot)` pattern in
    // startAnnouncement and onStorage caused applySnapshot to be
    // invoked twice per refresh — once via notify→subscribe, once
    // via .then. Two showBubbleFor calls back-to-back meant
    // mountBubble ran twice, and its `forEach(b => b.remove())`
    // destroyed the live bubble mid-click. The fix is to drop the
    // redundant .then in index.ts/service.ts and rely on the
    // notify→subscribe path alone. This test pins that contract
    // at the service level: ONE refreshSnapshot = ONE subscriber
    // call.
    setRemote(sample('A'));
    let calls = 0;
    subscribe(() => {
      calls++;
    });
    await refreshSnapshot();
    expect(calls).toBe(1);
    // Sanity: second refresh is also exactly one more call.
    await refreshSnapshot();
    expect(calls).toBe(2);
  });
});
