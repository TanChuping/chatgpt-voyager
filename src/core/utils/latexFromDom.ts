/**
 * Recover clean LaTeX source from rendered math in the live DOM.
 *
 * ChatGPT renders assistant math with KaTeX. Each formula keeps its original
 * TeX in a hidden MathML annotation:
 *
 *   <span class="katex">
 *     <span class="katex-mathml">
 *       <math …><semantics>…<annotation encoding="application/x-tex">e^{i\pi}+1=0</annotation></semantics></math>
 *     </span>
 *     <span class="katex-html" aria-hidden="true">…visual glyphs…</span>
 *   </span>
 *
 * Display formulas are additionally wrapped in `.katex-display`.
 *
 * A plain text selection of that DOM serialises to garbage — the MathML
 * presentation glyphs (math-italic Unicode) plus the duplicated `.katex-html`
 * glyph text (`𝑥 = − 𝑏 ± … x= 2a −b± …`). The clean source lives only in the
 * annotation. These helpers pull it out so selection-copy / quote-reply can
 * substitute `$…$` / `$$…$$` for the rendered nodes.
 *
 * Legacy `.math-inline` / `.math-block` / `[data-math]` containers (inherited
 * from the Gemini Voyager fork) are handled too, so both renderers are covered
 * by one pass.
 */

/** Collapse intra-formula whitespace so the recovered LaTeX is a single line. */
export function normalizeLatexWhitespace(latex: string): string {
  return latex.replace(/\s+/g, ' ').trim();
}

/**
 * Read the TeX source out of a rendered math node.
 * Tries (in order): `data-math` attribute, KaTeX x-tex annotation, any
 * annotation. Returns null when no source is recoverable.
 */
export function extractLatexFromNode(node: Element): string | null {
  const dataMath = node.getAttribute?.('data-math');
  if (dataMath) return normalizeLatexWhitespace(dataMath);

  const nested = node.querySelector?.('[data-math]')?.getAttribute('data-math');
  if (nested) return normalizeLatexWhitespace(nested);

  const xtex = node.querySelector?.('annotation[encoding="application/x-tex"]');
  if (xtex?.textContent) return normalizeLatexWhitespace(xtex.textContent);

  const anyAnnotation = node.querySelector?.('annotation');
  if (anyAnnotation?.textContent) return normalizeLatexWhitespace(anyAnnotation.textContent);

  return null;
}

/** Whether a rendered math node is a block/display formula. */
export function isDisplayMath(node: Element): boolean {
  if (node.closest?.('.katex-display, .math-block')) return true;
  if (node.classList?.contains('katex-display') || node.classList?.contains('math-block')) {
    return true;
  }
  if (node.querySelector?.('math[display="block"]')) return true;
  return false;
}

/** Default delimiter wrapper: `$…$` inline, `$$…$$` display. */
export function wrapLatexDefault(latex: string, display: boolean): string {
  return display ? `$$${latex}$$` : `$${latex}$`;
}

/** Selector matching every rendered-math container we know how to recover. */
export const MATH_NODE_SELECTOR = '.katex-display, .katex, .math-inline, .math-block, [data-math]';

/** Does this subtree contain any rendered math we can recover? */
export function containsMath(root: ParentNode): boolean {
  return root.querySelector(MATH_NODE_SELECTOR) !== null;
}

/**
 * Replace every rendered-math node in `root` with the recovered LaTeX
 * (wrapped via `wrap`). Outer containers are processed first so a display
 * formula collapses to a single `$$…$$` node rather than leaving the inner
 * `.katex` behind. Returns the number of formulas replaced.
 *
 * Inline formulas become a plain text node (they sit mid-sentence). Display
 * formulas are wrapped in a block element instead — a rendered `.katex-display`
 * is block-level, so a plain text node would let `innerText` run consecutive
 * display formulas together on one line (e.g. 20 stacked equations collapsing
 * into `$$a$$ $$b$$ $$c$$ …`). The block element preserves the line break each
 * display formula had, so each lands on its own line. `textContent`-based
 * readers are unaffected (the block adds no characters).
 *
 * Mutates `root` in place — pass a cloned fragment, never live page DOM.
 */
export function replaceMathWithLatex(
  root: ParentNode,
  wrap: (latex: string, display: boolean) => string = wrapLatexDefault,
): number {
  let replaced = 0;

  // Outer-first: display wrappers, then legacy block/inline containers, then
  // any bare `.katex` / `[data-math]` still standing. querySelectorAll is
  // re-evaluated each call, so nodes detached by an earlier pass drop out.
  for (const selector of ['.katex-display', '.math-block', '.math-inline', '.katex', '[data-math]']) {
    for (const node of Array.from(root.querySelectorAll(selector))) {
      // Skip nodes already detached by replacing an ancestor in a prior pass.
      if (!root.contains(node)) continue;
      const latex = extractLatexFromNode(node);
      if (!latex) continue;
      const display = isDisplayMath(node);
      const doc = node.ownerDocument!;
      const wrapped = wrap(latex, display);
      if (display) {
        const block = doc.createElement('div');
        block.textContent = wrapped;
        node.replaceWith(block);
      } else {
        node.replaceWith(doc.createTextNode(wrapped));
      }
      replaced++;
    }
  }

  return replaced;
}
