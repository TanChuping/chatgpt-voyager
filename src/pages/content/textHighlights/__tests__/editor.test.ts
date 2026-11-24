import { expect, it, vi } from 'vitest';

import { HIGHLIGHTS_PREFIX, readHighlights } from '../anchors';
import { jumpToSavedHighlight, startTextHighlights } from '../index';

vi.mock('@/utils/i18n', () => ({ getTranslationSync: (key: string) => key }));

it.each([
  [
    'legacy',
    '<div data-message-id="message" data-message-author-role="assistant"><p class="markdown">one two</p></div>',
    'message',
  ],
  [
    'native user',
    '<div data-turn-key="user-turn"><div data-chatgpt-search-unit-key="unit:user" data-chatgpt-search-message-ids="user-id"><p data-user-message-bubble="true">one two</p></div></div>',
    'user-id',
  ],
  [
    'native assistant',
    '<div data-turn-key="user-turn"><div data-chatgpt-search-unit-key="unit:assistant" data-chatgpt-search-message-ids="tool-id"><div data-chatgpt-selection-message-id="answer-id"><p data-markdown-text-style="">one two</p></div></div></div>',
    'answer-id',
  ],
  [
    'turn fallback',
    '<div data-turn-key="user-turn"><p data-markdown-text-style="">one two</p></div>',
    'turn:user-turn:assistant',
  ],
])('persists, remounts, edits, and deletes a %s highlight', (_, markup, messageId) => {
  const registry = new Map<string, Set<Range>>();
  vi.stubGlobal('CSS', { ...globalThis.CSS, highlights: registry });
  vi.stubGlobal(
    'Highlight',
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  const originalRect = Range.prototype.getBoundingClientRect;
  Range.prototype.getBoundingClientRect = () => new DOMRect(10, 10, 200, 20);
  history.replaceState(null, '', '/c/test-highlight');
  const key = HIGHLIGHTS_PREFIX + 'test-highlight';
  const start = () => {
    document.body.innerHTML = `<main><div class="thread-scroll-container">${markup}</div></main>`;
    return startTextHighlights();
  };
  let stop = start();
  const select = () => {
    const paragraph = document.querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  };
  const click = (key: string) => {
    const button = [...document.querySelectorAll('button')].find(
      (node) => node.textContent === key || node.getAttribute('aria-label') === key,
    );
    expect(button).toBeDefined();
    button!.click();
  };

  try {
    select();
    click('textHighlightAdd');
    expect(document.querySelector('textarea')!.hidden).toBe(true);
    click('textHighlightNote');
    expect(document.querySelector('textarea')!.hidden).toBe(false);
    document.querySelector('textarea')!.value = 'First note';
    click('textHighlightSave');
    expect(readHighlights(key)).toMatchObject([
      { messageId, quote: 'one two', color: 'yellow', note: 'First note' },
    ]);

    stop();
    expect(registry.size).toBe(0);
    stop = start();
    expect([...registry.get('gv-text-yellow')!][0].toString()).toBe('one two');
    const scroller = document.querySelector('.thread-scroll-container')!;
    jumpToSavedHighlight('test-highlight', new URL(location.href), readHighlights(key)[0]);
    expect(scroller.scrollTop).toBe(10);

    select();
    click('textHighlightEdit');
    const blue = document.querySelector<HTMLInputElement>('.gv-hl-palette input[value="blue"]')!;
    blue.click();
    expect(blue.checked).toBe(true);
    expect([...registry.get('gv-draft-blue')!][0].toString()).toBe('one two');
    expect(readHighlights(key)[0].color).toBe('yellow');
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
    expect(registry.has('gv-draft-blue')).toBe(false);
    expect(registry.get('gv-text-yellow')!.size).toBe(1);
    select();
    click('textHighlightEdit');
    document.querySelector<HTMLInputElement>('.gv-hl-palette input[value="blue"]')!.click();
    document.querySelector('textarea')!.value = 'Changed note';
    click('textHighlightSave');
    expect(readHighlights(key)).toMatchObject([{ color: 'blue', note: 'Changed note' }]);
    expect(registry.get('gv-text-yellow')!.size).toBe(0);
    expect(registry.get('gv-text-blue')!.size).toBe(1);

    select();
    click('textHighlightEdit');
    click('textHighlightDelete');
    expect(readHighlights(key)).toEqual([]);
    expect(registry.get('gv-text-blue')!.size).toBe(0);

    stop();
    history.replaceState(null, '', '/c/another-chat');
    stop = start();
    select();
    click('textHighlightAdd');
    const selectedColor = () => document.querySelector<HTMLInputElement>('input:checked')?.value;
    expect(selectedColor()).toBe('blue');
    document.querySelector<HTMLInputElement>('input[value="pink"]')!.click();
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }));
    select();
    click('textHighlightAdd');
    expect(selectedColor()).toBe('blue');
    document.querySelector<HTMLInputElement>('input[value="green"]')!.click();
    click('textHighlightSave');
    expect(readHighlights(HIGHLIGHTS_PREFIX + 'another-chat')[0].color).toBe('green');
    history.replaceState(null, '', '/c/test-highlight');
    select();
    click('textHighlightAdd');
    expect(selectedColor()).toBe('green');
  } finally {
    stop();
    localStorage.removeItem(key);
    localStorage.removeItem(HIGHLIGHTS_PREFIX + 'another-chat');
    localStorage.removeItem('gptTextHighlightLastColor');
    document.body.replaceChildren();
    history.replaceState(null, '', '/');
    Range.prototype.getBoundingClientRect = originalRect;
    vi.unstubAllGlobals();
  }
});
