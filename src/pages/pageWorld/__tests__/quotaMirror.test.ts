import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQuotaMirror, normalizeQuotaSnapshot } from '../quotaMirror';

const payload = (used = 6) => ({
  email: 'private@example.test',
  account_id: 'private-account',
  rate_limit: {
    primary_window: { used_percent: used, limit_window_seconds: 604800, reset_at: 1791580383 },
    secondary_window: null,
  },
  credits: { balance: '0', unlimited: false },
});

afterEach(() => vi.restoreAllMocks());

describe('passive quota mirror', () => {
  it('copies only quota fields, reverses used percent and omits an absent window', () => {
    const snapshot = normalizeQuotaSnapshot(payload(), 1000)!;
    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.windows[0].remaining).toBe(94);
    expect(snapshot.windows[0].seconds).toBe(604800);
    expect(snapshot.credits).toBe('0');
    expect(JSON.stringify(snapshot)).not.toContain('private');
  });

  it('does not turn missing or invalid usage into a full quota', () => {
    expect(
      normalizeQuotaSnapshot({ rate_limit: { primary_window: { limit_window_seconds: 18000 } } })!
        .windows,
    ).toEqual([]);
    expect(normalizeQuotaSnapshot(payload(-1))!.windows).toEqual([]);
    expect(normalizeQuotaSnapshot(payload(NaN))!.windows).toEqual([]);
    expect(normalizeQuotaSnapshot(payload(0))!.windows[0].remaining).toBe(100);
    expect(normalizeQuotaSnapshot({ arbitrary: true })).toBeNull();
  });

  it('discards a delayed previous-account response without performing any fetch', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const fetch = vi.spyOn(globalThis, 'fetch');
    const mirror = createQuotaMirror();
    try {
      const old = mirror.beforeFetch('/backend-api/wham/usage', {
        headers: { 'ChatGPT-Account-Id': 'A' },
      });
      mirror.beforeFetch('/backend-api/conversations', { headers: { 'ChatGPT-Account-Id': 'B' } });
      post.mockClear();
      mirror.afterFetch(old, new Response(JSON.stringify(payload())));
      await Promise.resolve();
      expect(post).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      mirror.destroy();
    }
  });

  it('ignores old overlapping requests and clears a snapshot on authentication failure', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const mirror = createQuotaMirror();
    try {
      const older = mirror.beforeFetch('/backend-api/wham/usage');
      const newer = mirror.beforeFetch('/backend-api/wham/usage');
      mirror.afterFetch(newer, new Response(JSON.stringify(payload(25))));
      await vi.waitFor(() => expect(post).toHaveBeenCalled());
      post.mockClear();
      mirror.afterFetch(older, new Response(JSON.stringify(payload(6))));
      await Promise.resolve();
      expect(post).not.toHaveBeenCalled();
      const denied = mirror.beforeFetch('/backend-api/wham/usage');
      mirror.afterFetch(denied, new Response('', { status: 401 }));
      expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ snapshot: null, failed: true });
    } finally {
      mirror.destroy();
    }
  });

  it('stops cloning quota responses when the setting is off', () => {
    const mirror = createQuotaMirror();
    try {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: location.origin,
          data: { __gvType: 'gv-quota-feature', enabled: false },
        }),
      );
      expect(mirror.beforeFetch('/backend-api/wham/usage')).toBeNull();
    } finally {
      mirror.destroy();
    }
  });
});
