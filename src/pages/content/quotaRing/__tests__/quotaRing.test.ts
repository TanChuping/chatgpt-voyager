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
  vi.setSystemTime(new Date(2026, 10, 7, 12));
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
  it('retires the Chat note at local midnight on December 1, including an open panel', async () => {
    vi.setSystemTime(new Date(2026, 10, 30, 23, 59, 59));
    startQuotaRing();
    const ring = document.querySelector<HTMLElement>('form .gv-quota-ring')!;
    ring.dispatchEvent(new FocusEvent('focus'));
    const panel = document.getElementById('gv-quota-panel')!;
    expect(panel.querySelector('.gv-quota-note')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(panel.hasAttribute('data-open')).toBe(true);
    expect(panel.querySelector('.gv-quota-note')).toBeNull();
    vi.setSystemTime(new Date(2027, 0, 1));
    ring.dispatchEvent(new FocusEvent('focus'));
    expect(panel.querySelector('.gv-quota-note')).toBeNull();
  });

  it('reads a late native ring only on its changes, hides it after success, and restores it on stop', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    startQuotaRing();
    const nativeRequests = () =>
      post.mock.calls.filter(([data]) => data.__gvType === 'gv-quota-native').length;
    await vi.advanceTimersByTimeAsync(500);
    expect(nativeRequests()).toBe(0);
    const native = document.createElement('button');
    native.setAttribute('aria-description', '39% left');
    native.innerHTML = '<svg><use href="/icons.svg#codex-icon-usage-fill-regular-12"></use></svg>';
    document.querySelector('.footer')!.prepend(native);
    await vi.advanceTimersByTimeAsync(100);
    expect(nativeRequests()).toBe(1);
    expect(native.classList.contains('gv-quota-native-replaced')).toBe(false);
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: location.origin,
        data: { ...message().data, nativeReady: true },
      }),
    );
    expect(native.classList.contains('gv-quota-native-replaced')).toBe(true);
    native.style.opacity = '0.8';
    await vi.advanceTimersByTimeAsync(60_000);
    expect(nativeRequests()).toBe(1);
    native.setAttribute('aria-description', '38% left');
    await vi.advanceTimersByTimeAsync(100);
    expect(nativeRequests()).toBe(2);
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: location.origin,
        data: { ...message().data, nativeReady: false },
      }),
    );
    expect(native.classList.contains('gv-quota-native-replaced')).toBe(false);
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: location.origin,
        data: { ...message().data, nativeReady: true },
      }),
    );
    stopQuotaRing();
    expect(native.classList.contains('gv-quota-native-replaced')).toBe(false);
    native.setAttribute('aria-description', '37% left');
    await vi.advanceTimersByTimeAsync(100);
    expect(nativeRequests()).toBe(2);
  });
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

  it('escapes inline tooltip wrappers and repositions after in-place layout changes', async () => {
    const span = document.querySelector<HTMLElement>('.row > span')!;
    span.style.display = 'inline';
    const wrapper = document.createElement('div');
    span.before(wrapper);
    wrapper.appendChild(span);
    startQuotaRing();
    const ring = document.querySelector('form .gv-quota-ring')!;
    expect(ring.parentElement).toBe(document.querySelector('.row'));
    expect(ring.nextElementSibling).toBe(wrapper);
    wrapper.style.display = 'flex';
    await vi.advanceTimersByTimeAsync(100);
    expect(ring.parentElement).toBe(wrapper);
    wrapper.style.flexDirection = 'column';
    await vi.advanceTimersByTimeAsync(100);
    expect(ring.parentElement).toBe(document.querySelector('.row'));
    expect(document.querySelectorAll('form .gv-quota-ring')).toHaveLength(1);
  });

  it('does not add a line to an unknown layout, and recovers when a row returns', async () => {
    const row = document.querySelector<HTMLElement>('.row')!;
    row.style.display = 'block';
    startQuotaRing();
    expect(document.querySelector('form .gv-quota-ring')).toBeNull();
    row.style.display = 'flex';
    await vi.advanceTimersByTimeAsync(100);
    expect(document.querySelector('form .gv-quota-ring')?.parentElement).toBe(row);
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
