import { describe, expect, it } from 'vitest';

import { captureTextAnchor, resolveTextAnchor } from '../anchors';

describe('text highlight anchors', () => {
  it('reattaches across a message DOM remount without changing its markup', () => {
    const original = document.createElement('div');
    original.innerHTML = 'Before <b>alpha</b> beta after';
    const selection = document.createRange();
    selection.setStart(original.querySelector('b')!.firstChild!, 0);
    selection.setEnd(original.lastChild!, 5);
    const anchor = captureTextAnchor(original, selection)!;
    expect(anchor).toEqual({ start: 7, end: 17, quote: 'alpha beta' });

    const remount = document.createElement('div');
    remount.innerHTML = '<i>New prefix</i> Before alpha <b>beta</b> after';
    const markup = remount.innerHTML;
    expect(resolveTextAnchor(remount, anchor)?.toString()).toBe('alpha beta');
    expect(remount.innerHTML).toBe(markup);
  });

  it('rejects cross-message selections and avoids guessing between repeated phrases', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>alpha</p><p>beta</p>';
    const selection = document.createRange();
    selection.selectNodeContents(root);
    expect(captureTextAnchor(root.firstElementChild!, selection)).toBeNull();
    expect(resolveTextAnchor(root, { start: 2, end: 7, quote: 'gamma' })).toBeNull();
    root.textContent = 'alpha alpha';
    expect(resolveTextAnchor(root, { start: 2, end: 7, quote: 'alpha' })).toBeNull();
    expect(resolveTextAnchor(root, { start: 6, end: 11, quote: 'alpha' })?.startOffset).toBe(6);
  });
});
