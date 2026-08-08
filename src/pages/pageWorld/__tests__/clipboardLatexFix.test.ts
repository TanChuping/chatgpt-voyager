import { afterEach, describe, expect, it } from 'vitest';

import { collectSources, fixDelimiters } from '../clipboardLatexFix';

// Exact sources as they appear in ChatGPT's KaTeX annotations (captured live).
const QUAD = 'x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}';
const EULER = 'e^{i\\pi}+1=0';

describe('collectSources', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  // 2026-08: ChatGPT's KaTeX layout stopped emitting MathML, so the native
  // copy button's delimiter repair found zero sources and passed through.
  it('reads ChatGPT’s current data-math-source wrappers', () => {
    document.body.innerHTML = `<span role="math" aria-label="${EULER}" data-math-source="${EULER}"><span class="katex"><span class="katex-html">e iπ+1=0</span></span></span>`;
    expect(collectSources()).toEqual([EULER]);
  });

  it('still reads legacy x-tex annotations and [data-math]', () => {
    document.body.innerHTML =
      `<span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">${QUAD}</annotation></semantics></math></span></span>` +
      `<span data-math="${EULER}">e</span>`;
    // Longest first, so a source that is a substring of another is fixed second.
    expect(collectSources()).toEqual([QUAD, EULER]);
  });

  it('skips bare alphanumeric sources (would corrupt prose like O(N))', () => {
    document.body.innerHTML = `<span role="math" data-math-source="N"></span>`;
    expect(collectSources()).toEqual([]);
  });
});

describe('fixDelimiters (text/plain)', () => {
  it('repairs ChatGPT display delimiters [ … ] → $$ … $$', () => {
    // Exactly what the native copy button produced for the display formula.
    const input = `The quadratic formula is\n[\n${QUAD}\n]\nand more`;
    const out = fixDelimiters(input, [QUAD], false);
    expect(out).toBe(`The quadratic formula is\n$$${QUAD}$$\nand more`);
  });

  it('repairs ChatGPT inline delimiters ( … ) → $ … $', () => {
    const input = `Euler’s identity is (${EULER}).`;
    const out = fixDelimiters(input, [EULER], false);
    expect(out).toBe(`Euler’s identity is $${EULER}$.`);
  });

  it('repairs both in one payload', () => {
    const input = `The quadratic formula is\n[\n${QUAD}\n]\nand Euler’s identity is (${EULER}).`;
    const out = fixDelimiters(input, [QUAD, EULER], false);
    expect(out).toBe(`The quadratic formula is\n$$${QUAD}$$\nand Euler’s identity is $${EULER}$.`);
  });

  it('also accepts still-escaped \\[ \\] / \\( \\) delimiters', () => {
    const input = `\\[ ${QUAD} \\] and \\(${EULER}\\)`;
    const out = fixDelimiters(input, [QUAD, EULER], false);
    expect(out).toBe(`$$${QUAD}$$ and $${EULER}$`);
  });

  it('does NOT touch ordinary prose brackets/parens (anchors on exact source)', () => {
    const input = 'See item (a, b) and the range [1, 2] for details.';
    expect(fixDelimiters(input, [QUAD, EULER], false)).toBe(input);
  });

  it('does NOT rewrite prose when a single-letter formula source exists', () => {
    // Regression: a page formula "$N$" / "$x$" must not turn "O(N)" into "O$N$"
    // or "option (a)" into "option $a$". Bare alphanumeric sources are skipped.
    expect(fixDelimiters('Complexity is O(N) here.', ['N'], false)).toBe('Complexity is O(N) here.');
    expect(fixDelimiters('Pick option (a) or [b].', ['a', 'b'], false)).toBe('Pick option (a) or [b].');
    expect(fixDelimiters('See (AB) and (x1).', ['AB', 'x1'], false)).toBe('See (AB) and (x1).');
  });

  it('still fixes a single-letter formula that carries a LaTeX marker (e.g. \\pi)', () => {
    // "\pi" is math-y (has a backslash) so prose "(\pi)" is safe to rewrite.
    expect(fixDelimiters('Constant (\\pi) here.', ['\\pi'], false)).toBe('Constant $\\pi$ here.');
  });

  it('is a no-op when there are no known sources', () => {
    const input = `[\n${QUAD}\n]`;
    expect(fixDelimiters(input, [], false)).toBe(input);
  });

  it('tolerates whitespace differences between annotation and copied body', () => {
    const src = 'a + b';
    const input = '(a   +   b)';
    expect(fixDelimiters(input, [src], false)).toBe('$a + b$');
  });
});

