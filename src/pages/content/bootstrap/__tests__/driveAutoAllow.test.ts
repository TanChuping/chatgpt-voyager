import { describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import { BOOTSTRAP_SETTING_KEYS, createLazyFeatureDefinitions } from '../features';
import { LazyFeatureRuntime } from '../runtime';

describe('Drive approval opt-in loading', () => {
  it('does not load by default, starts on enable, and stops on disable', async () => {
    const feature = createLazyFeatureDefinitions({ getFolderManager: async () => null }).find(
      (entry) => entry.id === 'drive-auto-allow',
    )!;
    expect(BOOTSTRAP_SETTING_KEYS).toContain(StorageKeys.DRIVE_AUTO_ALLOW_ENABLED);
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    const load = vi.fn(async () => ({ start }));
    const runtime = new LazyFeatureRuntime({
      features: [{ ...feature, load }],
      scheduleIdle: () => ({ cancel: vi.fn() }),
    });
    const flush = async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    };
    runtime.applyInitialSettings({});
    await flush();
    expect(load).not.toHaveBeenCalled();
    runtime.updateSettings({ [StorageKeys.DRIVE_AUTO_ALLOW_ENABLED]: true });
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    runtime.updateSettings({ [StorageKeys.DRIVE_AUTO_ALLOW_ENABLED]: false });
    await flush();
    expect(stop).toHaveBeenCalledTimes(1);
    runtime.updateSettings({ [StorageKeys.DRIVE_AUTO_ALLOW_ENABLED]: true });
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
    await runtime.shutdown();
  });
});
