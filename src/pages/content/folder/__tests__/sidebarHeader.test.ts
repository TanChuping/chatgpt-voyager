import { describe, expect, it } from 'vitest';

import { findAppShellSidebarHeader } from '../../chatgptDom';

describe('folder panel mount in the sidebar', () => {
  const scroll = '<div data-app-action-sidebar-scroll></div>';
  it.each([scroll, `<div><div></div>${scroll}</div>`])(
    'uses the pinned header outside the scroll area (%s)',
    (area) => {
      const nav = document.createElement('nav');
      nav.innerHTML = `<header></header>${area}`;
      expect(findAppShellSidebarHeader(nav)).toBe(nav.firstElementChild);
    },
  );

  it('leaves a headerless sidebar in normal scroll flow', () => {
    const nav = document.createElement('nav');
    nav.innerHTML = `<div><div></div>${scroll}</div>`;
    expect(findAppShellSidebarHeader(nav)).toBeNull();
  });
});
