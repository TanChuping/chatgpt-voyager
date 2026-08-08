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

// Legacy KaTeX structures — still emitted by our own `userLatex` render and by
// Claude; ChatGPT used them until the 2026-08 markup change (captured live
// 2026-06).
const INLINE_KATEX = `<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><msup><mi>e</mi></msup></mrow><annotation encoding="application/x-tex">e^{i\\pi}+1=0</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base">e iπ +1=0</span></span></span>`;
const DISPLAY_KATEX = `<span class="katex-display"><span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">x= ...</span></span></span>`;

// ChatGPT's current markup (captured live 2026-08): no `.katex-mathml`, no
// `<annotation>`, no `<math>` — the TeX source moved onto a `role="math"`
// wrapper that *contains* `.katex-display` / `.katex`.
const GPT_INLINE = `<span data-start="119" data-end="128" role="math" aria-label="f'(x)" data-math-source="f'(x)" data-client-katex-layout=""><span class="katex"><span class="katex-html" aria-hidden="true"><span class="base">f′(x)</span></span></span></span>`;
const GPT_DISPLAY = `<span data-start="479" data-end="507" role="math" aria-label="\\int_0^1 x^2\\,dx" data-math-source="\\int_0^1 x^2\\,dx" data-client-katex-layout="" style="display: block;"><span class="katex-display"><span class="katex"><span class="katex-html" aria-hidden="true"><span class="base">∫01x2dx</span></span></span></span></span>`;

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

  // 2026-08: ChatGPT dropped the MathML annotation entirely.
  it('reads data-math-source off ChatGPT’s current inline wrapper', () => {
    expect(extractLatexFromNode(el(GPT_INLINE))).toBe("f'(x)");
  });

  it('reads data-math-source from an ancestor wrapper (node is the inner .katex)', () => {
    const inner = el(GPT_DISPLAY).querySelector('.katex')!;
    expect(extractLatexFromNode(inner)).toBe('\\int_0^1 x^2\\,dx');
  });

  it('returns null when no source is recoverable', () => {
    expect(extractLatexFromNode(el('<span class="katex"><span class="katex-html">x</span></span>'))).toBeNull();
  });
});

// ChatGPT has already moved its TeX twice (MathML annotation → data-math-source),
// each move silently breaking every copy path. These cover the shape-based
// last resort that keeps copying alive across a third rename.
describe('extractLatexFromNode — unknown markup fallback', () => {
  it('accepts a renamed source attribute whose value looks like TeX', () => {
    const node = el(
      `<span role="math" data-tex-src="\\frac{a}{b}"><span class="katex"><span class="katex-html">ab</span></span></span>`,
    ).querySelector('.katex')!;
    expect(extractLatexFromNode(node)).toBe('\\frac{a}{b}');
  });

  it('accepts a renamed attribute without TeX markers when aria-label mirrors it', () => {
    const node = el(
      `<span role="math" aria-label="f'(x)" data-tex-src="f'(x)"><span class="katex"><span class="katex-html">f′(x)</span></span></span>`,
    ).querySelector('.katex')!;
    expect(extractLatexFromNode(node)).toBe("f'(x)");
  });

  it('accepts aria-label alone only when it carries TeX markers', () => {
    const tex = el(`<span role="math" aria-label="x^{2}"><span class="katex">x2</span></span>`);
    expect(extractLatexFromNode(tex.querySelector('.katex')!)).toBe('x^{2}');
  });

  it('rejects a spoken aria-label (MathJax-style) rather than copying prose', () => {
    // Copying "f prime of x" would be silently wrong; failing is the safe side.
    const spoken = el(
      `<span role="math" aria-label="f prime of x"><span class="katex">f′(x)</span></span>`,
    );
    expect(extractLatexFromNode(spoken.querySelector('.katex')!)).toBeNull();
  });

  it('does not read attributes off the surrounding paragraph', () => {
    const p = el(`<p data-heading="a^2 + b^2"><span class="katex">x</span></p>`);
    expect(extractLatexFromNode(p.querySelector('.katex')!)).toBeNull();
  });

  it('ignores layout bookkeeping attributes', () => {
    const node = el(
      `<span role="math" data-start="479" data-end="507" data-client-katex-layout=""><span class="katex">x</span></span>`,
    ).querySelector('.katex')!;
    expect(extractLatexFromNode(node)).toBeNull();
  });
});

