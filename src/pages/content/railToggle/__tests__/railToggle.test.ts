import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startRailToggle, stopRailToggle } from '../index';

const BUTTON = '[data-gv-rail-toggle]';

function mountAppShell(): void {
  document.body.innerHTML = `
    <div data-app-shell-frame>
      <header data-app-shell-titlebar="true">
        <div data-app-shell-header-slot="start" style="width: var(--app-shell-left-panel-width)"></div>
        <div data-app-shell-main-titlebar="true"></div>
      </header>
      <div data-app-shell-workspace-row>
        <aside class="app-shell-left-panel">
          <div style="width: 290px">
            <div id="app-shell-sidebar">
              <div class="flex">
                <nav data-app-navigation-rail="true"><div><div><button>home</button></div></div></nav>
                <div class="panel">
                  <div class="header">
                    <span class="title">ChatGPT</span>
                    <div class="row">
                      <span style="display: contents"><button aria-label="Search" class="search">s</button></span>
                      <span style="display: contents">
                        <button class="Button-x" data-size="xl" data-icon-size="lg"
                          aria-controls="app-shell-sidebar" aria-expanded="true" aria-label="Hide sidebar">
                          <span class="inner"><svg></svg></span>
                        </button>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div><div role="separator"></div></div>
        </aside>
        <div class="Workspace-x"></div>
        <div aria-hidden="true" class="PageSurface-x"></div>
      </div>
    </div>`;
}

