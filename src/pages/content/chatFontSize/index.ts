/**
 * Adjusts the chat message font size based on user settings (stored as percentage)
 */
import { addPageExitListener } from '@/core/utils/pageLifecycle';

const STYLE_ID = 'gpt-voyager-chat-font-size';
const CODE_STYLE_ID = 'gpt-voyager-code-font-size';
const DEFAULT_PERCENT = 100;
const MIN_PERCENT = 80;
const MAX_PERCENT = 150;

const ENABLED_KEY = 'gvChatFontSizeEnabled';
const VALUE_KEY = 'gvChatFontSize';
const CODE_ENABLED_KEY = 'gvCodeFontSizeEnabled';
const CODE_VALUE_KEY = 'gvCodeFontSize';

const clampPercent = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

const normalizePercent = (value: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback;
  return clampPercent(value, MIN_PERCENT, MAX_PERCENT);
};

function applyFontSize(percent: number) {
  const normalized = normalizePercent(percent, DEFAULT_PERCENT);
  const sizeValue = `${normalized}%`;

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }

  style.textContent = `
    /*
     * Scale mutually-exclusive non-code text roots. The assistant selector
     * deliberately lands on innermost text blocks instead of .markdown/.prose:
     * code blocks live inside those containers and have an independent scale.
     * No percentage-sized text root may therefore contain a code-size root.
    */
    [data-message-author-role="user"]:not(:has(pre, .cm-content)),
    [data-message-author-role="assistant"] :is(p, li, td, th, blockquote, .whitespace-pre-wrap):not(pre *, .cm-content *):not(:has(p, li, td, th, blockquote, .whitespace-pre-wrap, pre, .cm-content)),
    [data-message-author-role="assistant"] :is(.markdown, .prose):not(:is(.markdown, .prose) :is(.markdown, .prose)):not(:has(p, li, td, th, blockquote, .whitespace-pre-wrap, pre, .cm-content)) {
      font-size: ${sizeValue} !important;
    }
  `;
}

function applyCodeFontSize(percent: number) {
  const normalized = normalizePercent(percent, DEFAULT_PERCENT);
  const sizeValue = `${normalized}%`;

  let style = document.getElementById(CODE_STYLE_ID) as HTMLStyleElement;
  if (!style) {
    style = document.createElement('style');
    style.id = CODE_STYLE_ID;
    document.head.appendChild(style);
  }

  style.textContent = `
    /* Scale each code-block root once; its code/span descendants inherit. */
    pre.cm-content,
    .cm-content:not(pre .cm-content),
    code-block pre,
    .code-container pre,
    .formatted-code-block-internal-container pre,
    [data-message-author-role] pre {
      font-size: ${sizeValue} !important;
    }

    pre.cm-content code,
    pre.cm-content span,
    .cm-content code,
    .cm-content span,
    code-block pre code,
    code-block pre span,
    .code-container pre code,
    .code-container pre span,
    .formatted-code-block-internal-container pre code,
    .formatted-code-block-internal-container pre span,
    [data-message-author-role] pre code,
    [data-message-author-role] pre span {
      font-size: inherit !important;
    }
  `;
}

function removeStyles() {
  const style = document.getElementById(STYLE_ID);
  if (style) {
    style.remove();
  }
}

function removeCodeStyles() {
  const style = document.getElementById(CODE_STYLE_ID);
  if (style) {
    style.remove();
  }
}

type FontSettingKey =
  | typeof VALUE_KEY
  | typeof ENABLED_KEY
  | typeof CODE_VALUE_KEY
  | typeof CODE_ENABLED_KEY;

const FONT_SETTING_KEYS: FontSettingKey[] = [
  VALUE_KEY,
  ENABLED_KEY,
  CODE_VALUE_KEY,
  CODE_ENABLED_KEY,
];

