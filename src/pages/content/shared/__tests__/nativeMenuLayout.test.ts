import { describe, expect, it } from 'vitest';

import { cloneAppShellMenuItem } from '../nativeMenuItemTemplate';

describe('native menu layout changes', () => {
  it('uses the November semantic icon slot and preserves the nested horizontal row', () => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `<div role="menuitem" class="native flex flex-col"><div data-menu-row-content style="display:flex">
      <span class="flex-1 truncate"><span class="flex"><span data-leading-icon-slot="menu"><span>native mask</span></span><span class="truncate">Rename</span></span></span>
    </div></div>`;
    const item = cloneAppShellMenuItem(menu, {
      className: 'test-action',
      label: 'Export',
      icon: document.createElement('svg'),
    })!;
    expect(item.querySelector('[data-menu-row-content]')).not.toBeNull();
    expect(item.querySelector('[data-leading-icon-slot]')?.firstElementChild?.tagName).toBe('SVG');
    expect(item.querySelector('[data-gv-menu-label]')?.textContent).toBe('Export');
    expect(item.textContent).not.toContain('Rename');
  });
  it('uses a stable horizontal fallback when native classes and inner wrappers are unknown', () => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.innerHTML =
      '<div role="menuitem" class="unknown flex-col absolute"><div>Rename</div></div>';
    const item = cloneAppShellMenuItem(menu, {
      className: 'test-action',
      label: 'Export',
      icon: document.createElement('svg'),
    })!;
    expect(item.style.flexDirection).toBe('row');
    expect(item.style.flexWrap).toBe('nowrap');
    expect(item.className).toBe('test-action');
    expect(item.querySelector('[data-gv-menu-label]')?.textContent).toBe('Export');
  });
});
