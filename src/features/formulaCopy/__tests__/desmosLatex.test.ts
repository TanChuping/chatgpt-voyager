import { describe, expect, it } from 'vitest';

import { toDesmosLatex } from '../desmosLatex';

// Every input below is verbatim ChatGPT output captured from a live
// conversation; the expectations were checked by actually pasting the result
// into desmos.com (2026-08-08).
describe('toDesmosLatex', () => {
  it('drops \\, — MathQuill pastes it as a literal comma', () => {
    // `\int_0^1 x^2\,dx` used to arrive in Desmos as `\int_{0}^{1}x^{2},dx`.
    expect(toDesmosLatex('\\int_{0}^{1}x^2\\,dx')).toBe('\\int_{0}^{1}x^2dx');
  });

  it('drops \\displaystyle, which otherwise kills the whole paste', () => {
    expect(toDesmosLatex('\\displaystyle \\frac{1}{1+x^2}')).toBe('\\frac{1}{1+x^2}');
    expect(toDesmosLatex('\\displaystyle \\sqrt{1-\\frac{x^2}{a^2}}')).toBe(
      '\\sqrt{1-\\frac{x^2}{a^2}}',
    );
  });

  it('drops the other spacing and style directives', () => {
    expect(toDesmosLatex('x^2\\qquad y^2')).toBe('x^2y^2');
    expect(toDesmosLatex('x^2\\;y^2')).toBe('x^2y^2');
    expect(toDesmosLatex('x^2\\!y^2')).toBe('x^2y^2');
    expect(toDesmosLatex('x^2\\ y^2')).toBe('x^2y^2');
    expect(toDesmosLatex('\\sum\\limits_{n=1}^{5}n')).toBe('\\sum_{n=1}^{5}n');
    expect(toDesmosLatex('x\\hspace{1em}y')).toBe('xy');
  });

  it('unwraps \\boxed, keeping nested braces intact', () => {
    expect(toDesmosLatex('\\boxed{\\displaystyle \\int_{-\\infty}^{\\infty}e^{-x^2}\\,dx=\\sqrt{\\pi}}')).toBe(
      '\\int_{-\\infty}^{\\infty}e^{-x^2}dx=\\sqrt{\\pi}',
    );
    expect(toDesmosLatex('\\boxed{\\frac{a}{b}}')).toBe('\\frac{a}{b}');
  });

  it('leaves commands Desmos understands alone', () => {
    const untouched = [
      '\\frac{\\sqrt{x^2+4x+5}}{\\sqrt[3]{x-1}+\\dfrac{1}{x+2}}',
      '\\left(\\frac{x}{2}\\right)^2',
      '\\lim_{x\\to0}\\frac{\\sin x}{x}=1',
      '\\sum_{n=1}^{\\infty}(-1)^n\\frac{n^2}{e^n}',
      '2\\cdot 3',
      '\\operatorname{Re}(s)',
    ];
    for (const latex of untouched) {
      expect(toDesmosLatex(latex)).toBe(latex.replace(/\s+/g, ' ').trim());
    }
  });

  it('never truncates a formula with unbalanced braces', () => {
    // Defensive: a malformed source must come back recognisable, not chopped.
    expect(toDesmosLatex('\\boxed{x^2')).toBe('\\boxed{x^2');
  });

  it('does not invent a substitute for content Desmos cannot express', () => {
    // \text / \nabla / environments stay put — the paste will fail, which is
    // honest. Silently rewriting them would change the mathematics.
    expect(toDesmosLatex('\\text{abc}')).toBe('\\text{abc}');
    expect(toDesmosLatex('\\nabla f')).toBe('\\nabla f');
    expect(toDesmosLatex('\\begin{cases} x^2, & x<0 \\end{cases}')).toBe(
      '\\begin{cases} x^2, & x<0 \\end{cases}',
    );
  });
});