describe('icon rail toggle', () => {
  let stored: Record<string, unknown>;

  beforeEach(() => {
    vi.useFakeTimers();
    // A wide window: ChatGPT's side-by-side layout (the global mock matches nothing).
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('min-width'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    stored = {};
    vi.mocked(chrome.storage.local.get).mockImplementation(((
      _keys: unknown,
      callback: (items: Record<string, unknown>) => void,
    ) => callback({ ...stored })) as never);
    vi.mocked(chrome.storage.local.set).mockImplementation(((items: Record<string, unknown>) => {
      stored = { ...stored, ...items };
    }) as never);
    mountAppShell();
  });

  afterEach(() => {
    stopRailToggle();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
    vi.mocked(chrome.storage.local.get).mockReset();
    vi.mocked(chrome.storage.local.set).mockReset();
  });

  it('adds a compact button before search in the sidebar header row', () => {
    startRailToggle();
    const button = document.querySelector<HTMLButtonElement>(BUTTON)!;
    const row = document.querySelector('.row')!;
    expect(row.firstElementChild).toBe(button);
    expect(button.getAttribute('data-size')).toBe('xs');
    expect(button.hasAttribute('aria-controls')).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Hide the icon rail');
    expect(button.querySelector('.gv-rail-toggle-icon')).not.toBeNull();
  });

  it('folds and unfolds the rail, remembering the choice', () => {
    startRailToggle();
    const rail = document.querySelector('nav[data-app-navigation-rail]')!;
    const button = () => document.querySelector<HTMLButtonElement>(BUTTON)!;
    button().click();
    expect(rail.hasAttribute('data-gv-rail-folded')).toBe(true);
    expect(button().hasAttribute('data-gv-rail-folded')).toBe(true);
    expect(stored.gvRailCollapsed).toBe(true);
    expect(button().getAttribute('aria-label')).toBe('Show the icon rail');

    button().click();
    expect(rail.hasAttribute('data-gv-rail-folded')).toBe(false);
    expect(stored.gvRailCollapsed).toBe(false);
  });

  it('keeps its state off <html>, so toggling never restyles the whole page', () => {
    startRailToggle();
    document.querySelector<HTMLButtonElement>(BUTTON)!.click();
    const rootAttrs = [...document.documentElement.attributes].map((attr) => attr.name);
    expect(rootAttrs.filter((name) => name.startsWith('data-gv-rail'))).toEqual([]);
    expect(document.getElementById('gv-rail-toggle-style')!.textContent).not.toContain(':has(');
  });

  it('keeps the panel width and hands the rail space to the thread', () => {
    startRailToggle();
    document.querySelector<HTMLButtonElement>(BUTTON)!.click();
    const aside = document.querySelector('aside')!;
    const folded = (el: Element) => el.hasAttribute('data-gv-rail-folded');
    expect(folded(aside)).toBe(true);
    expect(folded(aside.firstElementChild!)).toBe(true);
    expect(folded(document.querySelector('[data-app-shell-header-slot="start"]')!)).toBe(true);
    expect(folded(document.querySelector('.PageSurface-x')!)).toBe(true);
    // The resize handle's wrapper is never touched.
    expect(folded(aside.lastElementChild!)).toBe(false);
    expect(document.getElementById('gv-rail-toggle-style')!.textContent).toContain(
      'calc(var(--app-shell-left-panel-width) - var(--app-shell-navigation-rail-width, 52px))',
    );
  });

  it("doesn't fold below 768px, where ChatGPT's sidebar is an overlay", () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: !query.includes('min-width'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    startRailToggle();
    document.querySelector<HTMLButtonElement>(BUTTON)!.click();
    expect(document.querySelector('[data-gv-rail-folded]:not([data-gv-rail-toggle])')).toBeNull();
  });

  it('restores a saved fold at start', () => {
    stored = { gvRailCollapsed: true };
    startRailToggle();
    expect(
      document.querySelector('nav[data-app-navigation-rail]')!.hasAttribute('data-gv-rail-folded'),
    ).toBe(true);
  });

  it('gives the rail back when the panel collapses', async () => {
    stored = { gvRailCollapsed: true };
    startRailToggle();
    const rail = document.querySelector('nav[data-app-navigation-rail]')!;
    expect(rail.hasAttribute('data-gv-rail-folded')).toBe(true);

    document.querySelector('[role="separator"]')!.parentElement!.remove();
    await vi.advanceTimersByTimeAsync(0);
    expect(rail.hasAttribute('data-gv-rail-folded')).toBe(false);
  });

  it('never folds while our button is missing from the panel', async () => {
    stored = { gvRailCollapsed: true };
    startRailToggle();
    const rail = document.querySelector('nav[data-app-navigation-rail]')!;
    // Say a ChatGPT update drops the anchor we place the button next to.
    document.querySelector('[aria-controls="app-shell-sidebar"]')!.remove();
    document.querySelector(BUTTON)!.remove();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(BUTTON)).toBeNull();
    expect(rail.hasAttribute('data-gv-rail-folded')).toBe(false);
  });

  it("never lands in the collapsed rail beside ChatGPT's show-sidebar button", async () => {
    // Collapsed: no panel header; the rail's top button opens the sidebar.
    document.body.innerHTML = `
      <aside class="app-shell-left-panel">
        <div><div id="app-shell-sidebar"><div class="flex">
          <nav data-app-navigation-rail="true"><div class="top">
            <span style="display: contents">
              <button aria-controls="app-shell-sidebar" aria-expanded="false">show</button>
            </span>
          </div></nav>
        </div></div></div>
      </aside>`;
    startRailToggle();
    await vi.advanceTimersByTimeAsync(200);
    expect(document.querySelector(BUTTON)).toBeNull();

    // A button left in the rail by an older build is cleaned up.
    const stray = document.createElement('button');
    stray.setAttribute('data-gv-rail-toggle', '');
    document.querySelector('.top')!.prepend(stray);
    await vi.advanceTimersByTimeAsync(200);
    expect(document.querySelector(BUTTON)).toBeNull();
  });

  it('re-adds the button when ChatGPT re-renders the header', async () => {
    startRailToggle();
    document.querySelector(BUTTON)!.remove();
    await vi.advanceTimersByTimeAsync(200);
    expect(document.querySelector('.row')!.firstElementChild?.matches(BUTTON)).toBe(true);
  });

  it('stopping removes the button and brings the rail back', () => {
    startRailToggle();
    document.querySelector<HTMLButtonElement>(BUTTON)!.click();
    stopRailToggle();
    expect(document.querySelector(BUTTON)).toBeNull();
    expect(document.getElementById('gv-rail-toggle-style')).toBeNull();
    expect(document.querySelector('[data-gv-rail-folded]')).toBeNull();
  });
});
