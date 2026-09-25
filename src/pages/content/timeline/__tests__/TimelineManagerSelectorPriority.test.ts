import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineManager } from '../manager';
import { THREAD_ANCHOR_SELECTOR } from '../threadAnchors';
import { USER_TURN_ANCHOR_SELECTOR } from '../turnAnchors';

/**
 * `findCriticalElements` always unions the anchor selectors (2026-09 thread
 * mirror, 2026-07 wrapper tag) in front of whichever selector won detection
 * (see `withUserTurnAnchors`), so these assertions check the *resolved*
 * selector, not the raw string.
 */
const ANCHOR_PREFIX = `${THREAD_ANCHOR_SELECTOR},${USER_TURN_ANCHOR_SELECTOR},`;
const resolved = (selector: string): string =>
  selector.startsWith(ANCHOR_PREFIX) ? selector.slice(ANCHOR_PREFIX.length) : selector;

describe('TimelineManager selector priority compatibility', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('prefers built-in selectors over stale auto-detected selector cache', async () => {
    const main = document.createElement('main');

    const defaultTurn = document.createElement('div');
    defaultTurn.className = 'user-query-bubble-with-background';
    defaultTurn.textContent = 'default turn';
    main.appendChild(defaultTurn);

    const staleTurn = document.createElement('div');
    staleTurn.className = 'stale-selector-target';
    staleTurn.textContent = 'stale turn';
    main.appendChild(staleTurn);

    document.body.appendChild(main);
    localStorage.setItem('gptTimelineUserTurnSelectorAuto', '.stale-selector-target');

    const manager = new TimelineManager();
    const internal = manager as unknown as {
      findCriticalElements: () => Promise<boolean>;
      userTurnSelector: string;
    };

    const ok = await internal.findCriticalElements();
    expect(ok).toBe(true);
    expect(resolved(internal.userTurnSelector)).toBe('.user-query-bubble-with-background');
    expect(localStorage.getItem('gptTimelineUserTurnSelectorAuto')).toBe(
      '.user-query-bubble-with-background',
    );
  });

  it('keeps explicit user override as highest priority', async () => {
    const main = document.createElement('main');

    const defaultTurn = document.createElement('div');
    defaultTurn.className = 'user-query-bubble-with-background';
    defaultTurn.textContent = 'default turn';
    main.appendChild(defaultTurn);

    const customTurn = document.createElement('div');
    customTurn.className = 'custom-user-turn';
    customTurn.textContent = 'custom turn';
    main.appendChild(customTurn);

    document.body.appendChild(main);
    localStorage.setItem('gptTimelineUserTurnSelector', '.custom-user-turn');

    const manager = new TimelineManager();
    const internal = manager as unknown as {
      findCriticalElements: () => Promise<boolean>;
      userTurnSelector: string;
    };

    const ok = await internal.findCriticalElements();
    expect(ok).toBe(true);
    expect(resolved(internal.userTurnSelector)).toBe('.custom-user-turn');
  });
});
