import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Minimal 2026-09 app shell: the aside stays mounted; expanded, the panel
 * header holds the "hide sidebar" button, collapsed, the rail's top button
 * opens it again. Widths follow ChatGPT's (290 expanded, 52 collapsed).
 */
function mountAppShell() {
  document.body.innerHTML = `
    <div data-app-shell-frame data-app-shell-sidebar-open="true">
      <header data-app-shell-titlebar="true">
        <div data-app-shell-header-slot="start"></div>
        <div data-app-shell-main-titlebar="true"></div>
      </header>
      <div data-app-shell-workspace-row>
        <aside class="app-shell-left-panel">
          <div><div id="app-shell-sidebar">
            <nav data-app-navigation-rail="true"></nav>
            <div class="panel"></div>
          </div></div>
        </aside>
        <div aria-hidden="true" class="PageSurface-x"></div>
      </div>
    </div>`;
  const frame = document.querySelector<HTMLElement>('[data-app-shell-frame]')!;
  const aside = document.querySelector<HTMLElement>('aside')!;
  const rail = aside.querySelector('nav')!;
  const panel = aside.querySelector('.panel')!;
  let width = 290;
  vi.spyOn(aside, 'getBoundingClientRect').mockImplementation(
    () =>
      ({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: 800, width, height: 800 }) as DOMRect,
  );

  const render = (open: boolean) => {
    width = open ? 290 : 52;
    frame.setAttribute('data-app-shell-sidebar-open', String(open));
    rail.replaceChildren();
    panel.replaceChildren();
    const toggle = document.createElement('button');
    toggle.setAttribute('aria-controls', 'app-shell-sidebar');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.addEventListener('click', () => render(!open));
    (open ? panel : rail).appendChild(toggle);
  };
  render(true);
  return { aside, isOpen: () => width > 52 };
}

function mockSettings(settings: Record<string, unknown>): void {
  (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_defaults: Record<string, unknown>, callback: (result: Record<string, unknown>) => void) =>
      callback(settings),
  );
}

describe('sidebar auto-hide on the 2026-09 app shell', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    const event = new Event('pagehide') as PageTransitionEvent;
    Object.defineProperty(event, 'persisted', { value: false });
    window.dispatchEvent(event);
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it("collapses through ChatGPT's own hide-sidebar button", async () => {
    const shell = mountAppShell();
    mockSettings({ gvSidebarAutoHide: true, gvSidebarFullHide: false });
    const { startSidebarAutoHide } = await import('../index');
    startSidebarAutoHide();

    await vi.advanceTimersByTimeAsync(600);
    expect(shell.isOpen()).toBe(false);
  });

  it('full-hide marks the sidebar, the title bar slot and the page card — not <html>', async () => {
    mountAppShell();
    mockSettings({ gvSidebarAutoHide: true, gvSidebarFullHide: true });
    const { startSidebarAutoHide } = await import('../index');
    startSidebarAutoHide();

    await vi.advanceTimersByTimeAsync(1000);
    const marked = (selector: string) =>
      document.querySelector(selector)!.hasAttribute('data-gv-sidebar-full-hide');
    expect(marked('aside')).toBe(true);
    expect(marked('[data-app-shell-header-slot="start"]')).toBe(true);
    expect(marked('.PageSurface-x')).toBe(true);
    expect(document.documentElement.className).not.toContain('gv-sidebar');
  });

  it('opens again from the left edge through the rail button', async () => {
    const shell = mountAppShell();
    mockSettings({ gvSidebarAutoHide: true, gvSidebarFullHide: true });
    const { startSidebarAutoHide } = await import('../index');
    startSidebarAutoHide();
    await vi.advanceTimersByTimeAsync(1000);
    expect(shell.isOpen()).toBe(false);

    document.getElementById('gv-sidebar-edge-trigger')!.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(200);
    expect(shell.isOpen()).toBe(true);
    expect(shell.aside.hasAttribute('data-gv-sidebar-full-hide')).toBe(false);
  });
});
