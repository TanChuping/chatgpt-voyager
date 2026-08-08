/**
 * Strip typesetting-only LaTeX so a copied formula survives a paste into a
 * calculator input (Desmos, GeoGebra — anything backed by MathQuill).
 *
 * MathQuill's paste is all-or-nothing: a single command it does not know makes
 * it drop the *entire* paste, leaving the field empty. Measured live against
 * desmos.com (2026-08-08), pasting bare LaTeX:
 *
 *   REJECTED (whole paste lost)  \displaystyle  \qquad  \;  \!  \limits
 *                                \boxed{…}  \text{…}  \nabla  \begin{…}
 *   ACCEPTED but WRONG           \,  →  a literal comma
 *                                (`\int_0^1 x^2\,dx` pastes as `x^{2},dx`)
 *   ACCEPTED                     \frac \sqrt \left \right \cdot \to \sum
 *                                \int \infty \mid \Gamma \operatorname \mathbf
 *
 * So this pass removes exactly the commands that carry no meaning — spacing and
 * style directives — and unwraps `\boxed{…}`. It deliberately does NOT try to
 * rewrite `\text{…}`, `\nabla`, matrices or `\begin{aligned}` blocks: those are
 * real mathematical content Desmos has no notation for, and inventing a
 * substitute would silently change the formula. Such a formula still fails to
 * paste, which is the honest outcome.
 */

/**
 * Style directives that only affect rendering size/placement.
 *
 * The trailing `\s*` matters: in TeX the space after a control word is the
 * word's terminator, not a space in the output, so `x\qquad y` must collapse to
 * `xy` rather than leaving a stray gap behind.
 */
const STYLE_COMMANDS =
  /\\(?:displaystyle|textstyle|scriptscriptstyle|scriptstyle|nolimits|limits)(?![a-zA-Z])\s*/g;

/**
 * Horizontal spacing. `qquad` precedes `quad` and the long names precede the
 * punctuation forms so the alternation never matches a prefix of a longer
 * command. The final class covers `\,` `\;` `\:` `\!` `\>` and `\ `.
 */
const SPACING_COMMANDS =
  /\\(?:negthickspace|negmedspace|negthinspace|thickspace|medspace|thinspace|enspace|qquad|quad|[,;:!> ])\s*/g;

/** `\hspace{1em}` / `\mspace{3mu}` / `\kern2pt` and friends. */
const SIZED_SPACING =
  /\\(?:hspace\*?|mspace|kern|mkern|hskip|mskip)\s*(?:\{[^}]*\}|[-\d.]+\s*[a-z]{2})\s*/g;

/**
 * Remove `\name{…}` while keeping its contents. Brace-aware, so a nested
 * `\frac{a}{b}` inside the wrapper survives intact. Bails out on unbalanced
 * braces rather than truncating the formula.
 */
function unwrapCommand(latex: string, name: string): string {
  const token = `\\${name}{`;
  let out = latex;
  let searchFrom = 0;

  for (;;) {
    const start = out.indexOf(token, searchFrom);
    if (start === -1) return out;

    const bodyStart = start + token.length;
    let depth = 1;
    let i = bodyStart;
    while (i < out.length && depth > 0) {
      const ch = out[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    if (depth !== 0) return out; // unbalanced — leave the formula alone

    out = out.slice(0, start) + out.slice(bodyStart, i - 1) + out.slice(i);
    searchFrom = start;
  }
}

/** Rewrite `latex` into the most paste-friendly equivalent for a calculator. */
export function toDesmosLatex(latex: string): string {
  return unwrapCommand(latex, 'boxed')
    .replace(SIZED_SPACING, '')
    .replace(STYLE_COMMANDS, '')
    .replace(SPACING_COMMANDS, '')
    .replace(/\s+/g, ' ')
    .trim();
}
