import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Timeline bootstrap', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();

    document.body.innerHTML = '<main></main>';

    // A ChatGPT conversation route (`/c/<id>`) — the only path `startTimeline`
    // mounts the timeline on.
    history.replaceState({}, '', '/c/test-conversation');
  });

  afterEach(() => {
    window.dispatchEvent(new Event('beforeunload'));
  });

  it('startTimeline initializes only once when body already exists', async () => {
    const managerModule = await import('../manager');
    const initSpy = vi
      .spyOn(managerModule.TimelineManager.prototype, 'init')
      .mockResolvedValue(undefined);
    const { startTimeline } = await import('../index');

    // `startTimeline` resolves the enable setting first and only mounts the
    // timeline inside `loadTimelineEnabled().finally()`, so init is dispatched
    // on a later microtask. Flush the task queue before asserting.
    const flushTasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    startTimeline();
    await flushTasks();
    expect(initSpy).toHaveBeenCalledTimes(1);

    // Trigger DOM mutations; should not re-initialize
    document.body.appendChild(document.createElement('div'));
    await flushTasks();

    expect(initSpy).toHaveBeenCalledTimes(1);
  });
});
