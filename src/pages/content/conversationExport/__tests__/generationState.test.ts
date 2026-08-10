import { describe, expect, it } from 'vitest';

import { isChatGptResponseGenerating } from '../generationState';

describe('isChatGptResponseGenerating', () => {
  it('detects ChatGPT stop controls while a response is streaming', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button data-testid="stop-button">Stop</button>';
    expect(isChatGptResponseGenerating(root)).toBe(true);
  });

  it('returns false after the stop control is removed', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button data-testid="send-button">Send</button>';
    expect(isChatGptResponseGenerating(root)).toBe(false);
  });
});
