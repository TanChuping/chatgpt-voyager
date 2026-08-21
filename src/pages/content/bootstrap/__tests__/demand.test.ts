import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBusinessDemandRouter } from '../demand';
import { BUSINESS_DEMAND_FEATURE_IDS } from '../features';

describe('business demand router', () => {
  let stop: (() => void) | null = null;

  afterEach(() => {
    stop?.();
    stop = null;
    document.body.innerHTML = '';
  });

  it('loads response export actions as soon as a current assistant action row exists', () => {
    document.body.innerHTML = `
      <section data-testid="conversation-turn-2">
        <div data-message-author-role="assistant">
          <div role="group">
            <button type="button" data-testid="copy-turn-action-button">Copy</button>
          </div>
        </div>
      </section>
    `;
    const onSignal = vi.fn();
    const router = createBusinessDemandRouter(onSignal);
    stop = router.stop;

    router.start();

    expect(onSignal).toHaveBeenCalledWith('response-action');
    expect(BUSINESS_DEMAND_FEATURE_IDS['response-action']).toEqual(['export-button']);
    expect(onSignal).not.toHaveBeenCalledWith('export-menu-interaction');
  });
});
