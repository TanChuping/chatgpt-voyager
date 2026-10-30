import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSupportPanel } from '../index';

vi.mock('@/core/services/SupportGoalService', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/core/services/SupportGoalService')>();
  const goal = { ...original.DEFAULT_SUPPORT_GOAL, enabled: true };
  return { ...original, DEFAULT_SUPPORT_GOAL: goal, loadSupportGoal: vi.fn(async () => goal) };
});

afterEach(() => {
  document.querySelector('.gv-pm-support-wrap')?.dispatchEvent(new Event('gv-pm-close'));
  document.body.replaceChildren();
});

describe('support popover portal', () => {
  it('escapes the containing panel and closes even when pinned', () => {
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
    expect(popover.classList.contains('gv-hidden')).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    wrap.dispatchEvent(new Event('gv-pm-close'));
    expect(popover.classList.contains('gv-hidden')).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });
});
