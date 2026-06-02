/**
 * File-attachment detection for user turns.
 *
 * ChatGPT renders attached files (PDFs, docs, pasted text blobs, …) as a tile
 * inside the user message bubble. The tile carries `role="group"` and an
 * `aria-label` whose value is the original filename. When the timeline extracts
 * a turn summary, those filenames get concatenated with the message body and
 * users find it confusing — the "title" of a turn looks like
 *   "粘贴的文本 (1)(3).txt 文档 看看这个 PDF"
 *
 * This module pulls the attachments out as structured data so the preview UI
 * can render them as a colored chip and leave the body text clean.
 */

export type AttachmentType =
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slide'
  | 'text'
  | 'csv'
  | 'image'
  | 'code'
  | 'archive'
  | 'audio'
  | 'video'
  | 'other';

export interface AttachmentInfo {
  readonly name: string;
  readonly type: AttachmentType;
}

const EXT_TO_TYPE: ReadonlyArray<[RegExp, AttachmentType]> = [
  [/\.pdf$/i, 'pdf'],
  [/\.(docx?|odt|rtf|pages)$/i, 'doc'],
  [/\.(xlsx?|ods|numbers)$/i, 'sheet'],
  [/\.(pptx?|odp|keynote|key)$/i, 'slide'],
  [/\.csv$/i, 'csv'],
  [/\.(txt|md|markdown|log)$/i, 'text'],
  [/\.(png|jpe?g|gif|webp|svg|bmp|tiff?|heic|heif|avif)$/i, 'image'],
  [/\.(mp3|wav|m4a|flac|ogg|opus|aac)$/i, 'audio'],
  [/\.(mp4|mov|avi|mkv|webm|m4v)$/i, 'video'],
  [/\.(zip|tar|gz|7z|rar|bz2)$/i, 'archive'],
  [
    /\.(js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|bash|zsh|json|yaml|yml|toml|ini|sql|html?|css|scss|sass|less|vue|svelte)$/i,
    'code',
  ],
];

export function classifyByName(name: string): AttachmentType {
  const trimmed = name.trim();
  for (const [re, type] of EXT_TO_TYPE) {
    if (re.test(trimmed)) return type;
  }
  return 'other';
}

/**
 * Walk a user-turn element and pull out the attachments ChatGPT rendered into
 * it. Returns them in DOM order, deduplicated by filename.
 */
export function extractAttachments(element: HTMLElement | null): AttachmentInfo[] {
  if (!element) return [];
  const out: AttachmentInfo[] = [];
  const seen = new Set<string>();
  const tiles = element.querySelectorAll<HTMLElement>(
    '[role="group"][aria-label], [class*="file-tile"][aria-label], [data-testid*="file-attachment"]',
  );
  for (const tile of Array.from(tiles)) {
    const raw = (
      tile.getAttribute('aria-label') ||
      tile.getAttribute('aria-roledescription') ||
      ''
    ).trim();
    if (!raw) continue;
    // ChatGPT also uses role=group for sibling-grouping. Heuristic: an
    // attachment tile's aria-label always carries a recognisable file
    // extension or one of ChatGPT's localised attachment markers (e.g.
    // "粘贴的文本", "Pasted text"). Reject anything else.
    const looksLikeFile =
      /\.[A-Za-z0-9]{1,6}(\s|$|[()])/.test(raw) ||
      /^(pasted text|粘贴的文本|paste|file|附件|文档)/i.test(raw);
    if (!looksLikeFile) continue;
    const name = raw.replace(/\s+/g, ' ').trim();
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, type: classifyByName(name) });
  }
  return out;
}

/**
 * For dot tooltips and aria labels: a compact prefix that mirrors what
 * the user sees in the message bubble. Returns "" if there are none.
 */
export function summarizeAttachments(attachments: ReadonlyArray<AttachmentInfo>): string {
  if (!attachments.length) return '';
  return attachments
    .map((a) => `${ATTACHMENT_LABEL[a.type] ?? 'FILE'} · ${truncateName(a.name)}`)
    .join('  ·  ');
}

export const ATTACHMENT_LABEL: Record<AttachmentType, string> = {
  pdf: 'PDF',
  doc: 'DOC',
  sheet: 'XLSX',
  slide: 'PPTX',
  text: 'TXT',
  csv: 'CSV',
  image: 'IMG',
  code: 'CODE',
  archive: 'ZIP',
  audio: 'AUDIO',
  video: 'VIDEO',
  other: 'FILE',
};

/**
 * Color palette mirrors ChatGPT's own file-type accents where they exist
 * (red for PDF, blue for Word, etc.) so the chips feel native rather than
 * a separate visual language. Tuned for both light and dark themes; the
 * actual chip styling layers a tinted background on top of these.
 */
export const ATTACHMENT_COLOR: Record<AttachmentType, string> = {
  pdf: '#dc2626', // red
  doc: '#2563eb', // blue (Word-ish)
  sheet: '#16a34a', // green (Excel-ish)
  slide: '#ea580c', // orange (Powerpoint-ish)
  text: '#6b7280', // gray
  csv: '#15803d', // darker green
  image: '#9333ea', // purple
  code: '#0d9488', // teal
  archive: '#a16207', // amber
  audio: '#db2777', // pink
  video: '#7c3aed', // indigo
  other: '#6b7280', // gray
};

function truncateName(name: string): string {
  // Match user spec: roughly the first 5 chars/glyphs of the filename
  // (stripping the extension first, then re-appending the truncated head).
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  if (chineseCharCount(stem) <= 5 && stem.length <= 12) return name;
  const head = sliceGlyphs(stem, 5);
  return `${head}…`;
}

function chineseCharCount(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (/[一-鿿]/.test(ch)) n += 1;
  }
  return n;
}

function sliceGlyphs(s: string, n: number): string {
  const arr: string[] = [];
  for (const ch of s) {
    arr.push(ch);
    if (arr.length >= n) break;
  }
  return arr.join('');
}
