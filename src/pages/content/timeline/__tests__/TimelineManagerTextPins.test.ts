import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineManager } from '../manager';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('TimelineManager text pins', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('stores a text pin and marks the owning timeline dot', () => {
    const manager = new TimelineManager() as unknown as {
      conversationId: string;
      markers: Array<{ id: string; element: HTMLElement; dotElement: HTMLButtonElement }>;
      markerMap: Map<string, { id: string; element: HTMLElement; dotElement: HTMLButtonElement }>;
      pinBadgeLayer: HTMLElement;
      navigateToTextPin: ReturnType<typeof vi.fn>;
      addTextPin: (
        pinTarget: {
          marker: { id: string; element: HTMLElement };
          xOffset: number;
          xRatio: number;
          yOffset: number;
        },
        clientX: number,
        clientY: number,
        target: HTMLElement,
      ) => void;
      pinsByTurn: Map<string, Array<{ id: string; turnId: string; yOffset: number }>>;
    };
    manager.conversationId = 'conv-1';

    const message = document.createElement('div');
    message.textContent = 'alpha beta gamma';
    message.getBoundingClientRect = () => rect(10, 20, 200, 100);
    document.body.appendChild(message);

    const dot = document.createElement('button');
    dot.className = 'timeline-dot';
    const marker = { id: 'turn-1', element: message, dotElement: dot };
    manager.markers = [marker];
    manager.markerMap = new Map([['turn-1', marker]]);
    manager.pinBadgeLayer = document.createElement('div');
    document.body.appendChild(manager.pinBadgeLayer);
    manager.navigateToTextPin = vi.fn();

    manager.addTextPin({ marker, xOffset: 100, xRatio: 0.5, yOffset: 50 }, 110, 70, message);

    expect(manager.pinsByTurn.get('turn-1')).toHaveLength(1);
    expect(manager.pinsByTurn.get('turn-1')?.[0]?.yOffset).toBe(50);
    expect(dot.classList.contains('has-pins')).toBe(true);
    expect(dot.querySelector('.timeline-dot-pin-indicator')).not.toBeNull();
    expect(localStorage.getItem('gptTimelineTextPins:conv-1')).toContain('turn-1');
  });

  it('assigns assistant text between two turns to the previous timeline dot', () => {
    const manager = new TimelineManager() as unknown as {
      conversationContainer: HTMLElement;
      scrollContainer: HTMLElement;
      markers: Array<{ id: string; element: HTMLElement; dotElement: HTMLButtonElement }>;
      markerTops: number[];
      resolveTextPinTarget: (
        target: HTMLElement,
        clientX: number,
        clientY: number,
      ) => { marker: { id: string }; yOffset: number } | null;
    };

    const container = document.createElement('div');
    container.getBoundingClientRect = () => rect(0, 0, 400, 500);
    Object.defineProperty(container, 'scrollTop', { value: 0, writable: true });

    const firstUser = document.createElement('div');
    firstUser.textContent = 'first user';
    firstUser.getBoundingClientRect = () => rect(20, 100, 120, 40);
    const assistant = document.createElement('div');
    assistant.textContent = 'assistant answer';
    assistant.getBoundingClientRect = () => rect(20, 220, 300, 80);
    const secondUser = document.createElement('div');
    secondUser.textContent = 'second user';
    secondUser.getBoundingClientRect = () => rect(20, 420, 120, 40);
    container.append(firstUser, assistant, secondUser);
    document.body.appendChild(container);

    manager.conversationContainer = container;
    manager.scrollContainer = container;
    manager.markers = [
      { id: 'turn-1', element: firstUser, dotElement: document.createElement('button') },
      { id: 'turn-2', element: secondUser, dotElement: document.createElement('button') },
    ];
    manager.markerTops = [100, 420];

    const pinTarget = manager.resolveTextPinTarget(assistant, 100, 240);

    expect(pinTarget?.marker.id).toBe('turn-1');
    expect(pinTarget?.yOffset).toBe(140);
  });

  it('steps through pins only on the active message and stops at the edges', () => {
    const manager = new TimelineManager() as unknown as {
      activeTurnId: string;
      pinsByTurn: Map<string, Array<{ id: string; turnId: string; yOffset: number }>>;
      activePinByTurn: Map<string, string>;
      markerMap: Map<string, { id: string; element: HTMLElement }>;
      markers: Array<{ id: string; element: HTMLElement; dotElement: null }>;
      pinBadgeLayer: HTMLElement;
      pinBadges: Map<string, HTMLButtonElement>;
      navigateToTextPin: ReturnType<typeof vi.fn>;
      navigateActiveMessagePin: (direction: -1 | 1) => void;
      renderTextPinBadges: () => void;
      updateActiveDotUI: () => void;
    };

    const first = document.createElement('div');
    first.getBoundingClientRect = () => rect(0, 0, 100, 100);
    const second = document.createElement('div');
    second.getBoundingClientRect = () => rect(0, 120, 100, 100);
    document.body.append(first, second);

    manager.activeTurnId = 'turn-1';
    manager.pinsByTurn = new Map([
      [
        'turn-1',
        [
          { id: 'p1', turnId: 'turn-1', yOffset: 10 },
          { id: 'p2', turnId: 'turn-1', yOffset: 40 },
        ],
      ],
      ['turn-2', [{ id: 'p3', turnId: 'turn-2', yOffset: 20 }]],
    ]);
    manager.activePinByTurn = new Map([['turn-1', 'p1']]);
    manager.markerMap = new Map([
      ['turn-1', { id: 'turn-1', element: first }],
      ['turn-2', { id: 'turn-2', element: second }],
    ]);
    manager.markers = [
      { id: 'turn-1', element: first, dotElement: null },
      { id: 'turn-2', element: second, dotElement: null },
    ];
    manager.pinBadgeLayer = document.createElement('div');
    manager.pinBadges = new Map();
    manager.renderTextPinBadges = vi.fn();
    manager.updateActiveDotUI = vi.fn();
    manager.navigateToTextPin = vi.fn();

    manager.navigateActiveMessagePin(1);

    expect(manager.activePinByTurn.get('turn-1')).toBe('p2');
    expect(manager.activePinByTurn.get('turn-2')).toBeUndefined();
    expect(manager.navigateToTextPin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p2', turnId: 'turn-1' }),
      420,
    );
    expect(manager.navigateToTextPin).toHaveBeenCalledTimes(1);

    manager.navigateActiveMessagePin(1);

    expect(manager.activePinByTurn.get('turn-1')).toBe('p2');
    expect(manager.navigateToTextPin).toHaveBeenCalledTimes(1);

    manager.navigateActiveMessagePin(-1);

    expect(manager.activePinByTurn.get('turn-1')).toBe('p1');
    expect(manager.navigateToTextPin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', turnId: 'turn-1' }),
      420,
    );
    expect(manager.navigateToTextPin).toHaveBeenCalledTimes(2);
  });

  it('selects a clicked text pin and moves pin navigation focus to its message', () => {
    const manager = new TimelineManager() as unknown as {
      activeTurnId: string;
      pinFocusTurnId: string | null;
      selectedPinId: string | null;
      pinsByTurn: Map<string, Array<{ id: string; turnId: string; yOffset: number; text: string }>>;
      activePinByTurn: Map<string, string>;
      markerMap: Map<string, { id: string; element: HTMLElement }>;
      markers: Array<{ id: string; element: HTMLElement; dotElement: null }>;
      pinBadgeLayer: HTMLElement;
      pinBadges: Map<string, HTMLButtonElement>;
      renderTextPinBadges: () => void;
      updateActiveDotUI: ReturnType<typeof vi.fn>;
    };

    const first = document.createElement('div');
    const second = document.createElement('div');
    document.body.append(first, second);

    manager.activeTurnId = 'turn-1';
    manager.pinFocusTurnId = 'turn-1';
    manager.selectedPinId = null;
    manager.pinsByTurn = new Map([
      ['turn-1', [{ id: 'p1', turnId: 'turn-1', yOffset: 10, text: 'first' }]],
      ['turn-2', [{ id: 'p2', turnId: 'turn-2', yOffset: 20, text: 'second' }]],
    ]);
    manager.activePinByTurn = new Map([['turn-1', 'p1']]);
    manager.markerMap = new Map([
      ['turn-1', { id: 'turn-1', element: first }],
      ['turn-2', { id: 'turn-2', element: second }],
    ]);
    manager.markers = [
      { id: 'turn-1', element: first, dotElement: null },
      { id: 'turn-2', element: second, dotElement: null },
    ];
    manager.pinBadgeLayer = document.createElement('div');
    document.body.appendChild(manager.pinBadgeLayer);
    manager.pinBadges = new Map();
    manager.updateActiveDotUI = vi.fn();

    manager.renderTextPinBadges();
    manager.pinBadges.get('p2')?.click();

    expect(manager.activeTurnId).toBe('turn-2');
    expect(manager.pinFocusTurnId).toBe('turn-2');
    expect(manager.selectedPinId).toBe('p2');
    expect(manager.activePinByTurn.get('turn-2')).toBe('p2');
    expect(manager.pinsByTurn.get('turn-2')).toHaveLength(1);
    expect(manager.updateActiveDotUI).toHaveBeenCalled();
  });

  it('moves pin navigation focus when a timeline dot message is selected', () => {
    const manager = new TimelineManager() as unknown as {
      pinFocusTurnId: string | null;
      selectedPinId: string | null;
      selectedPinTurnId: string | null;
      pinsByTurn: Map<string, Array<{ id: string; turnId: string; yOffset: number; text: string }>>;
      activePinByTurn: Map<string, string>;
      markerMap: Map<string, { id: string; element: HTMLElement }>;
      pinBadgeLayer: HTMLElement;
      pinBadges: Map<string, HTMLButtonElement>;
      pinDeleteButton: HTMLButtonElement;
      focusTextPinsForTurn: (turnId: string) => void;
      updatePinControlsState: ReturnType<typeof vi.fn>;
      renderTextPinBadges: () => void;
    };

    const first = document.createElement('div');
    const second = document.createElement('div');
    manager.pinFocusTurnId = 'turn-1';
    manager.selectedPinId = 'p1';
    manager.selectedPinTurnId = 'turn-1';
    manager.pinsByTurn = new Map([
      ['turn-1', [{ id: 'p1', turnId: 'turn-1', yOffset: 10, text: 'first' }]],
      ['turn-2', [{ id: 'p2', turnId: 'turn-2', yOffset: 20, text: 'second' }]],
    ]);
    manager.activePinByTurn = new Map([['turn-1', 'p1']]);
    manager.markerMap = new Map([
      ['turn-1', { id: 'turn-1', element: first }],
      ['turn-2', { id: 'turn-2', element: second }],
    ]);
    manager.pinBadgeLayer = document.createElement('div');
    manager.pinBadges = new Map();
    manager.pinDeleteButton = document.createElement('button');
    manager.updatePinControlsState = vi.fn();
    manager.renderTextPinBadges = vi.fn();

    manager.focusTextPinsForTurn('turn-2');

    expect(manager.pinFocusTurnId).toBe('turn-2');
    expect(manager.activePinByTurn.get('turn-2')).toBe('p2');
    expect(manager.selectedPinId).toBeNull();
    expect(manager.selectedPinTurnId).toBeNull();
    expect(manager.updatePinControlsState).toHaveBeenCalled();
  });
});
