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

  it('refreshes the current manager when a live turn appears instead of restarting it', async () => {
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
    const refreshSpy = vi
      .spyOn(managerModule.TimelineManager.prototype, 'refreshForThreadChange')
      .mockImplementation(() => {});
    const { startTimeline } = await import('../index');

    startTimeline();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(initSpy).toHaveBeenCalledTimes(1);
    refreshSpy.mockClear();

    const userTurn = document.createElement('section');
    userTurn.dataset.testid = 'conversation-turn-0';
    userTurn.dataset.turn = 'user';
    document.querySelector('main')!.appendChild(userTurn);

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalled();
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

  it('retires A immediately and waits for B ownership before initializing its timeline', async () => {
    const module = await import('../manager');
    const init = vi.spyOn(module.TimelineManager.prototype, 'init').mockResolvedValue(undefined);
    const destroy = vi
      .spyOn(module.TimelineManager.prototype, 'destroy')
      .mockImplementation(() => {});
    vi.spyOn(module.TimelineManager.prototype, 'refreshForThreadChange').mockImplementation(
      () => {},
    );
    history.replaceState({}, '', '/c/A');
    document.body.innerHTML =
      '<div data-app-shell-active-page="true"><main data-gv-thread-status="ready" data-gv-thread-conversation="A"></main></div>';
    const { startTimeline } = await import('../index');
    startTimeline();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(init).toHaveBeenCalledTimes(1);
    history.replaceState({}, '', '/c/B');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledTimes(1);
    const root = document.querySelector('main')!;
    root.setAttribute('data-gv-thread-conversation', 'B');
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: location.origin,
        data: { __gvType: 'gv-thread-updated', conversationId: 'B', ready: true },
      }),
    );
    expect(init).toHaveBeenCalledTimes(2);
  });
});
