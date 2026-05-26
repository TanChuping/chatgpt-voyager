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

  it('server publishes a new id → bubble pops again', async () => {
    setRemote(sample('A'));
    await refreshSnapshot();
    await markSeen('A');
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
});
