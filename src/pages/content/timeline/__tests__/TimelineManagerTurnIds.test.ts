import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineManager } from '../manager';

function setElementTop(el: HTMLElement, top: number): void {
  Object.defineProperty(el, 'offsetTop', { value: top, configurable: true });
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: vi.fn(() => ({
      x: 0,
      y: top,
      top,
      left: 0,
      right: 0,
      bottom: top,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    })),
    configurable: true,
  });
}

function createUserTurn(text: string, top: number): HTMLElement {
  const turn = document.createElement('div');
  turn.className = 'user';
  turn.textContent = text;
  setElementTop(turn, top);
  return turn;
}

type TimelineManagerInternal = {
  conversationContainer: HTMLElement | null;
  scrollContainer: HTMLElement | null;
  userTurnSelector: string | null;
  ui: { timelineBar: HTMLElement | null; trackContent: HTMLElement | null };
  activeTurnId: string | null;
  markers: Array<{ id: string; element: HTMLElement }>;
  recalculateAndRenderMarkers: () => void;
  updateTimelineGeometry: () => void;
  updateIntersectionObserverTargetsFromMarkers: () => void;
  syncTimelineTrackToMain: () => void;
  updateVirtualRangeAndRender: () => void;
  updateActiveDotUI: () => void;
  scheduleScrollSync: () => void;
  lastUserScrollAt: number;
  lastObservedScrollTop: number;
  markerOrderChangeConfirmDelay: number;
};

function createHarness(): {
  container: HTMLElement;
  internal: TimelineManagerInternal;
} {
  const main = document.createElement('main');
  document.body.appendChild(main);

  const scrollContainer = document.createElement('div');
  Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
  scrollContainer.scrollTop = 0;
  vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect);
  main.appendChild(scrollContainer);

  const container = document.createElement('div');
  scrollContainer.appendChild(container);

  const timelineBar = document.createElement('div');
  const trackContent = document.createElement('div');
  timelineBar.appendChild(trackContent);
  document.body.appendChild(timelineBar);

  const manager = new TimelineManager();
  const internal = manager as unknown as TimelineManagerInternal;
  internal.conversationContainer = container;
  internal.scrollContainer = scrollContainer;
  internal.userTurnSelector = '.user';
  internal.ui.timelineBar = timelineBar;
  internal.ui.trackContent = trackContent;
  internal.activeTurnId = null;

  internal.updateTimelineGeometry = vi.fn();
  internal.updateIntersectionObserverTargetsFromMarkers = vi.fn();
  internal.syncTimelineTrackToMain = vi.fn();
  internal.updateVirtualRangeAndRender = vi.fn();
  internal.updateActiveDotUI = vi.fn();
  internal.scheduleScrollSync = vi.fn();

  return { container, internal };
}

describe('TimelineManager turn ids', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('keeps existing turn ids unique when older turns are prepended', () => {
    const { container, internal } = createHarness();

    const first = createUserTurn('first loaded turn', 0);
    const second = createUserTurn('second loaded turn', 100);
    container.append(first, second);

    internal.recalculateAndRenderMarkers();

    const firstId = internal.markers[0]!.id;
    const secondId = internal.markers[1]!.id;

    const older = createUserTurn('older prepended turn', 0);
    setElementTop(first, 100);
    setElementTop(second, 200);
    container.prepend(older);

    internal.recalculateAndRenderMarkers();

    const ids = internal.markers.map((marker) => marker.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(internal.markers.find((marker) => marker.element === first)?.id).toBe(firstId);
    expect(internal.markers.find((marker) => marker.element === second)?.id).toBe(secondId);
    expect(internal.markers.find((marker) => marker.element === older)?.id).not.toBe(firstId);
  });

  it('repairs duplicated DOM turn ids by preserving the previous marker owner', () => {
    const { container, internal } = createHarness();

    const first = createUserTurn('first loaded turn', 0);
    const second = createUserTurn('second loaded turn', 100);
    container.append(first, second);

    internal.recalculateAndRenderMarkers();

    const firstId = internal.markers[0]!.id;

    const older = createUserTurn('older prepended turn', 0);
    older.dataset.turnId = firstId;
    setElementTop(first, 100);
    setElementTop(second, 200);
    container.prepend(older);

    internal.recalculateAndRenderMarkers();

    const ids = internal.markers.map((marker) => marker.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(internal.markers.find((marker) => marker.element === first)?.id).toBe(firstId);
    expect(internal.markers.find((marker) => marker.element === older)?.id).not.toBe(firstId);
  });

  it('does not accept a new marker order while the user is actively scrolling', () => {
    vi.useFakeTimers();
    const { container, internal } = createHarness();

    const first = createUserTurn('first loaded turn', 0);
    const second = createUserTurn('second loaded turn', 100);
    container.append(first, second);

    internal.recalculateAndRenderMarkers();
    const originalIds = internal.markers.map((marker) => marker.id);

    const older = createUserTurn('older prepended turn', 0);
    setElementTop(first, 100);
    setElementTop(second, 200);
    container.prepend(older);

    internal.lastUserScrollAt = performance.now();
    internal.lastObservedScrollTop = 0;
    internal.scrollContainer!.scrollTop = 60;
    internal.recalculateAndRenderMarkers();

    expect(internal.markers.map((marker) => marker.id)).toEqual(originalIds);

    vi.advanceTimersByTime(2500);
    internal.lastUserScrollAt = 0;
    internal.lastObservedScrollTop = internal.scrollContainer!.scrollTop;
    internal.recalculateAndRenderMarkers();
    vi.advanceTimersByTime(internal.markerOrderChangeConfirmDelay + 1);
    internal.recalculateAndRenderMarkers();

    expect(internal.markers).toHaveLength(3);
    expect(internal.markers.find((marker) => marker.element === first)?.id).toBe(originalIds[0]);
    expect(internal.markers.find((marker) => marker.element === second)?.id).toBe(originalIds[1]);
    expect(new Set(internal.markers.map((marker) => marker.id)).size).toBe(3);
    vi.useRealTimers();
  });
});
