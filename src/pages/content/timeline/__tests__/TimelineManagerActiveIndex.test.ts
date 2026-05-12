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

  it('adopts the document scroller when the browser scrollbar moves', () => {
    const manager = new TimelineManager();
    const firstTurn = document.createElement('div');
    firstTurn.className = 'user';
    document.body.appendChild(firstTurn);

    const oldScrollContainer = document.createElement('div');
    const documentScroller = document.documentElement;
    Object.defineProperty(documentScroller, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(documentScroller, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(documentScroller, 'scrollTop', {
      value: 300,
      writable: true,
      configurable: true,
    });
    vi.spyOn(documentScroller, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(firstTurn, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 120,
      right: 800,
      bottom: 220,
      width: 800,
      height: 100,
      x: 0,
      y: 120,
      toJSON: () => ({}),
    } as DOMRect);

    const markers = [
      {
        id: 'm0',
        element: firstTurn,
        summary: '',
        n: 0,
        baseN: 0,
        dotElement: null,
        starred: false,
      },
    ];

    const internal = manager as unknown as {
      userTurnSelector: string;
      scrollContainer: HTMLElement | null;
      markers: typeof markers;
      markerTops: number[];
      onScroll: (() => void) | null;
      adoptScrollContainerFromScrollEvent: (target: EventTarget | null) => boolean;
      updateTimelineGeometry: () => void;
      syncTimelineTrackToMain: () => void;
      updateVirtualRangeAndRender: () => void;
      updateSlider: () => void;
    };

    internal.userTurnSelector = '.user';
    internal.scrollContainer = oldScrollContainer;
    internal.markers = markers;
    internal.markerTops = [0];
    internal.onScroll = vi.fn();
    internal.updateTimelineGeometry = vi.fn();
    internal.syncTimelineTrackToMain = vi.fn();
    internal.updateVirtualRangeAndRender = vi.fn();
    internal.updateSlider = vi.fn();

    expect(internal.adoptScrollContainerFromScrollEvent(document)).toBe(true);
    expect(internal.scrollContainer).toBe(documentScroller);
    expect(internal.markerTops).toEqual([420]);

    manager.destroy();
  });
});
