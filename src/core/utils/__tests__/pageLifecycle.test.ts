import { describe, expect, it, vi } from 'vitest';

import { addPageExitListener } from '../pageLifecycle';

function dispatchPageHide(persisted: boolean): void {
  const event = new Event('pagehide') as PageTransitionEvent;
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
}

describe('addPageExitListener', () => {
  it('ignores beforeunload because a download navigation can leave the page alive', () => {
    const cleanup = vi.fn();
    const remove = addPageExitListener(cleanup);

    window.dispatchEvent(new Event('beforeunload'));

    expect(cleanup).not.toHaveBeenCalled();
    remove();
  });

  it('cleans up once when the document is really discarded', () => {
    const cleanup = vi.fn();
    addPageExitListener(cleanup);

    dispatchPageHide(false);
    dispatchPageHide(false);

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('keeps features alive while the document is stored in the back-forward cache', () => {
    const cleanup = vi.fn();
    const remove = addPageExitListener(cleanup);

    dispatchPageHide(true);

    expect(cleanup).not.toHaveBeenCalled();
    remove();
  });
});
