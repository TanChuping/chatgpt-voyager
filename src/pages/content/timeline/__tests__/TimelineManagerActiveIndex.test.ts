import { describe, expect, it, vi } from 'vitest';

import { TimelineManager } from '../manager';

describe('TimelineManager active marker', () => {
  it('uses cached marker tops when available', () => {
    const manager = new TimelineManager();

    const scrollContainer = document.createElement('div');
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    scrollContainer.scrollTop = 0;

    const elements = [
      document.createElement('div'),
      document.createElement('div'),
      document.createElement('div'),
    ];
    const rectSpies = elements.map((el) => vi.spyOn(el, 'getBoundingClientRect'));

    const markers = elements.map((element, index) => ({
      id: `m${index}`,
      element,
      summary: '',
      n: 0,
      baseN: 0,
      dotElement: null,
      starred: false,
    }));

    const internal = manager as unknown as {
      scrollContainer: HTMLElement | null;
      markers: typeof markers;
      markerTops: number[];
      activeTurnId: string | null;
      computeActiveByScroll: () => void;
    };

    internal.scrollContainer = scrollContainer;
    internal.markers = markers;
    internal.markerTops = [0, 100, 200];
    internal.activeTurnId = null;

    internal.computeActiveByScroll();

    expect(internal.activeTurnId).toBe('m1');
    rectSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });

  it('updates the active dot immediately from scroll position', () => {
    const manager = new TimelineManager();

    const scrollContainer = document.createElement('div');
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    scrollContainer.scrollTop = 260;

    const firstDot = document.createElement('button');
    firstDot.className = 'timeline-dot active';
    const secondDot = document.createElement('button');
    secondDot.className = 'timeline-dot';
    const thirdDot = document.createElement('button');
    thirdDot.className = 'timeline-dot';

    const markers = [firstDot, secondDot, thirdDot].map((dotElement, index) => ({
      id: `m${index}`,
      element: document.createElement('div'),
      summary: '',
      n: 0,
      baseN: 0,
      dotElement,
      starred: false,
    }));

    const internal = manager as unknown as {
      scrollContainer: HTMLElement | null;
      markers: typeof markers;
      markerTops: number[];
      activeTurnId: string | null;
      lastActiveChangeTime: number;
      activeLockUntil: number;
      pendingActiveId: string | null;
      computeActiveByScroll: () => void;
    };

    internal.scrollContainer = scrollContainer;
    internal.markers = markers;
    internal.markerTops = [0, 180, 360];
    internal.activeTurnId = 'm0';
    internal.lastActiveChangeTime = performance.now();
    internal.activeLockUntil = performance.now() + 10_000;

    internal.computeActiveByScroll();

    expect(internal.activeTurnId).toBe('m2');
    expect(internal.pendingActiveId).toBeNull();
    expect(firstDot.classList.contains('active')).toBe(false);
    expect(thirdDot.classList.contains('active')).toBe(true);
  });
});