describe('fixDelimiters (text/html)', () => {
  it('repairs <br>-separated display delimiters and escapes the source', () => {
    const input = `<p>is<br>[<br>${QUAD}<br>]<br>and (${EULER}).</p>`;
    const out = fixDelimiters(input, [QUAD, EULER], true);
    expect(out).toContain(`$$${QUAD}$$`);
    expect(out).toContain(`$${EULER}$`);
    expect(out).not.toMatch(/<br>\]/);
  });
});

describe('fixDelimiters guardrails', () => {
  it('never rewrites a shorter source inside an already-fixed formula body', () => {
    // Both formulas exist on the page: the display one CONTAINS "(x+p)" which
    // is also a standalone inline formula. Without placeholder isolation the
    // second pass would nest into `$$$x+p$^2…$$` delimiter soup.
    const DISPLAY = '(x+p)^2=x^2+2px+p^2';
    const INLINE = 'x+p';
    const input = `Complete the square:\n[\n${DISPLAY}\n]\nwhere (${INLINE}) shifts the root.`;
    const out = fixDelimiters(input, [DISPLAY, INLINE], false);
    expect(out).toBe(`Complete the square:\n$$${DISPLAY}$$\nwhere $${INLINE}$ shifts the root.`);
    expect(out).not.toMatch(/\${3,}/);
  });

  it('falls back to the ORIGINAL payload when the rewrite would create $$$ soup', () => {
    // A literal "$" directly before a display bracket would merge into "$$$".
    // The guardrail must prefer ChatGPT's unmodified baseline over garbage.
    const input = 'price$[ a+b ]';
    expect(fixDelimiters(input, ['a+b'], false)).toBe(input);
  });

  it('passes NUL-containing payloads through untouched (placeholder alphabet)', () => {
    const input = 'weird ' + String.fromCharCode(0) + ' payload [ a+b ]';
    expect(fixDelimiters(input, ['a+b'], false)).toBe(input);
  });

  it('passes oversized payloads through untouched', () => {
    const input = `[ a+b ]` + 'x'.repeat(1_000_001);
    expect(fixDelimiters(input, ['a+b'], false)).toBe(input);
  });

  it('is a no-op when ChatGPT already emits dollar delimiters', () => {
    // Future-proofing: if ChatGPT starts writing $$…$$ itself, nothing matches
    // and the payload flows through byte-identical.
    const input = `Already fixed: $$${QUAD}$$ and $${EULER}$.`;
    expect(fixDelimiters(input, [QUAD, EULER], false)).toBe(input);
  });
});

describe('fixDelimiters — ChatGPT aligned-collapse "=====" repair', () => {
  it('collapses a run of equals inside a $$…$$ block back to one =', () => {
    // ChatGPT flattens a multi-line \begin{aligned} and turns the &= alignment
    // into a run of equals. Runs even with NO sources (delimiters already $$).
    const input = '$$x^2+\\frac{b}{a}x=================-\\frac{c}{a}$$';
    expect(fixDelimiters(input, [], false)).toBe('$$x^2+\\frac{b}{a}x=-\\frac{c}{a}$$');
  });

  it('collapses multiple equals-runs in one block (chained equation)', () => {
    expect(fixDelimiters('$$a====b=====c$$', [], false)).toBe('$$a=b=c$$');
  });

  it('also repairs \\[ … \\] display blocks', () => {
    expect(fixDelimiters('\\[ a======b \\]', [], false)).toBe('\\[ a=b \\]');
  });

  it('NEVER touches equals runs in prose (setext headings / rules)', () => {
    const input = 'Section Title\n=========\n\nbody text';
    expect(fixDelimiters(input, [], false)).toBe(input);
  });

  it('leaves a single = inside math alone', () => {
    expect(fixDelimiters('$$a=b$$', [], false)).toBe('$$a=b$$');
  });

  it('composes with delimiter repair: fixes delimiters AND the equals run', () => {
    // Native copy stripped the bracket AND mangled the body's alignment.
    const input = `[ ${QUAD} ] then $$a=====b$$`;
    expect(fixDelimiters(input, [QUAD], false)).toBe(`$$${QUAD}$$ then $$a=b$$`);
  });
});
