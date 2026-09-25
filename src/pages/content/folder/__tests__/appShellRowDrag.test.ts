import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { trackAppShellRowDrag } from '../appShellRowDrag';

// jsdom has neither DataTransfer / DragEvent nor elementFromPoint.
class FakeDataTransfer {
  private data = new Map<string, string>();
  effectAllowed = 'all';
  dropEffect = 'none';
  get types(): string[] {
    return [...this.data.keys()];
  }
  setData(type: string, value: string): void {
    this.data.set(type, value);
  }
  getData(type: string): string {
    return this.data.get(type) ?? '';
  }
}

class FakeDragEvent extends MouseEvent {
  readonly dataTransfer: DataTransfer | null;
  constructor(type: string, init: DragEventInit = {}) {
    super(type, init);
    this.dataTransfer = init.dataTransfer ?? null;
  }
}

const pointer = (type: string, x: number, y: number, buttons = 1) =>
  new PointerEvent(type, {
    bubbles: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
  });

describe('app-shell sidebar row drag bridge', () => {
  let panel: HTMLElement;
  let folder: HTMLElement;
  let outside: HTMLElement;
  let under: Element | null;
  let events: string[];
  let payloads: string[];

  beforeEach(() => {
    vi.stubGlobal('DataTransfer', FakeDataTransfer);
    vi.stubGlobal('DragEvent', FakeDragEvent);
    document.body.innerHTML = `
      <div id="panel"><div class="folder"><span class="name">Work</span></div></div>
      <div id="outside"></div>`;
    panel = document.getElementById('panel')!;
    folder = panel.querySelector('.folder')!;
    outside = document.getElementById('outside')!;
    under = outside;
    document.elementFromPoint = vi.fn(() => under);
    events = [];
    payloads = [];
    for (const type of ['dragover', 'dragleave', 'drop']) {
      folder.addEventListener(type, (event) => {
        events.push(type);
        payloads.push((event as DragEvent).dataTransfer?.getData('application/json') ?? '');
      });
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  const start = () => {
    const begin = vi.fn(() => JSON.stringify({ type: 'conversation', conversationId: 'c1' }));
    const end = vi.fn();
    const cancel = trackAppShellRowDrag(pointer('pointerdown', 10, 10), {
      getDropRoot: () => panel,
      begin,
      end,
    });
    return { begin, end, cancel };
  };

  it('replays the pointer drag as dragover + drop on the folder under the pointer', () => {
    const { begin, end } = start();
    document.dispatchEvent(pointer('pointermove', 12, 30));
    expect(begin).toHaveBeenCalledTimes(1);

    under = folder.querySelector('.name');
    document.dispatchEvent(pointer('pointermove', 20, 60));
    document.dispatchEvent(pointer('pointerup', 20, 60, 0));

    expect(events).toEqual(['dragover', 'drop']);
    expect(JSON.parse(payloads[1])).toEqual({ type: 'conversation', conversationId: 'c1' });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a plain click', () => {
    const { begin, end } = start();
    document.dispatchEvent(pointer('pointermove', 11, 11));
    document.dispatchEvent(pointer('pointerup', 11, 11, 0));
    expect(begin).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });

  it('leaves the folder without dropping when released elsewhere', () => {
    const { end } = start();
    under = folder;
    document.dispatchEvent(pointer('pointermove', 20, 60));
    under = outside;
    document.dispatchEvent(pointer('pointermove', 300, 60));
    document.dispatchEvent(pointer('pointerup', 300, 60, 0));
    expect(events).toEqual(['dragover', 'dragleave']);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('ends without dropping when the release was missed', () => {
    const { end } = start();
    under = folder;
    document.dispatchEvent(pointer('pointermove', 20, 60));
    document.dispatchEvent(pointer('pointermove', 22, 62, 0));
    expect(events).toEqual(['dragover', 'dragleave']);
    expect(end).toHaveBeenCalledTimes(1);

    document.dispatchEvent(pointer('pointerup', 22, 62, 0));
    expect(events).not.toContain('drop');
  });

  it('cancelling mid-drag restores state and stops listening', () => {
    const { end, cancel } = start();
    under = folder;
    document.dispatchEvent(pointer('pointermove', 20, 60));
    cancel();
    expect(end).toHaveBeenCalledTimes(1);
    document.dispatchEvent(pointer('pointerup', 20, 60, 0));
    expect(events).not.toContain('drop');
  });
});
