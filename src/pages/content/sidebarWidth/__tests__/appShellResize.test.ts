import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startSidebarWidthAdjuster, stopSidebarWidthAdjuster } from '../index';

type StorageListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
) => void;

/**
 * Minimal stand-in for ChatGPT's 2026-09 left panel: the content wrapper
 * carries the panel size inline, and the handle (rendered only while
 * expanded) resizes relative to the stored size, listening for the release
 * only after the press has re-rendered — like the real one.
 */
function mountAppShell(initialWidth: number, expanded = true, range = { min: 0, max: Infinity }) {
  document.body.innerHTML = `
    <div data-app-shell-frame>
      <aside class="app-shell-left-panel" style="width:var(--app-shell-left-panel-width)">
        <div class="max-w-full overflow-hidden"></div>
      </aside>
    </div>`;
  const aside = document.querySelector<HTMLElement>('aside')!;
  const content = aside.firstElementChild as HTMLElement;
  let size = initialWidth;
  let presses = 0;
  const setSize = (width: number) => {
    size = width;
    content.style.width = `${width}px`;
    content.style.minWidth = `${width}px`;
  };
  setSize(initialWidth);

  const expand = (restoredWidth?: number) => {
    if (restoredWidth !== undefined) setSize(restoredWidth);
    const wrapper = document.createElement('div');
    wrapper.className = 'group/panel-resizer absolute';
    const handle = document.createElement('div');
    handle.setAttribute('role', 'separator');
    handle.addEventListener('pointerdown', (down) => {
      presses += 1;
      const startX = down.clientX;
      const startSize = size;
      window.setTimeout(() => {
        const up = (event: PointerEvent) => {
          window.removeEventListener('pointerup', up);
          setSize(Math.min(range.max, Math.max(range.min, startSize + event.clientX - startX)));
        };
        window.addEventListener('pointerup', up);
      }, 0);
    });
    wrapper.appendChild(handle);
    aside.appendChild(wrapper);
  };
  if (expanded) expand();

  return { expand, width: () => size, presses: () => presses };
}

const settle = async (ms = 400) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe('sidebar width on the 2026-09 app shell', () => {
  let stored: Record<string, unknown>;
  let storageListeners: StorageListener[];

  beforeEach(() => {
    vi.useFakeTimers();
    stored = { gptSidebarWidth: 279 };
    storageListeners = [];
    vi.mocked(chrome.storage.sync.get).mockImplementation(((
      _keys: unknown,
      callback: (items: Record<string, unknown>) => void,
    ) => callback({ ...stored })) as never);
    vi.mocked(chrome.storage.sync.set).mockImplementation(((items: Record<string, unknown>) => {
      stored = { ...stored, ...items };
    }) as never);
    vi.mocked(chrome.storage.onChanged.addListener).mockImplementation(((
      listener: StorageListener,
    ) => storageListeners.push(listener)) as never);
  });

  afterEach(() => {
    stopSidebarWidthAdjuster();
    vi.useRealTimers();
    document.body.innerHTML = '';
    vi.mocked(chrome.storage.sync.get).mockReset();
    vi.mocked(chrome.storage.sync.set).mockReset();
    vi.mocked(chrome.storage.onChanged.addListener).mockReset();
  });

  it('applies the stored width through the native handle, not a CSS override', async () => {
    const shell = mountAppShell(414);
    startSidebarWidthAdjuster();
    await settle();

    expect(shell.width()).toBe(279);
    const style = document.getElementById('gv-sidebar-width-style')?.textContent ?? '';
    expect(style).not.toContain('app-shell');
    expect(style).not.toContain('aside');
  });

  it('follows popup changes', async () => {
    const shell = mountAppShell(414);
    startSidebarWidthAdjuster();
    await settle();

    storageListeners.forEach((listener) =>
      listener({ gptSidebarWidth: { oldValue: 279, newValue: 360 } }, 'sync'),
    );
    await settle();
    expect(shell.width()).toBe(360);
  });

  it('waits for a collapsed panel to expand before resizing it', async () => {
    const shell = mountAppShell(52, false);
    startSidebarWidthAdjuster();
    await settle();
    expect(shell.width()).toBe(52);

    // Expanding restores ChatGPT's own stored size first.
    shell.expand(414);
    await settle();
    expect(shell.width()).toBe(279);
  });

  it("stops at ChatGPT's own limit instead of retrying", async () => {
    const shell = mountAppShell(414, true, { min: 290, max: 520 });
    startSidebarWidthAdjuster();
    await settle();

    expect(shell.width()).toBe(290);
    expect(shell.presses()).toBe(2);

    await settle(1000);
    expect(shell.presses()).toBe(2);
  });

  it('never writes its own replayed drag back to the setting', async () => {
    mountAppShell(414);
    startSidebarWidthAdjuster();
    await settle();
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });
});
