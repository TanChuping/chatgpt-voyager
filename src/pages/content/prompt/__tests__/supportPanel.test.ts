import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSupportPanel } from '../index';

vi.mock('@/core/services/mysteryCardFeed', () => ({
  CARD_REFRESH_MS: 300000,
  loadMysteryCard: async () => ({
    v: 1,
    enabled: true,
    align: 'start',
    gap: 'normal',
    colors: {},
    rows: [{ weights: [1], columns: [[{ type: 'text', text: 'test' }]] }],
  }),
}));

afterEach(() => {
  document.querySelector('.gv-pm-support-wrap')?.dispatchEvent(new Event('gv-pm-close'));
  document.body.replaceChildren();
});

describe('support popover portal', () => {
  it('escapes the containing panel and closes even when pinned', async () => {
    const i18n = { t: () => 'Support', get: async () => 'en' };
    const wrap = createSupportPanel(i18n as Parameters<typeof createSupportPanel>[0]);
    const panel = document.createElement('div');
    panel.style.contain = 'layout paint style';
    panel.style.overflow = 'hidden';
    panel.append(wrap);
    document.body.append(panel);
    const button = wrap.querySelector('button')!;
    const popover = document.querySelector('.gv-pm-support-popover')!;
    expect(popover.parentElement).toBe(document.body);
    button.click();
    await vi.waitFor(() => expect(popover.querySelector('.gv-mystery-card')).not.toBeNull());
    expect(popover.classList.contains('gv-hidden')).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    wrap.dispatchEvent(new Event('gv-pm-close'));
    expect(popover.classList.contains('gv-hidden')).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });
});
