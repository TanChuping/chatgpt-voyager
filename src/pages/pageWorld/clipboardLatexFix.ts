/**
 * Repair math delimiters in ChatGPT's own "copy message" output.
 *
 * Runs in MAIN world (imported by conversationHook.ts at document_start) so it
 * can wrap the *page's* `navigator.clipboard`. ChatGPT's per-message copy
 * button serialises the turn to markdown but strips the backslash off every
 * math delimiter:
 *
 *   \[ x=\frac{-b\pm\sqrt{b^2-4ac}}{2a} \]   →   [ x=\frac{-b\pm\sqrt{b^2-4ac}}{2a} ]
 *   \( e^{i\pi}+1=0 \)                       →   ( e^{i\pi}+1=0 )
 *
 * The LaTeX *body* survives intact; only the delimiters break, so the pasted
 * text no longer renders as math anywhere. (Verified live on chatgpt.com,
 * 2026-06.) This bypasses the `copy` event — it calls `navigator.clipboard`
 * directly — so the selection-copy fix in FormulaCopyService can't catch it.
 *
 * Strategy: the live DOM still holds every formula's true source — on
 * ChatGPT's `data-math-source` wrapper, or in a KaTeX `annotation` / legacy
 * `data-math` for older markup. We collect those exact source strings
 * and, in the clipboard payload, rewrite only the bracket/paren pairs that
 * wrap one of them — `[…]`→`$$…$$`, `(…)`→`$…$`. Because we anchor on the
 * verbatim formula source, ordinary prose brackets/parens are never touched.
 *
 * Fully defensive: any failure falls through to ChatGPT's original clipboard
 * write, so the worst case is the unmodified (mangled) baseline — never worse.
 */

const FLAG = '__gvClipboardLatexHooked';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Only trust a bracket/paren pair around a source if the source actually looks
 * like math. A bare alphanumeric token ("a", "x", "N", "AB") matches ordinary
 * prose like "option (a)", "O(N)", "[x]" far too easily — rewriting those to
 * "$a$" / "O$N$" would corrupt normal copied text (and ChatGPT's code-block
 * copy also flows through this patch). Requiring at least one LaTeX-structural
 * / operator character (backslash, ^, _, {}, =, +, …) eliminates that whole
 * class of false positives. The cost is that a single-letter formula copied via
 * the native button keeps its broken delimiters — but the drag-select path
 * fixes those precisely from the DOM, and a lone "x" is readable regardless.
 */
function looksLikeMath(s: string): boolean {
  return /[^A-Za-z0-9\s]/.test(s);
}

/** Collect the verbatim LaTeX source of every rendered formula on the page. */
export function collectSources(): string[] {
  const set = new Set<string>();
  try {
    // ChatGPT's current KaTeX layout (2026-08) emits no MathML annotation —
    // the raw TeX lives on a `role="math"` wrapper around the rendered spans.
    document.querySelectorAll('[data-math-source]').forEach((el) => {
      const t = (el.getAttribute('data-math-source') || '').trim();
      if (t && looksLikeMath(t)) set.add(t);
    });
    document.querySelectorAll('annotation[encoding="application/x-tex"]').forEach((a) => {
      const t = (a.textContent || '').trim();
      if (t && looksLikeMath(t)) set.add(t);
    });
    document.querySelectorAll('[data-math]').forEach((el) => {
      const t = (el.getAttribute('data-math') || '').trim();
      if (t && looksLikeMath(t)) set.add(t);
    });
  } catch {
    /* ignore */
  }
  // Longest first so a formula that is a substring of another is fixed second.
  return [...set].sort((a, b) => b.length - a.length);
}

/**
 * Never rewrite payloads beyond this size — a pathological page could make the
 * per-source regex passes take long enough to jank the copy gesture, and huge
 * payloads are exactly where a subtle mismatch would do the most damage.
 */
const MAX_REWRITE_LENGTH = 1_000_000;

/**
 * Verify a rewrite only ever touched delimiters. We strip every character the
 * transform is ALLOWED to change — the delimiter alphabet (`$ \ [ ] ( )`), all
 * whitespace, and (html mode) `<br>`/`&nbsp;` — from both input and output; the
 * remainders must be byte-identical. Any difference means the rewrite bled into
 * real content (e.g. ChatGPT changed its copy format under us), so the caller
 * must fall back to the original payload.
 *
 * Additionally reject outputs that introduce a run of 3+ `$` — that's the
 * signature of delimiter soup (`$$$x+p$^2$$`) from a mis-anchored rewrite,
 * which the strip-comparison alone cannot see (all `$` are stripped).
 */
function isSafeRewrite(input: string, output: string, html: boolean): boolean {
  const dollarRuns = (s: string): number => (s.match(/\${3,}/g) || []).length;
  if (dollarRuns(output) > dollarRuns(input)) return false;

  const strip = (s: string): string => {
    let t = s;
    if (html) t = t.replace(/<br\s*\/?>|&nbsp;/gi, '');
    return t.replace(/[\s$\\()[\]]/g, '');
  };
  return strip(input) === strip(output);
}

/**
 * Collapse ChatGPT's corrupted "equals runs" inside display math back to one
 * `=`. When the assistant writes a multi-line `\begin{aligned}...\end{aligned}`,
 * ChatGPT's own copy-to-markdown drops the `\` line breaks and turns the `&=`
 * alignment markers into a RUN of equals signs (confirmed live 2026-07 - this
 * is ChatGPT's own bug, present without the extension too; the true source
 * still lives in the DOM annotation):
 *
 *   $$...\frac{b^2}{4a^2}===============-\frac{c}{a}...$$
 *
 * A run of 3+ `=` is never valid math, so collapsing it to a single `=`
 * recovers a correct, renderable equation without needing the source. Scoped
 * strictly to `$$...$$` / `\[...\]` blocks so prose (setext headings `====`,
 * `---` rules, ASCII art) is never touched. `$$`/`=` are not escaped in either
 * the text/plain or text/html payload, so no html-specific handling is needed.
 */
