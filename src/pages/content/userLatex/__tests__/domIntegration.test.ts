/**
 * Tests that `startUserLatex` actually walks the ChatGPT bubble shape
 * that exists in 2026-05. parseSegments has its own focused tests; this
 * file is the regression guard for the selector itself — the 1.6.2-and-
 * earlier bug was a stale Gemini Voyager selector that quietly matched
 * nothing on ChatGPT, so this test would have caught it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startUserLatex } from '../index';

/**
 * Build a synthetic ChatGPT user-message bubble. We mirror the live DOM as
 * close as we can without dragging in the full ProseMirror / Tailwind stack:
 *
 *   div[data-message-author-role="user"]
 *     └── div.user-message-bubble-color
 *          └── div.whitespace-pre-wrap   ← gets processed
 */
function mountUserBubble(text: string): HTMLElement {
  const container = document.createElement('div');
  container.setAttribute('data-message-author-role', 'user');
  const bubble = document.createElement('div');
  bubble.className = 'user-message-bubble-color';
  const leaf = document.createElement('div');
  leaf.className = 'max-w-full min-w-0 whitespace-pre-wrap';
  leaf.textContent = text;
  bubble.appendChild(leaf);
  container.appendChild(bubble);
  document.body.appendChild(container);
  return leaf;
}

/**
 * Same shape but as an *assistant* bubble. The renderer must skip these —
 * assistant text already comes back as rendered KaTeX from ChatGPT, and
 * running our renderer over it would either double-render or destroy the
 * existing HTML.
 */
function mountAssistantBubble(text: string): HTMLElement {
  const container = document.createElement('div');
  container.setAttribute('data-message-author-role', 'assistant');
  const leaf = document.createElement('div');
  leaf.className = 'whitespace-pre-wrap';
  leaf.textContent = text;
  container.appendChild(leaf);
  document.body.appendChild(container);
  return leaf;
}

describe('startUserLatex DOM integration', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders inline math inside a real-shaped user bubble', () => {
    const leaf = mountUserBubble('Solve $E=mc^2$ for me.');
    startUserLatex();

    expect(leaf.dataset.userLatexProcessed).toBe('1');
    expect(leaf.dataset.userLatexOriginal).toBe('Solve $E=mc^2$ for me.');
    // KaTeX renders into elements carrying the `katex` class — quick
    // structural check without binding to specific markup KaTeX may revise.
    expect(leaf.querySelector('.katex')).not.toBeNull();
    expect(leaf.querySelector('.gv-user-latex-inline')).not.toBeNull();
  });

  it('renders display math', () => {
    const leaf = mountUserBubble('Result: $$\\int_0^1 x^2 dx = 1/3$$');
    startUserLatex();
    expect(leaf.querySelector('.gv-user-latex-display')).not.toBeNull();
  });

  it('marks a non-math user bubble as processed without mutating content', () => {
    const leaf = mountUserBubble('Just a plain question, no math here.');
    startUserLatex();
    expect(leaf.dataset.userLatexProcessed).toBe('1');
    // No KaTeX node should have been injected
    expect(leaf.querySelector('.katex')).toBeNull();
    // Original text preserved
    expect(leaf.textContent).toBe('Just a plain question, no math here.');
  });

  it('does NOT touch assistant bubbles', () => {
    const leaf = mountAssistantBubble('Here is $a^2 + b^2$ as the answer.');
    startUserLatex();
    expect(leaf.dataset.userLatexProcessed).toBeUndefined();
    expect(leaf.querySelector('.gv-user-latex-inline')).toBeNull();
  });

  it('skips re-processing an already-processed leaf', () => {
    const leaf = mountUserBubble('$x+y$');
    startUserLatex();
    const firstHtml = leaf.innerHTML;
    // Calling startUserLatex again should not double-render
    startUserLatex();
    expect(leaf.innerHTML).toBe(firstHtml);
  });

  it('handles multiple user bubbles in one pass', () => {
    const a = mountUserBubble('first $x^2$');
    const b = mountUserBubble('second $y^2$');
    startUserLatex();
    expect(a.querySelector('.katex')).not.toBeNull();
    expect(b.querySelector('.katex')).not.toBeNull();
  });

  it('picks up bubbles added later via MutationObserver', async () => {
    vi.useFakeTimers();
    try {
      startUserLatex();
      const leaf = mountUserBubble('later $1+1=2$');
      // The observer is debounced 300 ms. Advance fake timers past that.
      await vi.advanceTimersByTimeAsync(400);
      expect(leaf.querySelector('.katex')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
