import { afterEach, describe, expect, it, vi } from 'vitest';

import { startTopBarAnnouncementButton, stopTopBarAnnouncementButton } from '../topBarButton';

afterEach(() => {
  stopTopBarAnnouncementButton();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('announcement menu fallback', () => {
  it('works in the title menu even without a usable header action row, and is inserted once', async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<header><button id="title-menu" data-testid="conversation-options-button" aria-haspopup="menu" aria-expanded="true" aria-controls="native-menu">Title</button></header>';
    const onClick = vi.fn();
    startTopBarAnnouncementButton({ label: 'Announcements', onClick });
    const menu = document.createElement('div');
    menu.id = 'native-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-labelledby', 'title-menu');
    menu.innerHTML =
      '<div role="menuitem"><div data-menu-row-content><span data-leading-icon-slot="menu"></span><span class="truncate">Rename</span></div></div>';
    document.body.appendChild(menu);
    await vi.advanceTimersByTimeAsync(1);
    const item = menu.querySelector<HTMLElement>('.gv-announcement-menu-btn')!;
    expect(item.textContent).toBe('Announcements');
    menu.appendChild(document.createElement('span'));
    await vi.advanceTimersByTimeAsync(1);
    expect(menu.querySelectorAll('.gv-announcement-menu-btn')).toHaveLength(1);
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    expect(onClick).toHaveBeenCalledOnce();
    stopTopBarAnnouncementButton();
    expect(menu.querySelector('.gv-announcement-menu-btn')).toBeNull();
  });
});
