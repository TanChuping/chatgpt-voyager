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
 * Strategy: the live DOM still holds every formula's true source in its KaTeX
 * `annotation` (or legacy `data-math`). We collect those exact source strings
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
function collectSources(): string[] {
  const set = new Set<string>();
  try {
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
 * Rewrite the broken delimiters around known formula sources.
 * `html` mode makes the whitespace matcher `<br>`-aware and escapes the
 * source the way the markup does, so it also lands in the text/html payload.
 */
export function fixDelimiters(input: string, sources: string[], html: boolean): string {
  if (!input || sources.length === 0) return input;
  const gap = html ? '(?:\\s|<br\\s*/?>|&nbsp;)*' : '\\s*';
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
    out = out.replace(new RegExp(`\\\\?\\[${gap}${body}${gap}\\\\?\\]`, 'g'), () => displayRepl);
    // Inline: ( … )
    out = out.replace(new RegExp(`\\\\?\\(${gap}${body}${gap}\\\\?\\)`, 'g'), () => inlineRepl);
  }

  return out;
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