let started = false;
let active = false;
let lifecycleGeneration = 0;
let settingsRevision = 0;
let settingRevisions: Record<FontSettingKey, number> = {
  [VALUE_KEY]: 0,
  [ENABLED_KEY]: 0,
  [CODE_VALUE_KEY]: 0,
  [CODE_ENABLED_KEY]: 0,
};
let currentPercent = DEFAULT_PERCENT;
let enabled = false;
let currentCodePercent = DEFAULT_PERCENT;
let codeEnabled = false;
let storageChangeHandler:
  | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
  | null = null;
let removePageExitListener: (() => void) | null = null;

function updatePageExitListener(): void {
  const needsLifecycleCleanup = enabled || codeEnabled;
  if (needsLifecycleCleanup && !removePageExitListener) {
    removePageExitListener = addPageExitListener(stopChatFontSizeAdjuster);
  } else if (!needsLifecycleCleanup && removePageExitListener) {
    removePageExitListener();
    removePageExitListener = null;
  }
}

function applySettingValue(key: FontSettingKey, value: unknown): void {
  switch (key) {
    case VALUE_KEY: {
      const normalized = normalizePercent(
        typeof value === 'number' ? value : DEFAULT_PERCENT,
        DEFAULT_PERCENT,
      );
      currentPercent = normalized;
      if (enabled) applyFontSize(currentPercent);
      if (typeof value === 'number' && value !== normalized) {
        try {
          chrome.storage?.sync?.set({ [VALUE_KEY]: normalized });
        } catch {}
      }
      break;
    }
    case ENABLED_KEY: {
      const wasEnabled = enabled;
      enabled = value === true;
      if (enabled) applyFontSize(currentPercent);
      else if (wasEnabled) removeStyles();
      break;
    }
    case CODE_VALUE_KEY: {
      const normalized = normalizePercent(
        typeof value === 'number' ? value : DEFAULT_PERCENT,
        DEFAULT_PERCENT,
      );
      currentCodePercent = normalized;
      if (codeEnabled) applyCodeFontSize(currentCodePercent);
      if (typeof value === 'number' && value !== normalized) {
        try {
          chrome.storage?.sync?.set({ [CODE_VALUE_KEY]: normalized });
        } catch {}
      }
      break;
    }
    case CODE_ENABLED_KEY: {
      const wasEnabled = codeEnabled;
      codeEnabled = value === true;
      if (codeEnabled) applyCodeFontSize(currentCodePercent);
      else if (wasEnabled) removeCodeStyles();
      break;
    }
  }
}

export function stopChatFontSizeAdjuster(): void {
  if (!started && !active) return;

  active = false;
  lifecycleGeneration += 1;
  removeStyles();
  removeCodeStyles();

  if (storageChangeHandler) {
    try {
      chrome.storage?.onChanged?.removeListener(storageChangeHandler);
    } catch {}
    storageChangeHandler = null;
  }

  if (removePageExitListener) {
    removePageExitListener();
    removePageExitListener = null;
  }

  started = false;
  enabled = false;
  codeEnabled = false;
}

export function startChatFontSizeAdjuster() {
  if (started) return;
  started = true;
  active = true;
  const generation = ++lifecycleGeneration;
  const requestRevision = settingsRevision;

  // Listen for changes from storage
  storageChangeHandler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (!active || area !== 'sync') return;

    const changedKeys = FONT_SETTING_KEYS.filter((key) => changes[key] !== undefined);
    if (changedKeys.length === 0) return;

    const revision = ++settingsRevision;
    for (const key of changedKeys) {
      settingRevisions[key] = revision;
      applySettingValue(key, changes[key].newValue);
    }
    updatePageExitListener();
  };

  chrome.storage?.onChanged?.addListener(storageChangeHandler);

  // Load the initial state after installing the listener. Per-key revisions
  // let an in-flight snapshot fill unchanged fields without overwriting a
  // newer onChanged value for another field.
  chrome.storage?.sync?.get(FONT_SETTING_KEYS, (res) => {
    if (!active || generation !== lifecycleGeneration) return;

    for (const key of FONT_SETTING_KEYS) {
      if (settingRevisions[key] <= requestRevision) {
        applySettingValue(key, res?.[key]);
      }
    }
    updatePageExitListener();
  });
}
