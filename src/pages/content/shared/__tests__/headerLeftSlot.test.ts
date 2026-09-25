import { afterEach, describe, expect, it } from 'vitest';

import { findHeaderLeftSlot } from '../headerActionSlot';

/**
 * 2026-09 app-shell title bar: pointer-events none throughout, a start slot
 * above the sidebar that is also an `[data-app-shell-header-obstacle]`, and the
 * main title bar's own buttons in an `ms-auto` group on the right.
 */
function mountAppShellHeader(): void {
  document.body.innerHTML = `
    <header data-app-shell-titlebar="true" class="pointer-events-none" style="pointer-events: none">
      <div data-app-shell-header-slot="start" data-app-shell-header-obstacle="true"></div>
      <div data-app-shell-main-titlebar="true" class="pointer-events-none">
        <div class="ms-auto" data-app-shell-header-obstacle="true">
          <div class="pointer-events-auto">
            <button data-testid="conversation-options-button" class="Button-x">…</button>
          </div>
        </div>
      </div>
    </header>`;
}

describe('findHeaderLeftSlot on the app shell', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns a clickable wrapper at the start of the main title bar', () => {
    mountAppShellHeader();
    const slot = findHeaderLeftSlot()!;
    const titlebar = document.querySelector('[data-app-shell-main-titlebar]')!;

    expect(slot.parent.parentElement).toBe(titlebar);
    expect(titlebar.firstElementChild).toBe(slot.parent);
    expect(slot.parent.style.pointerEvents).toBe('auto');
    expect(slot.before).toBeNull();
  });

  it('reuses the same wrapper on later lookups', () => {
    mountAppShellHeader();
    const first = findHeaderLeftSlot()!.parent;
    const second = findHeaderLeftSlot()!.parent;
    expect(second).toBe(first);
    expect(document.querySelectorAll('[data-gv-header-left-slot]')).toHaveLength(1);
  });
});
