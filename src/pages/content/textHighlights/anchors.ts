export const HIGHLIGHTS_PREFIX = 'gptTextHighlights:';
export const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink'] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

export interface TextAnchor {
  start: number;
  end: number;
  quote: string;
}

export interface TextHighlight extends TextAnchor {
  id: string;
  messageId: string;
  color: HighlightColor;
  note: string;
  updatedAt: number;
  conversationTitle?: string;
  conversationUrl?: string;
  turnId?: string;
}

export function readHighlights(key: string): TextHighlight[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(value)) {
      return value.filter(
        (record): record is TextHighlight =>
          record &&
          typeof record.id === 'string' &&
          typeof record.messageId === 'string' &&
          Number.isSafeInteger(record.start) &&
          record.start >= 0 &&
          typeof record.quote === 'string' &&
          record.quote.trim().length > 0 &&
          record.end === record.start + record.quote.length &&
          HIGHLIGHT_COLORS.includes(record.color) &&
          typeof record.note === 'string' &&
          Number.isFinite(record.updatedAt),
      );
    }
  } catch {
    // A damaged record or inaccessible storage should not affect the conversation.
  }
  return [];
}

export function captureTextAnchor(root: Element, selection: Range): TextAnchor | null {
  if (!root.contains(selection.startContainer) || !root.contains(selection.endContainer))
    return null;
  const quote = selection.toString();
  if (!quote.trim()) return null;
  const before = root.ownerDocument.createRange();
  before.selectNodeContents(root);
  before.setEnd(selection.startContainer, selection.startOffset);
  const start = before.toString().length;
  return { start, end: start + quote.length, quote };
}

export function resolveTextAnchor(root: Element, anchor: TextAnchor): Range | null {
  const text = root.textContent ?? '';
  let start = anchor.start;
  if (text.slice(start, anchor.end) !== anchor.quote) {
    start = text.indexOf(anchor.quote);
    if (start < 0 || text.indexOf(anchor.quote, start + 1) !== -1) return null;
  }
  const end = start + anchor.quote.length;
  const document = root.ownerDocument;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const next = offset + (node as Text).length;
    if (start >= offset && start < next) range.setStart(node, start - offset);
    if (end > offset && end <= next) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset = next;
  }
  return null;
}
