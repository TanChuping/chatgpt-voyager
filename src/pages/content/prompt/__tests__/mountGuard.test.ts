import { afterEach, describe, expect, it } from 'vitest';

import { keepPromptManagerMounted } from '../mountGuard';

describe('Prompt Manager mount guard', () => {
  let stop: (() => void) | null = null;

  afterEach(() => {
    stop?.();
    stop = null;
    document.body.innerHTML = '';
  });

  it('reattaches the trigger and panel removed by late page hydration', async () => {
    const trigger = document.createElement('button');
    const panel = document.createElement('div');
    document.body.append(trigger, panel);
    stop = keepPromptManagerMounted(trigger, panel);

    trigger.remove();
    panel.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(trigger.parentElement).toBe(document.body);
    expect(panel.parentElement).toBe(document.body);
  });
});
