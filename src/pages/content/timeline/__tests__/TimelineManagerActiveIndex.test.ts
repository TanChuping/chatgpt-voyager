import { describe, expect, it, vi } from 'vitest';

import { TimelineManager } from '../manager';

describe('TimelineManager active marker', () => {
  const createTimelineUi = (trackHeight = 120) => {
    const timelineBar = document.createElement('div');
    const track = document.createElement('div');
    const trackContent = document.createElement('div');
    track.className = 'timeline-track';
    trackContent.className = 'timeline-track-content';
    track.appendChild(trackContent);
    timelineBar.appendChild(track);

    Object.defineProperty(timelineBar, 'clientHeight', { value: trackHeight, configurable: true });
    Object.defineProperty(track, 'clientHeight', { value: trackHeight, configurable: true });
    vi.spyOn(timelineBar, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 40,
      bottom: trackHeight,
      width: 40,
      height: trackHeight,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    return { timelineBar, track, trackContent };
  };

  const createMarkers = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `m${index}`,
      element: document.createElement('div'),
      summary: `marker ${index}`,
      n: 0,
      baseN: 0,
      dotElement: null,
      starred: false,
    }));

  it('uses live marker positions when they are available', () => {
    const manager = new TimelineManager();

    const scrollContainer = document.createElement('div');
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    scrollContainer.scrollTop = 0;
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 400,
      bottom: 400,
      width: 400,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const elements = [
      document.createElement('div'),
      document.createElement('div'),
      document.createElement('div'),
    ];
    const rectSpies = elements.map((el, index) =>
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: index * 100,
        right: 400,
        bottom: index * 100 + 60,
        width: 400,
        height: 60,
        x: 0,
        y: index * 100,
        toJSON: () => ({}),
      } as DOMRect),
    );

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
    expect(rectSpies[0]).toHaveBeenCalledTimes(1);
    expect(rectSpies[1]).toHaveBeenCalledTimes(1);
    expect(rectSpies[2]).toHaveBeenCalledTimes(1);
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

  it('prefers live marker positions over stale cached tops', () => {
    const manager = new TimelineManager();

    const scrollContainer = document.createElement('div');
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    scrollContainer.scrollTop = 0;
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 400,
      bottom: 400,
      width: 400,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const markers = createMarkers(3);
    [0, 1000, 2000].forEach((top, index) => {
      vi.spyOn(markers[index].element, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top,
        right: 400,
        bottom: top + 80,
        width: 400,
        height: 80,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect);
    });

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

    expect(internal.activeTurnId).toBe('m0');
    manager.destroy();
  });

  it('does not stop active detection at an out-of-order live marker', () => {
    const manager = new TimelineManager();

    const scrollContainer = document.createElement('div');
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    scrollContainer.scrollTop = 0;
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 400,
      bottom: 400,
      width: 400,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const markers = createMarkers(3);
    [0, 1000, 120].forEach((top, index) => {
      vi.spyOn(markers[index].element, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top,
        right: 400,
        bottom: top + 80,
        width: 400,
        height: 80,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect);
    });

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

    expect(internal.activeTurnId).toBe('m2');
    manager.destroy();
  });

  it('clears a stale pin focus when scrolling to a different turn', () => {
    const manager = new TimelineManager();
    const markers = createMarkers(2);

    const internal = manager as unknown as {
      markers: typeof markers;
      markerMap: Map<string, (typeof markers)[number]>;
      pinsByTurn: Map<string, Array<{ id: string; turnId: string }>>;
      pinFocusTurnId: string | null;
      selectedPinId: string | null;
      selectedPinTurnId: string | null;
      applyActiveTurnFromScroll: (activeId: string) => void;
      activeTurnId: string | null;
    };

    internal.markers = markers;
    internal.markerMap = new Map(markers.map((marker) => [marker.id, marker]));
    internal.pinsByTurn = new Map([['m0', [{ id: 'p0', turnId: 'm0' }]]]);
    internal.pinFocusTurnId = 'm0';
    internal.selectedPinId = 'p0';
    internal.selectedPinTurnId = 'm0';

    internal.applyActiveTurnFromScroll('m1');

    expect(internal.activeTurnId).toBe('m1');
    expect(internal.pinFocusTurnId).toBeNull();
    expect(internal.selectedPinId).toBeNull();
    expect(internal.selectedPinTurnId).toBeNull();
    manager.destroy();
  });

  it('defers marker rebuilding while scroll activity is still fresh', () => {
    vi.useFakeTimers();
    const manager = new TimelineManager();
    const markers = createMarkers(1);

    const internal = manager as unknown as {
      markers: typeof markers;
      lastUserScrollAt: number;
      markerRecalcScrollIdleDelay: number;
      shouldDeferMarkerRecalculation: () => boolean;
      deferredMarkerRecalcTimerId: number | null;
      destroy: () => void;
    };

    internal.markers = markers;
    internal.lastUserScrollAt = 1;

    expect(internal.shouldDeferMarkerRecalculation()).toBe(true);

    vi.advanceTimersByTime(internal.markerRecalcScrollIdleDelay + 1);

    expect(internal.shouldDeferMarkerRecalculation()).toBe(false);
    manager.destroy();
    vi.useRealTimers();
  });

  it('requires confirmation before committing marker order changes during interaction', () => {
    const manager = new TimelineManager();
    const markers = createMarkers(3);

    const internal = manager as unknown as {
      markers: typeof markers;
      lastUserScrollAt: number;
      pendingMarkerOrderSignature: string | null;
      previewPanel: { isOpen: boolean } | null;
      shouldConfirmMarkerOrderChange: (nextIds: string[]) => boolean;
    };

    internal.markers = markers;
    internal.lastUserScrollAt = performance.now();
    internal.previewPanel = { isOpen: true, destroy: vi.fn() } as never;

    const nextIds = ['m0', 'inserted', 'm1', 'm2'];
    expect(internal.shouldConfirmMarkerOrderChange(nextIds)).toBe(true);
    internal.pendingMarkerOrderSignature = nextIds.join('|');
    expect(internal.shouldConfirmMarkerOrderChange(nextIds)).toBe(false);

    manager.destroy();
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

  it('refreshes a stale scroll container from the current user turn element', () => {
    const manager = new TimelineManager();
    const oldScrollContainer = document.createElement('div');
    const nextScrollContainer = document.createElement('div');
    nextScrollContainer.style.overflowY = 'auto';
    Object.defineProperty(nextScrollContainer, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(nextScrollContainer, 'scrollHeight', { value: 2000, configurable: true });

    const firstTurn = document.createElement('div');
    nextScrollContainer.appendChild(firstTurn);
    document.body.appendChild(nextScrollContainer);

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
      scrollContainer: HTMLElement | null;
      markers: typeof markers;
      markerTops: number[];
      refreshScrollContainerForElement: (element: HTMLElement | null | undefined) => boolean;
    };

    internal.scrollContainer = oldScrollContainer;
    internal.markers = markers;
    internal.markerTops = [0];

    expect(internal.refreshScrollContainerForElement(firstTurn)).toBe(true);
    expect(internal.scrollContainer).toBe(nextScrollContainer);

    manager.destroy();
  });

  it('refreshes marker tops even when the scroll container stays the same', () => {
    const manager = new TimelineManager();
    const scrollContainer = document.createElement('div');
    scrollContainer.style.overflowY = 'auto';
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 2000, configurable: true });
    scrollContainer.scrollTop = 180;

    const firstTurn = document.createElement('div');
    scrollContainer.appendChild(firstTurn);
    document.body.appendChild(scrollContainer);
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 20,
      right: 400,
      bottom: 420,
      width: 400,
      height: 400,
      x: 0,
      y: 20,
      toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(firstTurn, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 260,
      right: 400,
      bottom: 320,
      width: 400,
      height: 60,
      x: 0,
      y: 260,
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
      scrollContainer: HTMLElement | null;
      markers: typeof markers;
      markerTops: number[];
      refreshScrollContainerForElement: (element: HTMLElement | null | undefined) => boolean;
    };

    internal.scrollContainer = scrollContainer;
    internal.markers = markers;
    internal.markerTops = [0];

    expect(internal.refreshScrollContainerForElement(firstTurn)).toBe(true);
    expect(internal.scrollContainer).toBe(scrollContainer);
    expect(internal.markerTops).toEqual([420]);

    manager.destroy();
  });

  it('renders and scrolls the active dot into the timeline track viewport', () => {
    const manager = new TimelineManager();
    const { timelineBar, track, trackContent } = createTimelineUi(120);
    const markers = createMarkers(30);
    const yPositions = markers.map((_, index) => index * 50);

    const internal = manager as unknown as {
      ui: {
        timelineBar: HTMLElement | null;
        track: HTMLElement | null;
        trackContent: HTMLElement | null;
      };
      markers: typeof markers;
      yPositions: number[];
      contentHeight: number;
      visibleRange: { start: number; end: number };
      activeTurnId: string | null;
      usePixelTop: boolean;
      updateVirtualRangeAndRender: () => void;
      updateActiveDotUI: () => void;
    };

    internal.ui.timelineBar = timelineBar;
    internal.ui.track = track;
    internal.ui.trackContent = trackContent;
    internal.markers = markers;
    internal.yPositions = yPositions;
    internal.contentHeight = 1500;
    internal.visibleRange = { start: 0, end: -1 };
    internal.activeTurnId = 'm24';
    internal.usePixelTop = true;

    internal.updateVirtualRangeAndRender();
    expect(markers[24].dotElement).toBeNull();

    internal.updateActiveDotUI();

    expect(track.scrollTop).toBeGreaterThan(900);
    expect(markers[24].dotElement).not.toBeNull();
    expect(markers[24].dotElement?.classList.contains('active')).toBe(true);
    expect(trackContent.contains(markers[24].dotElement)).toBe(true);
  });

  it('does not move the timeline track when the active dot is already visible', () => {
    const manager = new TimelineManager();
    const { timelineBar, track, trackContent } = createTimelineUi(120);
    const scrollContainer = document.createElement('div');
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 3000, configurable: true });
    track.scrollTop = 0;

    const markers = createMarkers(6);
    const internal = manager as unknown as {
      ui: {
        timelineBar: HTMLElement | null;
        track: HTMLElement | null;
        trackContent: HTMLElement | null;
      };
      scrollContainer: HTMLElement | null;
      markers: typeof markers;
      yPositions: number[];
      contentHeight: number;
      activeTurnId: string | null;
      syncTimelineTrackToMain: () => boolean;
    };

    internal.ui.timelineBar = timelineBar;
    internal.ui.track = track;
    internal.ui.trackContent = trackContent;
    internal.scrollContainer = scrollContainer;
    internal.markers = markers;
    internal.yPositions = [0, 50, 100, 150, 200, 250];
    internal.contentHeight = 300;
    internal.activeTurnId = 'm2';

    expect(internal.syncTimelineTrackToMain()).toBe(false);
    expect(track.scrollTop).toBe(0);
  });

  it('resyncs the timeline track to the newly active dot after page scrolling', () => {
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });

    const manager = new TimelineManager();
    const { timelineBar, track, trackContent } = createTimelineUi(120);
    const scrollContainer = document.createElement('div');
    scrollContainer.style.overflowY = 'auto';
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 3000, configurable: true });
    scrollContainer.scrollTop = 0;
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 400,
      bottom: 400,
      width: 400,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    track.scrollTop = 1250;

    const markers = createMarkers(30);
    markers.forEach((marker, index) => {
      vi.spyOn(marker.element, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: index * 100,
        right: 400,
        bottom: index * 100 + 60,
        width: 400,
        height: 60,
        x: 0,
        y: index * 100,
        toJSON: () => ({}),
      } as DOMRect);
    });
    markers.forEach((marker) => scrollContainer.appendChild(marker.element));
    document.body.appendChild(scrollContainer);
    const yPositions = markers.map((_, index) => index * 50);

    const internal = manager as unknown as {
      ui: {
        timelineBar: HTMLElement | null;
        track: HTMLElement | null;
        trackContent: HTMLElement | null;
      };
      scrollContainer: HTMLElement | null;
      markers: typeof markers;
      markerTops: number[];
      yPositions: number[];
      contentHeight: number;
      visibleRange: { start: number; end: number };
      activeTurnId: string | null;
      usePixelTop: boolean;
      lastScrollContainerRefreshAt: number;
      scheduleScrollSync: () => void;
    };

    internal.ui.timelineBar = timelineBar;
    internal.ui.track = track;
    internal.ui.trackContent = trackContent;
    internal.scrollContainer = scrollContainer;
    internal.markers = markers;
    internal.markerTops = markers.map((_, index) => index * 100);
    internal.yPositions = yPositions;
    internal.contentHeight = 1500;
    internal.visibleRange = { start: 0, end: -1 };
    internal.activeTurnId = 'm29';
    internal.usePixelTop = true;
    internal.lastScrollContainerRefreshAt = performance.now();

    internal.scheduleScrollSync();

    expect(internal.activeTurnId).toBe('m1');
    expect(track.scrollTop).toBeLessThan(100);
    expect(markers[1].dotElement?.classList.contains('active')).toBe(true);
    expect(trackContent.contains(markers[1].dotElement)).toBe(true);

    rafSpy.mockRestore();
  });

  it('keeps the current active dot visible after the timeline slider is dragged away', () => {
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });

    const manager = new TimelineManager();
    const { timelineBar, track, trackContent } = createTimelineUi(120);
    const scrollContainer = document.createElement('div');
    scrollContainer.style.overflowY = 'auto';
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 3000, configurable: true });
    scrollContainer.scrollTop = 0;
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 400,
      bottom: 400,
      width: 400,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    track.scrollTop = 1250;

    const markers = createMarkers(30);
    markers.forEach((marker, index) => {
      vi.spyOn(marker.element, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: index * 100,
        right: 400,
        bottom: index * 100 + 60,
        width: 400,
        height: 60,
        x: 0,
        y: index * 100,
        toJSON: () => ({}),
      } as DOMRect);
    });
    markers.forEach((marker) => scrollContainer.appendChild(marker.element));
    document.body.appendChild(scrollContainer);
    const yPositions = markers.map((_, index) => index * 50);

    const internal = manager as unknown as {
      ui: {
        timelineBar: HTMLElement | null;
        track: HTMLElement | null;
        trackContent: HTMLElement | null;
      };
      scrollContainer: HTMLElement | null;
      markers: typeof markers;
      markerTops: number[];
      yPositions: number[];
      contentHeight: number;
      visibleRange: { start: number; end: number };
      activeTurnId: string | null;
      usePixelTop: boolean;
      lastScrollContainerRefreshAt: number;
      scheduleScrollSync: () => void;
    };

    internal.ui.timelineBar = timelineBar;
    internal.ui.track = track;
    internal.ui.trackContent = trackContent;
    internal.scrollContainer = scrollContainer;
    internal.markers = markers;
    internal.markerTops = markers.map((_, index) => index * 100);
    internal.yPositions = yPositions;
    internal.contentHeight = 1500;
    internal.visibleRange = { start: 0, end: -1 };
    internal.activeTurnId = 'm1';
    internal.usePixelTop = true;
    internal.lastScrollContainerRefreshAt = performance.now();

    internal.scheduleScrollSync();

    expect(internal.activeTurnId).toBe('m1');
    expect(track.scrollTop).toBeLessThan(100);
    expect(markers[1].dotElement?.classList.contains('active')).toBe(true);
    expect(trackContent.contains(markers[1].dotElement)).toBe(true);

    rafSpy.mockRestore();
  });
});
