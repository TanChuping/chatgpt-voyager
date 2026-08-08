/**
 * Recover clean LaTeX source from rendered math in the live DOM.
 *
 * ChatGPT renders assistant math with KaTeX, and **changed the markup in
 * 2026-08**. Current shape (verified live) — the TeX source sits on a semantic
 * wrapper that is the *ancestor* of the KaTeX tree, and there is no MathML at
 * all:
 *
 *   <span role="math" aria-label="f'(x)" data-math-source="f'(x)" data-client-katex-layout>
 *     [<span class="katex-display">]         ← display formulas only
 *       <span class="katex">
 *         <span class="katex-html" aria-hidden="true">…visual glyphs…</span>
 *
 * Older markup (still emitted by our own `userLatex` KaTeX render, and by
 * Claude) keeps the source in a hidden MathML annotation *inside* `.katex`:
 *
 *   <span class="katex">
 *     <span class="katex-mathml">
 *       <math …><semantics>…<annotation encoding="application/x-tex">e^{i\pi}+1=0</annotation></semantics></math>
 *     </span>
 *     <span class="katex-html" aria-hidden="true">…visual glyphs…</span>
 *   </span>
 *
 * Both are handled: `data-math-source` is read from the nearest wrapper, with
 * the annotation kept as the fallback.
 *
 * A plain text selection of that DOM never yields usable LaTeX — at best the
 * rendered glyphs (`f′(x)` instead of `$f'(x)$`), at worst, with the old
 * MathML present, doubled glyph soup (`𝑥 = − 𝑏 ± … x= 2a −b± …`). These helpers
 * pull the real source out so selection-copy / quote-reply can substitute
 * `$…$` / `$$…$$` for the rendered nodes.
 *
 * Legacy `.math-inline` / `.math-block` / `[data-math]` containers (inherited
 * from the Gemini Voyager fork) are handled too, so both renderers are covered
 * by one pass.
 */

/**
 * Collapse intra-formula whitespace so the recovered LaTeX is a single line.
 *
 * The model often pretty-prints long formulas with newlines between operands,
 * and those newlines reach the source attribute / annotation verbatim. The
 * rendered math is identical either way (LaTeX treats newlines as whitespace in
 * math mode), but tools like Desmos that ingest one expression per line choke
 * on the multi-line form. Safe because math-mode tokens are delimited by
 * command names and braces, never by significant whitespace.
 */
export function normalizeLatexWhitespace(latex: string): string {
  return latex.replace(/\s+/g, ' ').trim();
}

/**
 * Attribute names that have carried raw TeX in a renderer we support, newest
 * first. Matched by name, so their value is trusted as-is.
 */
const KNOWN_SOURCE_ATTRIBUTES = [
  'data-math-source',
  'data-math',
  'data-latex',
  'data-tex',
  'data-formula',
];

/** Attributes that are definitely not a formula source. */
const IGNORED_ATTRIBUTES = new Set([
  'class',
  'style',
  'id',
  'role',
  'dir',
  'title',
  'tabindex',
  'data-start',
  'data-end',
  'data-state',
  'data-testid',
]);

/**
 * Characters that only appear in TeX, never in a *spoken* math description.
 * This is what separates a real source attribute from an accessibility label:
 * MathJax-style renderers put "f prime of x" in `aria-label`, KaTeX-style ones
 * put `f'(x)`. Requiring a TeX marker means an unknown attribute is only
 * trusted when its value really is TeX.
 */
const TEX_MARKER = /[\\^_{}]/;

/** Longest plausible single formula; anything past this is not a source. */
const MAX_SOURCE_LENGTH = 4000;

/**
 * Elements that could carry the source for `node`: itself, the `[role="math"]`
 * scope it belongs to, and the inline wrappers in between. The climb stops at
 * the first non-inline ancestor so we never read attributes off the surrounding
 * paragraph / list item.
 */
function sourceCandidates(node: Element): Element[] {
  const candidates: Element[] = [node];
  let el = node.parentElement;
  for (let depth = 0; el && depth < 4; depth++) {
    const isInlineWrapper = el.tagName === 'SPAN' || el.getAttribute('role') === 'math';
    if (!isInlineWrapper) break;
    candidates.push(el);
    el = el.parentElement;
  }
  return candidates;
}

/**
 * Last-resort source recovery for markup we have never seen.
 *
 * ChatGPT has now moved its TeX twice (MathML annotation → `data-math-source`),
 * each time silently breaking every copy path. This pass keys off the *shape*
 * of the value rather than a specific attribute name, so a rename alone no
 * longer breaks copying: on the nearest math elements, take the first
 * attribute whose value either looks like TeX or is mirrored by `aria-label`
 * (a name/label agreement that only a real source produces).
 *
 * Deliberately conservative — returning null (copy does nothing, as today) is
 * strictly better than copying a spoken description or a stray attribute.
 */
