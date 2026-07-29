import { describe, expect, it } from 'vitest';

import { isIconOnly } from '../topBarButton';

/**
 * The injected "export this conversation" button clones ChatGPT's Share button
 * class list. Since the 2026-07 header rewrite those classes pin a 36×36 box
 * (`flex h-9 w-9 items-center justify-center`), so adding our own text label
 * overflowed the button and wrapped the label onto its own line. We now mirror
 * whatever the reference button does.
 */
describe('isIconOnly', () => {
  it('detects ChatGPT 2026-07 icon-only header buttons', () => {
    const share = document.createElement('button');
    share.className = 'flex h-9 w-9 items-center justify-center rounded-lg';
    share.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    expect(isIconOnly(share)).toBe(true);
  });

  it('treats whitespace-only content as icon-only', () => {
    const share = document.createElement('button');
    share.innerHTML = '<svg></svg>\n  ';
    expect(isIconOnly(share)).toBe(true);
  });

  it('keeps the label when the reference button is labelled', () => {
    const share = document.createElement('button');
    share.innerHTML = '<svg></svg><span>Share</span>';
    expect(isIconOnly(share)).toBe(false);
  });
});
