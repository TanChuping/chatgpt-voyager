import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TurnTextCache } from '@/pages/content/timeline/turnTextCache';

import { installFiberFallbackForManager } from '../FiberFallback';
import type { FiberFallbackHandle } from '../FiberFallback';

const CONV = '12345678-1234-1234-1234-123456789abc';
const OTHER_CONV = '87654321-4321-4321-4321-cba987654321';
// Assistant wrappers never resolve, so they stay in every pass's unresolved set.
const LATEST_PAGE = ['assistant-14', 'assistant-15'];
const OLDER_PAGE = ['user-8', 'assistant-8', 'user-9', 'assistant-9'];

function fiberRequests(post: ReturnType<typeof vi.spyOn>): number {
  return post.mock.calls.filter(
    ([data]) => (data as { __gvType?: string } | null)?.__gvType === 'gv-fiber-request',
  ).length;
}

describe('FiberFallback request budget', () => {
  let conv: string;
  let post: ReturnType<typeof vi.spyOn>;
  let handle: FiberFallbackHandle;
  let onRecheckDue: ReturnType<typeof vi.fn>;
  let unresolved: string[];

  /** One timeline reconcile pass reporting the current unresolved wrappers. */
  const reconcile = () => handle.requestIfNeeded(unresolved.length > 0, unresolved);

  beforeEach(() => {
    vi.useFakeTimers();
    conv = `gpt:conv:${CONV}`;
    unresolved = [...LATEST_PAGE];
    post = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    // The manager answers a due recheck with a full reconcile pass.
    onRecheckDue = vi.fn(() => reconcile());
    handle = installFiberFallbackForManager({} as TurnTextCache, {
      getConversationId: () => conv,
      onPrimed: vi.fn(),
      onRecheckDue,
    });
  });

  afterEach(() => {
    handle.dispose();
    post.mockRestore();
    vi.useRealTimers();
  });

  it('fires the first read once the grace window ends, without another DOM mutation', () => {
    reconcile();
    expect(fiberRequests(post)).toBe(0);

    vi.advanceTimersByTime(1100);

    expect(onRecheckDue).toHaveBeenCalledOnce();
    expect(fiberRequests(post)).toBe(1);
  });

  it('keeps plain retries opportunistic and stops after the per-conversation budget', () => {
    reconcile();
    vi.advanceTimersByTime(1100);
    expect(fiberRequests(post)).toBe(1);

    // No new wrappers: a pass inside the throttle window must not arm a timer.
    reconcile();
    vi.advanceTimersByTime(5000);
    expect(onRecheckDue).toHaveBeenCalledOnce();

    for (let i = 0; i < 5; i++) {
      reconcile();
      vi.advanceTimersByTime(1600);
    }
    expect(fiberRequests(post)).toBe(3);
  });

  it('reads again when older history loads after the budget is spent (#20)', () => {
    reconcile();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1600);
      reconcile();
    }
    expect(fiberRequests(post)).toBe(3);

    // The user scrolled up; ChatGPT paged in older turns and virtualised them.
    unresolved = [...OLDER_PAGE, ...LATEST_PAGE];
    reconcile();
    expect(fiberRequests(post)).toBe(4);

    // Those wrappers were covered by that read: no further churn.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1600);
      reconcile();
    }
    expect(fiberRequests(post)).toBe(4);
  });

  it('delivers a new-history read that lands inside the throttle window', () => {
    reconcile();
    vi.advanceTimersByTime(1100);
    expect(fiberRequests(post)).toBe(1);

    unresolved = [...OLDER_PAGE, ...LATEST_PAGE];
    reconcile();
    expect(fiberRequests(post)).toBe(1);

    vi.advanceTimersByTime(1600);
    expect(fiberRequests(post)).toBe(2);
  });

  it('starts a fresh budget for another conversation', () => {
    reconcile();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1600);
      reconcile();
    }
    expect(fiberRequests(post)).toBe(3);

    conv = OTHER_CONV;
    reconcile();
    vi.advanceTimersByTime(1100);
    expect(fiberRequests(post)).toBe(4);
    expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ convId: OTHER_CONV });
  });

  it('cancels a pending recheck on dispose', () => {
    reconcile();
    handle.dispose();
    vi.advanceTimersByTime(5000);
    expect(onRecheckDue).not.toHaveBeenCalled();
    expect(fiberRequests(post)).toBe(0);
  });
});
