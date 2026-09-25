/**
 * Thread-mirror anchors — the isolated-world half of `pageWorld/threadMirror.ts`.
 *
 * ChatGPT's 2026-09 layout virtualises whole exchanges without leaving any
 * placeholder, so the page-world mirror writes one invisible, absolutely
 * positioned anchor per loaded exchange into the virtual list's container:
 *
 *   div[data-gv-thread-anchor="<user message uuid>"][data-turn-id="u-<uuid>"]
 *      data-gv-text="<user message>" data-gv-attachments='["a.pdf"]'
 *
 * The anchor is the timeline's marker element (stable geometry, exists for
 * every loaded turn). The mounted row, when there is one, is
 * `div[data-turn-key="<uuid>"]` and holds both the user message and the reply.
 *
 * The page-world mirror keeps its own copy of the attribute name (it must not
 * import anything — see the note in threadMirror.ts); keep the two in sync.
 */

export const THREAD_ANCHOR_ATTR = 'data-gv-thread-anchor';
export const THREAD_ANCHOR_SELECTOR = `div[${THREAD_ANCHOR_ATTR}]`;
/** One mounted exchange (user message + reply) in the 2026-09 layout. */
export const THREAD_ROW_SELECTOR = '[data-turn-key]';

export function isThreadAnchor(element: Element | null | undefined): boolean {
  return !!element && element.hasAttribute(THREAD_ANCHOR_ATTR);
}

export function threadAnchorKey(anchor: Element): string {
  return anchor.getAttribute(THREAD_ANCHOR_ATTR) ?? '';
}

export function threadAnchorText(anchor: Element): string {
  return anchor.getAttribute('data-gv-text') ?? '';
}

export function threadAnchorAttachmentNames(anchor: Element): string[] {
  const raw = anchor.getAttribute('data-gv-attachments');
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

/** The mounted row for an anchor, or null while ChatGPT has it virtualised. */
export function findThreadRow(anchor: Element): HTMLElement | null {
  const key = threadAnchorKey(anchor);
  if (!key) return null;
  try {
    return document.querySelector<HTMLElement>(
      `${THREAD_ROW_SELECTOR}[data-turn-key="${CSS.escape(key)}"]`,
    );
  } catch {
    return null;
  }
}

/** Reply blocks inside a mounted row (search units are tagged `…:assistant`). */
export function threadAssistantParts(row: Element): HTMLElement[] {
  return Array.from(
    row.querySelectorAll<HTMLElement>(
      '[data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"]',
    ),
  );
}
