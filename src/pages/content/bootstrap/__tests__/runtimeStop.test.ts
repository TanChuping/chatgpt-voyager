import { describe, expect, it, vi } from 'vitest';

import { LazyFeatureRuntime } from '../runtime';

async function settleRuntime(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('LazyFeatureRuntime stop failures', () => {
  it('keeps a failed cleanup registered and retries it instead of duplicating the feature', async () => {
    let stopAttempts = 0;
    const cleanup = vi.fn(async () => {
      stopAttempts += 1;
      if (stopAttempts === 1) throw new Error('unsafe to detach');
    });
    const start = vi.fn(() => cleanup);
    const onError = vi.fn();
    const runtime = new LazyFeatureRuntime({
      features: [
        {
          id: 'feature',
          initial: 'immediate',
          isEnabled: (settings) => settings.enabled === true,
          load: async () => ({ start }),
        },
      ],
      scheduleIdle: (callback) => {
        callback();
        return { cancel: vi.fn() };
      },
      onError,
    });

    runtime.applyInitialSettings({ enabled: true });
    await settleRuntime();
    expect(start).toHaveBeenCalledTimes(1);

    runtime.updateSettings({ enabled: false });
    await settleRuntime();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    runtime.updateSettings({ enabled: true });
    await settleRuntime();
    expect(start).toHaveBeenCalledTimes(1);

    runtime.updateSettings({ enabled: false });
    await settleRuntime();
    expect(cleanup).toHaveBeenCalledTimes(2);

    runtime.updateSettings({ enabled: true });
    await settleRuntime();
    expect(start).toHaveBeenCalledTimes(2);
    await runtime.shutdown();
  });
});