describe('isDisplayMath', () => {
  it('flags .katex-display wrappers', () => {
    expect(isDisplayMath(el(DISPLAY_KATEX))).toBe(true);
  });
  it('does not flag inline katex', () => {
    expect(isDisplayMath(el(INLINE_KATEX))).toBe(false);
  });
  it('flags ChatGPT’s wrapper by its descendant .katex-display', () => {
    expect(isDisplayMath(el(GPT_DISPLAY))).toBe(true);
  });
  it('does not flag ChatGPT’s inline wrapper', () => {
    expect(isDisplayMath(el(GPT_INLINE))).toBe(false);
  });
  it('falls back to display:block on the [role=math] wrapper', () => {
    // Survives a rename of `.katex-display`.
    const node = el(
      `<span role="math" style="display: block;"><span class="gpt-math">x</span></span>`,
    ).querySelector('.gpt-math')!;
    expect(isDisplayMath(node)).toBe(true);
  });
});

describe('containsMath', () => {
  it('detects katex in a fragment', () => {
    expect(containsMath(frag(`Hello ${INLINE_KATEX} world`))).toBe(true);
  });
  it('detects ChatGPT’s current markup in a fragment', () => {
    expect(containsMath(frag(`Hello ${GPT_INLINE} world`))).toBe(true);
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

  it('wraps each display formula in its own block element (so they do not collapse to one line)', () => {
    // Regression: a long answer with many stacked display equations must not
    // serialise to "$$a$$ $$b$$ $$c$$ …" on one line — each needs its own line.
    const f = frag(`${DISPLAY_KATEX}${DISPLAY_KATEX}${DISPLAY_KATEX}`);
    replaceMathWithLatex(f);
    const host = document.createElement('div');
    host.appendChild(f);
    const blocks = host.querySelectorAll('div');
    expect(blocks.length).toBe(3); // one block per display formula
    expect(blocks[0].textContent).toBe('$$x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}$$');
    // inline math, by contrast, stays a bare text node (no wrapper block)
    const inlineFrag = frag(`a ${INLINE_KATEX} b`);
    replaceMathWithLatex(inlineFrag);
    const inlineHost = document.createElement('div');
    inlineHost.appendChild(inlineFrag);
    expect(inlineHost.querySelector('div')).toBeNull();
  });

  it('honors a custom wrapper (e.g. notion $$ for all)', () => {
    const f = frag(INLINE_KATEX);
    replaceMathWithLatex(f, (latex) => `$$${latex}$$`);
    const host = document.createElement('div');
    host.appendChild(f);
    expect(host.textContent).toBe('$$e^{i\\pi}+1=0$$');
  });

  // 2026-08 regression: drag-selecting ChatGPT math used to copy the rendered
  // glyphs (`f′(x)`) because every extractor keyed off the (now absent) MathML
  // annotation.
  it('replaces ChatGPT’s current inline markup with $…$', () => {
    const f = frag(`求 ${GPT_INLINE} 的 series`);
    expect(replaceMathWithLatex(f)).toBe(1);
    const host = document.createElement('div');
    host.appendChild(f);
    expect(host.textContent).toBe("求 $f'(x)$ 的 series");
  });

  it('collapses ChatGPT’s current display wrapper to a single $$…$$', () => {
    const f = frag(`Before ${GPT_DISPLAY} after`);
    expect(replaceMathWithLatex(f)).toBe(1);
    const host = document.createElement('div');
    host.appendChild(f);
    expect(host.querySelector('.katex')).toBeNull();
    expect(host.querySelector('[data-math-source]')).toBeNull();
    expect(host.textContent).toBe('Before $$\\int_0^1 x^2\\,dx$$ after');
  });

  it('replaces legacy .math-block / [data-math] containers', () => {
    const f = frag('E: <span class="math-block"><span data-math="E = mc^2">E…</span></span>');
    replaceMathWithLatex(f);
    const host = document.createElement('div');
    host.appendChild(f);
    expect(host.textContent).toBe('E: $$E = mc^2$$');
  });
});
