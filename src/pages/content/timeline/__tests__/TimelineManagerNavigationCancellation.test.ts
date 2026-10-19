import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineManager } from '../manager';

type Navigation = {
  scrollContainer: HTMLElement;
  scrollMode: 'flow' | 'jump';
  activeTurnId: string | null;
  smoothScrollTo: (target: HTMLElement, duration: number, id: string) => void;
  updateActiveDotUI: () => void;
  syncTimelineTrackToMain: () => void;
  scheduleScrollSync: () => void;
  recalculateAndRenderMarkers: () => void;
  setupEventListeners: () => void;
  refreshForThreadChange: () => void;
  refreshCriticalElementsFromDocument: () => boolean;
  ui: { timelineBar: HTMLElement | null };
};

function harness() {
  const manager = new TimelineManager();
  const nav = manager as unknown as Navigation;
  const scroller = document.createElement('div');
  document.body.appendChild(scroller);
  Object.defineProperties(scroller, {
    scrollHeight: { value: 10000 },
    clientHeight: { value: 600 },
  });
  scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    scroller.scrollTop = top ?? 0;
  }) as typeof scroller.scrollTo;
  nav.scrollContainer = scroller;
  nav.scrollMode = 'flow';
  nav.updateActiveDotUI = vi.fn();
  nav.syncTimelineTrackToMain = vi.fn();
  nav.scheduleScrollSync = vi.fn();
  nav.recalculateAndRenderMarkers = vi.fn();
  nav.refreshCriticalElementsFromDocument = vi.fn(() => false);
  const target = (top: number) => {
    const el = document.createElement('div');
    scroller.appendChild(el);
    vi.spyOn(el, 'getBoundingClientRect').mockImplementation(
      () => ({ top: top - scroller.scrollTop }) as DOMRect,
    );
    return el;
  };
  return { manager, nav, scroller, target };
}

describe('timeline navigation ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom lacks CSS.escape; these fixtures only use simple identifier keys.
    vi.stubGlobal('CSS', { ...globalThis.CSS, escape: (value: string) => value });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('a new jump cancels the previous overshoot and correction', () => {
    const { manager, nav, scroller, target } = harness();
    nav.smoothScrollTo(target(5000), 600, 'old');
    vi.advanceTimersByTime(80);
    nav.smoothScrollTo(target(1000), 0, 'latest');
    vi.advanceTimersByTime(2000);
    expect(scroller.scrollTop).toBe(1000);
    expect(nav.activeTurnId).toBe('latest');
    manager.destroy();
  });

  it('destroying a manager cancels its pending scroll writes', () => {
    const { manager, nav, scroller, target } = harness();
    nav.smoothScrollTo(target(5000), 600, 'old');
    manager.destroy();
    scroller.scrollTop = 123;
    vi.advanceTimersByTime(2000);
    expect(scroller.scrollTop).toBe(123);
  });

  it('waits for delayed virtual layout measurement instead of accepting three early frames', () => {
    const { manager, nav, scroller, target } = harness();
    let top = 1000;
    const el = target(top);
    vi.mocked(el.getBoundingClientRect).mockImplementation(
      () => ({ top: top - scroller.scrollTop }) as DOMRect,
    );
    nav.smoothScrollTo(el, 0, 'target');
    vi.advanceTimersByTime(160);
    top = 2200;
    vi.advanceTimersByTime(1000);
    expect(scroller.scrollTop).toBe(2200);
    manager.destroy();
  });

  it('uses the mounted row rather than a stale mirror estimate', () => {
    const { manager, nav, scroller, target } = harness();
    const main = document.createElement('main');
    document.body.appendChild(main);
    main.appendChild(scroller);
    const anchor = target(1000);
    anchor.setAttribute('data-gv-thread-anchor', 'turn');
    target(1700).setAttribute('data-turn-key', 'turn');
    nav.smoothScrollTo(anchor, 0, 'u-turn');
    vi.advanceTimersByTime(700);
    expect(scroller.scrollTop).toBe(1700);
    manager.destroy();
  });

  it('keeps negative scroll coordinates on column-reverse layouts', () => {
    const { manager, nav, scroller, target } = harness();
    scroller.style.flexDirection = 'column-reverse';
    nav.smoothScrollTo(target(-3500), 0, 'reverse');
    vi.advanceTimersByTime(700);
    expect(scroller.scrollTop).toBe(-3500);
    manager.destroy();
  });

  it('stops delayed corrections when the user scrolls manually', () => {
    const { manager, nav, scroller, target } = harness();
    nav.ui.timelineBar = document.createElement('div');
    document.body.appendChild(nav.ui.timelineBar);
    nav.setupEventListeners();
    nav.smoothScrollTo(target(5000), 600, 'old');
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
    scroller.scrollTop = 900;
    vi.advanceTimersByTime(2000);
    expect(scroller.scrollTop).toBe(900);
    manager.destroy();
  });

  it('follows a late native layout commit, but releases the anchor after user input', () => {
    const { manager, nav, scroller, target } = harness();
    nav.ui.timelineBar = document.createElement('div');
    document.body.appendChild(nav.ui.timelineBar);
    nav.setupEventListeners();
    let top = 1000;
    const el = target(top);
    vi.mocked(el.getBoundingClientRect).mockImplementation(
      () => ({ top: top - scroller.scrollTop }) as DOMRect,
    );
    nav.smoothScrollTo(el, 0, 'target');
    vi.advanceTimersByTime(3000);
    top = 2200;
    nav.refreshForThreadChange();
    vi.advanceTimersByTime(700);
    expect(scroller.scrollTop).toBe(2200);
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
    scroller.scrollTop = 2300;
    top = 2500;
    nav.refreshForThreadChange();
    vi.advanceTimersByTime(700);
    expect(scroller.scrollTop).toBe(2300);
    manager.destroy();
  });
});
