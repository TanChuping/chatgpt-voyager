import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ringRemaining } from '../data';
import { startQuotaRing, stopQuotaRing } from '../index';

function mount(): void {
  document.body.innerHTML = `
    <nav data-app-navigation-rail><div class="icons"></div><div class="footer"><button aria-haspopup="menu">avatar</button></div></nav>
    <form data-chatgpt-composer><div class="row" style="display:flex;align-items:center"><span style="display:contents"><button data-composer-navigation-target="reasoning">model</button></span></div></form>`;
}
const message = () =>
  new MessageEvent('message', {
    origin: location.origin,
    data: {
      __gvType: 'gv-quota-state',
      epoch: 1,
      failed: false,
      snapshot: {
        capturedAt: Date.now(),
        credits: '0',
        unlimitedCredits: false,
        windows: [
          {
            id: 'general:primary',
            group: 'general',
            name: '',
            remaining: 94,
            seconds: 604800,
            resetAt: 1791580383,
          },
        ],
      },
    },
  });

beforeEach(() => {
  vi.useFakeTimers();
  mount();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  stopQuotaRing();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('quota ring UI', () => {
  it('mounts outside the model animation block in the October composer', () => {
    const span = document.querySelector<HTMLElement>('.row > span')!;
    const animation = document.createElement('div');
    animation.style.transform = 'none';
    span.before(animation);
    animation.appendChild(span);
    startQuotaRing();
    const ring = document.querySelector('form .gv-quota-ring')!;
    expect(ring.parentElement).toBe(document.querySelector('.row'));
    expect(ring.nextElementSibling).toBe(animation);
    expect(animation.children.length).toBe(1);
  });

  it('moves the existing ring when the model moves to another toolbar row', async () => {
    startQuotaRing();
    const ring = document.querySelector('form .gv-quota-ring')!;
    const span = document.querySelector<HTMLElement>('.row > span')!;
    const animation = document.createElement('div');
    const row = document.createElement('div');
    row.style.display = 'flex';
    document.querySelector('form')!.appendChild(row);
    row.appendChild(animation);
    animation.appendChild(span);
    await vi.advanceTimersByTimeAsync(100);
    expect(ring.parentElement).toBe(row);
    expect(ring.nextElementSibling).toBe(animation);
    expect(document.querySelectorAll('form .gv-quota-ring')).toHaveLength(1);
  });

  it('mounts beside the model and above the avatar, with a Chat-only parenthetical note', async () => {
    startQuotaRing();
    window.dispatchEvent(message());
    const ring = document.querySelector<HTMLButtonElement>('form .gv-quota-ring')!;
    expect(document.querySelector('.row')!.firstElementChild).toBe(ring);
    expect(document.querySelector('.footer')!.previousElementSibling?.className).toBe(
      'gv-quota-sidebar-slot',
    );
    ring.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(110);
    const panel = document.getElementById('gv-quota-panel')!;
    expect(panel.hasAttribute('data-open')).toBe(true);
    expect(panel.textContent).toContain('94%');
    expect(panel.textContent).toContain('(Chat conversations do not consume this quota)');
    document
      .querySelector('form')!
      .insertAdjacentHTML(
        'beforeend',
        '<button data-composer-navigation-target="plugins">plugins</button>',
      );
    ring.dispatchEvent(new FocusEvent('focus'));
    expect(panel.textContent).not.toContain('Chat conversations');
  });

  it('lets the pointer enter the panel, and removes all UI when stopped', async () => {
    startQuotaRing();
    document.querySelector<HTMLElement>('.gv-quota-ring')!.dispatchEvent(new FocusEvent('focus'));
    document
      .querySelector<HTMLElement>('.gv-quota-ring')!
      .dispatchEvent(new MouseEvent('mouseleave'));
    const panel = document.getElementById('gv-quota-panel')!;
    panel.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(300);
    expect(panel.hasAttribute('data-open')).toBe(true);
    stopQuotaRing();
    expect(
      document.querySelector(
        '.gv-quota-ring,.gv-quota-sidebar-slot,#gv-quota-panel,#gv-quota-style',
      ),
    ).toBeNull();
  });

  it('uses only the tightest general window, rather than a separate code-review quota', () => {
    expect(
      ringRemaining({
        capturedAt: Date.now(),
        credits: null,
        unlimitedCredits: false,
        windows: [
          { id: 'g', group: 'general', name: '', remaining: 94, seconds: 604800, resetAt: null },
          { id: 'r', group: 'review', name: '', remaining: 0, seconds: 604800, resetAt: null },
        ],
      }),
    ).toBe(94);
    expect(ringRemaining(null)).toBeNull();
  });
});
