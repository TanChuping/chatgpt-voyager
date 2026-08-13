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
    const event = new Event('pagehide') as PageTransitionEvent;
    Object.defineProperty(event, 'persisted', { value: false });
    window.dispatchEvent(event);
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

  it('reinitializes a blank bar after a live user turn appears', async () => {
    const managerModule = await import('../manager');
    vi.spyOn(managerModule.TimelineManager.prototype, 'destroy').mockImplementation(() => {});
    const initSpy = vi
      .spyOn(managerModule.TimelineManager.prototype, 'init')
      .mockImplementation(async () => {
        if (!document.querySelector('.gpt-timeline-bar')) {
          const bar = document.createElement('div');
          bar.className = 'gpt-timeline-bar';
          document.body.appendChild(bar);
        }
      });
    const { startTimeline } = await import('../index');

    startTimeline();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(initSpy).toHaveBeenCalledTimes(1);

    const userTurn = document.createElement('section');
    userTurn.dataset.testid = 'conversation-turn-0';
    userTurn.dataset.turn = 'user';
    document.querySelector('main')!.appendChild(userTurn);

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(initSpy).toHaveBeenCalledTimes(2);
  });

  it('stays mounted when beforeunload fires without a confirmed page exit', async () => {
    const managerModule = await import('../manager');
    const destroySpy = vi
      .spyOn(managerModule.TimelineManager.prototype, 'destroy')
      .mockImplementation(() => {});
    vi.spyOn(managerModule.TimelineManager.prototype, 'init').mockImplementation(async () => {
      const bar = document.createElement('div');
      bar.className = 'gpt-timeline-bar';
      document.body.appendChild(bar);
    });
    const { startTimeline } = await import('../index');

    startTimeline();
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.dispatchEvent(new Event('beforeunload'));

    expect(document.querySelector('.gpt-timeline-bar')).not.toBeNull();
    expect(destroySpy).not.toHaveBeenCalled();
  });
});
