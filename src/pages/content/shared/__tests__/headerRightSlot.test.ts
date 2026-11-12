import { afterEach, describe, expect, it } from 'vitest';

import { findOptionsButtonRow } from '../headerActionSlot';

function mount() {
  document.body.innerHTML = `<header data-app-shell-titlebar>
    <div data-app-shell-header-slot="start" data-app-shell-header-obstacle></div>
    <div data-app-shell-main-titlebar style="display:flex;pointer-events:none">
      <div data-app-shell-header-toolbar><button data-testid="conversation-options-button">Title menu</button></div>
      <div data-app-shell-header-obstacle style="display:flex"><div style="display:inline"><button id="share" class="changed-native-class">Share</button></div></div>
    </div></header>`;
}
afterEach(() => document.body.replaceChildren());
describe('stable right header actions', () => {
  it('keeps its own clickable row outside inline Share wrappers and away from the title menu', () => {
    mount();
    const slot = findOptionsButtonRow()!;
    expect(slot.owned).toBe(true);
    expect(slot.styleSource).toBe(document.getElementById('share'));
    expect(slot.parent.parentElement).toBe(
      document.getElementById('share')!.parentElement!.parentElement,
    );
    expect(slot.parent.style.flexDirection).toBe('row');
    expect(slot.parent.style.flexWrap).toBe('nowrap');
    expect(slot.parent.style.pointerEvents).toBe('auto');
    expect(findOptionsButtonRow()!.parent).toBe(slot.parent);
    expect(document.querySelectorAll('[data-gv-header-actions]')).toHaveLength(1);
  });
  it('survives removal of all native buttons, and moves out of a vertical native action slot', () => {
    mount();
    const slot = findOptionsButtonRow()!;
    const nativeRight = slot.parent.parentElement!;
    document.querySelectorAll('button').forEach((button) => button.remove());
    nativeRight.style.flexDirection = 'column';
    const next = findOptionsButtonRow()!;
    expect(next.parent).toBe(slot.parent);
    expect(next.parent.parentElement).toBe(
      document.querySelector('[data-app-shell-main-titlebar]'),
    );
    expect(next.parent.style.marginInlineStart).toBe('auto');
    document.querySelector<HTMLElement>('[data-app-shell-main-titlebar]')!.style.flexDirection =
      'column';
    expect(findOptionsButtonRow()).toBeNull();
    expect(document.querySelector('[data-gv-header-actions]')).toBeNull();
  });
  it('does not inject into a vertical title bar or a hidden old header', () => {
    mount();
    document.querySelector<HTMLElement>('[data-app-shell-main-titlebar]')!.style.flexDirection =
      'column';
    expect(findOptionsButtonRow()).toBeNull();
    document.querySelector('header')!.style.display = 'none';
    expect(findOptionsButtonRow()).toBeNull();
    expect(document.querySelector('[data-gv-header-actions]')).toBeNull();
  });
});
