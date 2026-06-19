import { describe, expect, it } from 'vitest';

import { fixDelimiters } from '../clipboardLatexFix';

// Exact sources as they appear in ChatGPT's KaTeX annotations (captured live).
const QUAD = 'x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}';
const EULER = 'e^{i\\pi}+1=0';

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
