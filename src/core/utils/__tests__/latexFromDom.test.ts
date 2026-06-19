import { describe, expect, it } from 'vitest';

import {
  containsMath,
  extractLatexFromNode,
  isDisplayMath,
  normalizeLatexWhitespace,
  replaceMathWithLatex,
} from '../latexFromDom';

/** Build a detached element from an HTML string. */
function el(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
}

/** Build a DocumentFragment from an HTML string (mirrors range.cloneContents). */
function frag(html: string): DocumentFragment {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content;
}

// Faithful ChatGPT KaTeX structures (captured live 2026-06).
const INLINE_KATEX = `<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><msup><mi>e</mi></msup></mrow><annotation encoding="application/x-tex">e^{i\\pi}+1=0</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base">e iπ +1=0</span></span></span>`;
const DISPLAY_KATEX = `<span class="katex-display"><span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">x= ...</span></span></span>`;

describe('normalizeLatexWhitespace', () => {
  it('collapses newlines/runs to single spaces and trims', () => {
    expect(normalizeLatexWhitespace('  a  +\n  b  ')).toBe('a + b');
  });
});

describe('extractLatexFromNode', () => {
  it('reads the KaTeX x-tex annotation', () => {
    expect(extractLatexFromNode(el(INLINE_KATEX))).toBe('e^{i\\pi}+1=0');
  });

  it('reads the annotation from a display wrapper (nested)', () => {
    expect(extractLatexFromNode(el(DISPLAY_KATEX))).toBe('x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}');
  });

  it('prefers data-math when present (legacy)', () => {
    expect(extractLatexFromNode(el('<span data-math="U \\in [0,1)">U…</span>'))).toBe('U \\in [0,1)');
  });

  it('returns null when no source is recoverable', () => {
    expect(extractLatexFromNode(el('<span class="katex"><span class="katex-html">x</span></span>'))).toBeNull();
  });
});

describe('isDisplayMath', () => {
  it('flags .katex-display wrappers', () => {
    expect(isDisplayMath(el(DISPLAY_KATEX))).toBe(true);
  });
  it('does not flag inline katex', () => {
    expect(isDisplayMath(el(INLINE_KATEX))).toBe(false);
  });
});

describe('containsMath', () => {
  it('detects katex in a fragment', () => {
    expect(containsMath(frag(`Hello ${INLINE_KATEX} world`))).toBe(true);
  });
  it('is false for plain text', () => {
    expect(containsMath(frag('just some text (a, b) and [1, 2]'))).toBe(false);
  });
});

describe('replaceMathWithLatex', () => {
  it('replaces inline katex with $…$', () => {
    const f = frag(`Euler's identity is ${INLINE_KATEX}.`);
    const n = replaceMathWithLatex(f);
    const host = document.createElement('div');
    host.appendChild(f);
    expect(n).toBe(1);
    expect(host.textContent).toBe("Euler's identity is $e^{i\\pi}+1=0$.");
  });

  it('replaces display katex with $$…$$ (collapses the wrapper, no leftover .katex)', () => {
    const f = frag(`Before ${DISPLAY_KATEX} after`);
    replaceMathWithLatex(f);
    const host = document.createElement('div');
    host.appendChild(f);
    expect(host.querySelector('.katex')).toBeNull();
    expect(host.textContent).toBe('Before $$x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}$$ after');
  });

  it('handles a mixed selection (text + inline + display) in one pass', () => {
    const f = frag(`${INLINE_KATEX} and ${DISPLAY_KATEX}`);
    expect(replaceMathWithLatex(f)).toBe(2);
    const host = document.createElement('div');
    host.appendChild(f);
    expect(host.textContent).toBe(
      '$e^{i\\pi}+1=0$ and $$x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}$$',
    );
  });

  it('honors a custom wrapper (e.g. notion $$ for all)', () => {
    const f = frag(INLINE_KATEX);
    replaceMathWithLatex(f, (latex) => `$$${latex}$$`);
    const host = document.createElement('div');
    host.appendChild(f);
    expect(host.textContent).toBe('$$e^{i\\pi}+1=0$$');
  });

  it('replaces legacy .math-block / [data-math] containers', () => {
    const f = frag('E: <span class="math-block"><span data-math="E = mc^2">E…</span></span>');
    replaceMathWithLatex(f);
    const host = document.createElement('div');
    host.appendChild(f);
    expect(host.textContent).toBe('E: $$E = mc^2$$');
  });
});