function collapseMathEqualsRuns(input: string): string {
  if (!input.includes('===')) return input;
  const fixBlock = (body: string): string => body.replace(/={3,}/g, '=');
  return input
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, b: string) => `$$${fixBlock(b)}$$`)
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, b: string) => `\\[${fixBlock(b)}\\]`);
}

/**
 * Rewrite the broken delimiters around known formula sources.
 * `html` mode makes the whitespace matcher `<br>`-aware and escapes the
 * source the way the markup does, so it also lands in the text/html payload.
 *
 * Guardrails (the extension is patching ChatGPT's OWN copy button, so the only
 * acceptable failure mode is ChatGPT's unmodified baseline — never garbage):
 *
 * - Replacements go through opaque placeholder tokens first, so a shorter
 *   source can never match INSIDE an earlier formula's rewritten body (e.g.
 *   sources `(x+p)^2` and `x+p` on the same page used to nest into
 *   `$$$x+p$^2$$`).
 * - After the rewrite, `isSafeRewrite` proves the output differs from the
 *   input only in delimiter/whitespace characters; if ChatGPT ever changes its
 *   copy serialisation in a way that trips the regexes into mangling content,
 *   we return the ORIGINAL payload untouched.
 * - Payloads containing NUL (would collide with the placeholder alphabet) or
 *   larger than MAX_REWRITE_LENGTH are passed through untouched.
 */
export function fixDelimiters(input: string, sources: string[], html: boolean): string {
  if (!input) return input;
  if (input.length > MAX_REWRITE_LENGTH || input.includes('\u0000')) return input;

  const gap = html ? '(?:\\s|<br\\s*/?>|&nbsp;)*' : '\\s*';

  // Stash replacements as `\u0000<n>\u0000` tokens; the token alphabet contains
  // no delimiter/source characters, so later regex passes cannot see into
  // already-rewritten formulas. Restored in one pass at the end.
  const stashed: string[] = [];
  const stash = (replacement: string): string => {
    stashed.push(replacement);
    return `\u0000${stashed.length - 1}\u0000`;
  };

  let out = input;
  for (const src of sources) {
    if (!looksLikeMath(src)) continue; // never rewrite prose like "(a)" / "[x]"
    const prepared = html ? htmlEscape(src) : src;
    // Match the exact source with flexible internal whitespace (the model may
    // pretty-print the annotation differently from the copied body).
    const body = escapeRegExp(prepared).replace(/\s+/g, gap);
    const clean = normalize(src);
    const inlineRepl = html ? `$${htmlEscape(clean)}$` : `$${clean}$`;
    const displayRepl = html ? `$$${htmlEscape(clean)}$$` : `$$${clean}$$`;

    // Display: [ … ]  (optionally still backslash-escaped)
    out = out.replace(new RegExp(`\\\\?\\[${gap}${body}${gap}\\\\?\\]`, 'g'), () =>
      stash(displayRepl),
    );
    // Inline: ( … )
    out = out.replace(new RegExp(`\\\\?\\(${gap}${body}${gap}\\\\?\\)`, 'g'), () =>
      stash(inlineRepl),
    );
  }

  out = out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => stashed[Number(i)] ?? '');

  const repaired = isSafeRewrite(input, out, html) ? out : input;
  // Step 2: fix ChatGPT's own aligned-collapse "=====" corruption inside
  // display math (source-free; runs even when we had no sources to anchor on,
  // because ChatGPT keeps the $$ delimiters and mangles only the body).
  return collapseMathEqualsRuns(repaired);
}

/** Build a replacement ClipboardItem with math delimiters repaired. */
function remapItem(item: ClipboardItem, sources: string[]): ClipboardItem {
  const data: Record<string, Promise<Blob>> = {};
  for (const type of item.types) {
    if (type === 'text/plain' || type === 'text/html') {
      const isHtml = type === 'text/html';
      // Promise<Blob> values keep the write within the user-gesture window.
      data[type] = item
        .getType(type)
        .then((b) => b.text())
        .then((t) => new Blob([fixDelimiters(t, sources, isHtml)], { type }));
    } else {
      data[type] = item.getType(type);
    }
  }
  return new ClipboardItem(data);
}

export function installClipboardLatexFix(): void {
  const w = window as unknown as Record<string, boolean>;
  if (w[FLAG]) return;

  const clip = navigator.clipboard;
  if (!clip) return;
  w[FLAG] = true;

  // ChatGPT copies whole messages via clipboard.write([ClipboardItem …]).
  if (typeof clip.write === 'function') {
    const orig = clip.write.bind(clip);
    clip.write = function gvWrite(items: ClipboardItem[]): Promise<void> {
      try {
        const sources = collectSources();
        if (sources.length === 0) return orig(items);
        return orig(Array.from(items, (it) => remapItem(it, sources)));
      } catch {
        return orig(items);
      }
    };
  }

  // writeText path (older / fallback) — plain string only.
  if (typeof clip.writeText === 'function') {
    const origText = clip.writeText.bind(clip);
    clip.writeText = function gvWriteText(text: string): Promise<void> {
      try {
        const sources = collectSources();
        if (sources.length === 0) return origText(text);
        return origText(fixDelimiters(String(text), sources, false));
      } catch {
        return origText(text);
      }
    };
  }
}
