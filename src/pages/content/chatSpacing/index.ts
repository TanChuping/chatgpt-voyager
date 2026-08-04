/** Setting-loaded ChatGPT message line-height and paragraph-spacing overrides. */

const LINE_STYLE_ID = 'gpt-voyager-chat-line-height';
const PARAGRAPH_STYLE_ID = 'gpt-voyager-chat-paragraph-spacing';

const LINE_ENABLED_KEY = 'gvChatLineHeightEnabled';
const LINE_VALUE_KEY = 'gvChatLineHeight';
const PARAGRAPH_ENABLED_KEY = 'gvChatParagraphSpacingEnabled';
const PARAGRAPH_VALUE_KEY = 'gvChatParagraphSpacing';

const LINE_DEFAULT = 160;
const LINE_MIN = 120;
const LINE_MAX = 220;
const PARAGRAPH_DEFAULT = 12;
const PARAGRAPH_MIN = 0;
const PARAGRAPH_MAX = 32;

const SETTING_KEYS = [
  LINE_ENABLED_KEY,
  LINE_VALUE_KEY,
  PARAGRAPH_ENABLED_KEY,
  PARAGRAPH_VALUE_KEY,
] as const;

let started = false;
let generation = 0;
let settingsRevision = 0;
let lineEnabled = false;
let lineValue = LINE_DEFAULT;
let paragraphEnabled = false;
let paragraphValue = PARAGRAPH_DEFAULT;
let storageChangeHandler:
  | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
  | null = null;

function normalize(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function ensureStyle(id: string): HTMLStyleElement {
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = id;
    document.head.appendChild(style);
  }
  return style;
}

function removeStyle(id: string): void {
  document.getElementById(id)?.remove();
}

function renderLineHeight(): void {
  if (!lineEnabled) {
    removeStyle(LINE_STYLE_ID);
    return;
  }

  const value = normalize(lineValue, LINE_DEFAULT, LINE_MIN, LINE_MAX) / 100;
  ensureStyle(LINE_STYLE_ID).textContent = `
    [data-message-author-role="user"] :is(.whitespace-pre-wrap, p, li, td, th, blockquote, pre, code),
    [data-message-author-role="assistant"] :is(.markdown, .prose, p, li, td, th, blockquote, pre, code) {
      line-height: ${value} !important;
    }
  `;
}

function renderParagraphSpacing(): void {
  if (!paragraphEnabled) {
    removeStyle(PARAGRAPH_STYLE_ID);
    return;
  }

  const value = normalize(
    paragraphValue,
    PARAGRAPH_DEFAULT,
    PARAGRAPH_MIN,
    PARAGRAPH_MAX,
  );
  ensureStyle(PARAGRAPH_STYLE_ID).textContent = `
    [data-message-author-role] :is(.markdown, .prose, .whitespace-pre-wrap)
      > :is(p, ul, ol, blockquote, pre, table)
      + :is(p, ul, ol, blockquote, pre, table) {
      margin-top: ${value}px !important;
    }
  `;
}

function applySettings(settings: Record<string, unknown>): void {
  lineEnabled = settings[LINE_ENABLED_KEY] === true;
  lineValue = normalize(settings[LINE_VALUE_KEY], LINE_DEFAULT, LINE_MIN, LINE_MAX);
  paragraphEnabled = settings[PARAGRAPH_ENABLED_KEY] === true;
  paragraphValue = normalize(
    settings[PARAGRAPH_VALUE_KEY],
    PARAGRAPH_DEFAULT,
    PARAGRAPH_MIN,
    PARAGRAPH_MAX,
  );
  renderLineHeight();
  renderParagraphSpacing();
}

function loadCurrentSettings(activeGeneration: number, requestedRevision: number): void {
  chrome.storage?.sync?.get([...SETTING_KEYS], (settings) => {
    if (!started || activeGeneration !== generation) return;
    if (requestedRevision !== settingsRevision) {
      loadCurrentSettings(activeGeneration, settingsRevision);
      return;
    }
    applySettings(settings ?? {});
  });
}

export function stopChatSpacingAdjuster(): void {
  if (!started) return;
  started = false;
  generation += 1;
  removeStyle(LINE_STYLE_ID);
  removeStyle(PARAGRAPH_STYLE_ID);
  if (storageChangeHandler) {
    chrome.storage?.onChanged?.removeListener(storageChangeHandler);
    storageChangeHandler = null;
  }
  lineEnabled = false;
  paragraphEnabled = false;
}

export function startChatSpacingAdjuster(): void {
  if (started) return;
  started = true;
  const activeGeneration = ++generation;

  storageChangeHandler = (changes, areaName) => {
    if (!started || areaName !== 'sync') return;
    if (!SETTING_KEYS.some((key) => changes[key] !== undefined)) return;
    settingsRevision += 1;
    loadCurrentSettings(activeGeneration, settingsRevision);
  };
  chrome.storage?.onChanged?.addListener(storageChangeHandler);
  loadCurrentSettings(activeGeneration, settingsRevision);
}