function recoverSourceHeuristically(node: Element): string | null {
  for (const el of sourceCandidates(node)) {
    const ariaLabel = el.getAttribute?.('aria-label')?.trim() || '';

    for (const attr of Array.from(el.attributes ?? [])) {
      if (attr.name === 'aria-label' || IGNORED_ATTRIBUTES.has(attr.name)) continue;
      const value = attr.value.trim();
      if (!value || value.length > MAX_SOURCE_LENGTH) continue;
      if (TEX_MARKER.test(value) || (ariaLabel && value === ariaLabel)) {
        return normalizeLatexWhitespace(value);
      }
    }

    if (ariaLabel && ariaLabel.length <= MAX_SOURCE_LENGTH && TEX_MARKER.test(ariaLabel)) {
      return normalizeLatexWhitespace(ariaLabel);
    }
  }

  return null;
}

/**
 * Read the TeX source out of a math node using every known attribute, then the
 * shape-based heuristic. Exported so the click-copy service shares exactly one
 * recovery ladder with the selection-copy path.
 */
export function recoverMathSource(node: Element): string | null {
  for (const attribute of KNOWN_SOURCE_ATTRIBUTES) {
    const own = node.getAttribute?.(attribute)?.trim();
    if (own) return normalizeLatexWhitespace(own);

    const wrapper = node.closest?.(`[${attribute}]`)?.getAttribute(attribute)?.trim();
    if (wrapper) return normalizeLatexWhitespace(wrapper);

    const nested = node.querySelector?.(`[${attribute}]`)?.getAttribute(attribute)?.trim();
    if (nested) return normalizeLatexWhitespace(nested);
  }

  const xtex = node.querySelector?.('annotation[encoding="application/x-tex"]');
  if (xtex?.textContent?.trim()) return normalizeLatexWhitespace(xtex.textContent);

  const anyAnnotation = node.querySelector?.('annotation');
  if (anyAnnotation?.textContent?.trim()) return normalizeLatexWhitespace(anyAnnotation.textContent);

  return recoverSourceHeuristically(node);
}

/**
 * Read the TeX source out of a rendered math node. Returns null when no source
 * is recoverable.
 *
 * Attributes are looked up on the node, on the nearest ancestor carrying them
 * (ChatGPT's wrapper sits *above* `.katex-display` / `.katex`, so a
 * `querySelector` would never find it) and on descendants. Inside a cloned
 * selection fragment `closest` simply stops at the fragment root, so a
 * selection that starts mid-formula degrades to the next strategy instead of
 * picking up a neighbouring formula's source.
 */
export function extractLatexFromNode(node: Element): string | null {
  return recoverMathSource(node);
}

/** Whether a rendered math node is a block/display formula. */
export function isDisplayMath(node: Element): boolean {
  if (node.closest?.('.katex-display, .math-block')) return true;
  if (node.classList?.contains('katex-display') || node.classList?.contains('math-block')) {
    return true;
  }
  // ChatGPT's semantic wrapper is the ancestor of `.katex-display`, so the
  // display marker is a descendant rather than an ancestor here.
  if (node.querySelector?.('.katex-display')) return true;
  if (node.querySelector?.('math[display="block"]')) return true;
  // Fallback for markup we don't recognise: ChatGPT marks a block formula by
  // setting `display:block` inline on the `[role="math"]` wrapper. Reading only
  // the inline style (not the computed one) keeps this from firing on inline
  // math that merely sits in a block context.
  const semanticRoot = node.closest?.('[role="math"]');
  if (semanticRoot instanceof HTMLElement && semanticRoot.style.display === 'block') return true;
  return false;
}

/** Default delimiter wrapper: `$…$` inline, `$$…$$` display. */
export function wrapLatexDefault(latex: string, display: boolean): string {
  return display ? `$$${latex}$$` : `$${latex}$`;
}

/**
 * Math containers ordered outer-first, so replacing one collapses everything
 * nested inside it. ChatGPT's `[data-math-source]` / `[role="math"]` wrapper is
 * the outermost node of a formula (it contains `.katex-display` / `.katex`), so
 * it leads. `[role="math"]` is the renderer-agnostic entry: it keeps detection
 * working even if the source attribute is renamed again.
 */
const MATH_CONTAINER_SELECTORS = [
  '[data-math-source]',
  '[role="math"]',
  '.katex-display',
  '.math-block',
  '.math-inline',
  '.katex',
  '[data-math]',
];

/** Selector matching every rendered-math container we know how to recover. */
export const MATH_NODE_SELECTOR = MATH_CONTAINER_SELECTORS.join(', ');

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

  // Outer-first: ChatGPT's source wrapper, then display wrappers, then legacy
  // block/inline containers, then any bare `.katex` / `[data-math]` still
  // standing. querySelectorAll is re-evaluated each call, so nodes detached by
  // an earlier pass drop out.
  for (const selector of MATH_CONTAINER_SELECTORS) {
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
