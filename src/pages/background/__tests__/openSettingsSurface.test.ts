import { describe, expect, it, vi } from 'vitest';

import { createSettingsSurfaceOpener } from '../openSettingsSurface';

describe('settings surface opener', () => {
  it('uses the anchored action popup when the browser allows it', async () => {
    const openActionPopup = vi.fn().mockResolvedValue(undefined);
    const openWindow = vi.fn();
    const openSettings = createSettingsSurfaceOpener({
      focusWindow: vi.fn(),
      getSettingsUrl: () => 'chrome-extension://id/popup.html',
      openActionPopup,
      openWindow,
    });

    await expect(openSettings()).resolves.toEqual({ ok: true, mode: 'action-popup' });
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('opens and later refocuses a popup window when action.openPopup is rejected', async () => {
    const focusWindow = vi.fn().mockResolvedValue(undefined);
    const openWindow = vi.fn().mockResolvedValue({ id: 42 });
    const openSettings = createSettingsSurfaceOpener({
      focusWindow,
      getSettingsUrl: () => 'chrome-extension://id/popup.html',
      openActionPopup: vi.fn().mockRejectedValue(new Error('user gesture required')),
      openWindow,
    });

    await expect(openSettings()).resolves.toEqual({ ok: true, mode: 'window' });
    await expect(openSettings()).resolves.toEqual({ ok: true, mode: 'window' });
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(focusWindow).toHaveBeenCalledWith(42);
  });

  it('reports an error only when both browser surfaces fail', async () => {
    const openSettings = createSettingsSurfaceOpener({
      focusWindow: vi.fn(),
      getSettingsUrl: () => 'chrome-extension://id/popup.html',
      openActionPopup: vi.fn().mockRejectedValue(new Error('popup denied')),
      openWindow: vi.fn().mockRejectedValue(new Error('window denied')),
    });

    await expect(openSettings()).resolves.toEqual({
      ok: false,
      error: 'popup denied; fallback: window denied',
    });
  });
});
