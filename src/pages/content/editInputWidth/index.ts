/**
 * "Composer width" (popup: 输入框宽度): the bottom composer, and the inline
 * editor used to edit a sent message, as a share of the thread pane.
 *
 * 2026-09 app shell: the composer's width host defines its column through
 * `--thread-content-responsive-max-width` (see chatgptDom); this rule is more
 * specific than the chat-width setting's, so while it is on the composer
 * follows this slider and otherwise follows the chat width. Like chat width it
 * is container-relative (`cqi`) and subtracts the thread scroller's gutter, so
 * equal percentages line up with the messages. The inline editor is a <form>
 * inside the user message block, centred on the column at the same width.
 * The 2026-07 textarea rules and the Gemini-era `.edit-mode` rules remain.
 */
import { addPageExitListener } from '@/core/utils/pageLifecycle';

import { COMPOSER_WIDTH_HOST_SELECTOR, measureThreadGutter } from '../chatgptDom';

const STYLE_ID = 'gpt-voyager-edit-input-width';
const VALUE_KEY = 'gptEditInputWidth';
const ENABLED_KEY = 'gvEditInputWidthEnabled';
const DEFAULT_PERCENT = 60;
const MIN_PERCENT = 30;
const MAX_PERCENT = 100;
const LEGACY_BASELINE_PX = 1200;

const CURRENT_EDIT_TURN_SELECTOR =
  'section[data-testid^="conversation-turn"][data-turn="user"]:has(textarea)';

const clampPercent = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

const normalizePercent = (value: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback;
  if (value > MAX_PERCENT) {
    return clampPercent((value / LEGACY_BASELINE_PX) * 100, MIN_PERCENT, MAX_PERCENT);
  }
  return clampPercent(value, MIN_PERCENT, MAX_PERCENT);
};

let threadGutterPx: number | null = null;
let gutterObserver: MutationObserver | null = null;
let gutterTimer: number | null = null;

function buildStyle(percent: number): string {
  const fraction = percent / 100;
  const widthValue = `${percent}vw`;
  const gutter = threadGutterPx ?? 0;
  return `
    /* 2026-09 bottom composer. */
    ${COMPOSER_WIDTH_HOST_SELECTOR} {
      --thread-content-responsive-max-width: calc((100cqi - ${gutter}px) * ${fraction});
    }

    /* 2026-09 inline user-message editor. */
    [data-message-author-role="user"] form {
      --gv-edit-input-width: min(calc(100cqi * ${fraction}), calc(100cqi - 32px));
      box-sizing: border-box !important;
      width: var(--gv-edit-input-width) !important;
      max-width: none !important;
      margin-left: calc((100% - var(--gv-edit-input-width)) / 2) !important;
      margin-right: calc((100% - var(--gv-edit-input-width)) / 2) !important;
    }

    /* 2026-07 inline user-message editor. */
    ${CURRENT_EDIT_TURN_SELECTOR} [data-conversation-screenshot-content],
    ${CURRENT_EDIT_TURN_SELECTOR} [class*="group/turn-messages"] {
      max-width: ${widthValue} !important;
      width: min(100%, ${widthValue}) !important;
      margin-left: auto !important;
      margin-right: auto !important;
    }

    ${CURRENT_EDIT_TURN_SELECTOR} textarea {
      box-sizing: border-box !important;
      max-width: 100% !important;
      width: 100% !important;
    }

    /* Legacy Gemini/Angular inline edit compatibility. */
    .query-content.edit-mode,
    div.edit-mode,
    .edit-mode .edit-container {
      max-width: ${widthValue} !important;
      width: min(100%, ${widthValue}) !important;
      margin-left: auto !important;
      margin-right: auto !important;
    }

    .edit-mode .mat-mdc-form-field,
    .edit-mode .mat-mdc-text-field-wrapper,
    .edit-mode .mat-mdc-form-field-flex,
    .edit-mode .mat-mdc-form-field-infix,
    .edit-mode .mdc-text-field,
    .edit-mode .edit-form,
    .edit-mode textarea,
    .edit-mode .mat-mdc-input-element,
    .edit-mode .cdk-textarea-autosize {
      box-sizing: border-box !important;
      max-width: 100% !important;
      width: 100% !important;
    }
  `;
}

function applyWidth(widthPercent: number): void {
  threadGutterPx = measureThreadGutter() ?? threadGutterPx;
  const css = buildStyle(normalizePercent(widthPercent, DEFAULT_PERCENT));
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  // Rewriting a stylesheet re-matches every rule on the page; skip no-ops.
  if (style.textContent !== css) style.textContent = css;
  if (threadGutterPx === null) watchForThreadGutter();
}

function stopWatchingThreadGutter(): void {
  gutterObserver?.disconnect();
  gutterObserver = null;
  if (gutterTimer !== null) window.clearTimeout(gutterTimer);
  gutterTimer = null;
}

/** Only until a thread is open: its scroller's gutter is all we need from the DOM. */
function watchForThreadGutter(): void {
  if (gutterObserver) return;
  gutterObserver = new MutationObserver(() => {
    if (gutterTimer !== null) return;
    gutterTimer = window.setTimeout(() => {
      gutterTimer = null;
      const gutter = measureThreadGutter();
      if (gutter === null) return;
      stopWatchingThreadGutter();
      threadGutterPx = gutter;
      if (enabled) applyWidth(currentWidthPercent);
    }, 300);
  });
  gutterObserver.observe(document.body, { childList: true, subtree: true });
}

function removeStyles(): void {
  stopWatchingThreadGutter();
  document.getElementById(STYLE_ID)?.remove();
}

type StorageChangeHandler = (
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
) => void;

let started = false;
let active = false;
let lifecycleGeneration = 0;
let settingsRevision = 0;
let widthRevision = 0;
let enabledRevision = 0;
let currentWidthPercent = DEFAULT_PERCENT;
let enabled = false;
let storageChangeHandler: StorageChangeHandler | null = null;
let removePageExitListener: (() => void) | null = null;

function persistSyncValue(value: Record<string, unknown>): void {
  try {
    chrome.storage?.sync?.set(value);
  } catch {
    // A torn-down extension context cannot be repaired from the page.
  }
}

function updatePageExitListener(): void {
  if (enabled && !removePageExitListener) {
    removePageExitListener = addPageExitListener(stopEditInputWidthAdjuster);
  } else if (!enabled && removePageExitListener) {
    removePageExitListener();
    removePageExitListener = null;
  }
}

function applyStoredWidth(value: unknown): void {
  const normalized = normalizePercent(
    typeof value === 'number' ? value : DEFAULT_PERCENT,
    DEFAULT_PERCENT,
  );
  currentWidthPercent = normalized;
  if (enabled) applyWidth(currentWidthPercent);

  if (typeof value === 'number' && value !== normalized) {
    persistSyncValue({ [VALUE_KEY]: normalized });
  }
}

function applyEnabled(value: unknown): void {
  enabled = value === true;
  if (enabled) applyWidth(currentWidthPercent);
  else removeStyles();
  updatePageExitListener();
}

export function stopEditInputWidthAdjuster(): void {
  if (!started && !active) return;

  active = false;
  lifecycleGeneration += 1;
  removeStyles();

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
  currentWidthPercent = DEFAULT_PERCENT;
}

/**
 * Starts the setting bridge. CSS handles future composers and editors by
 * itself; the only DOM watch is the one-off gutter measurement above.
 */
export function startEditInputWidthAdjuster(): () => void {
  if (started) return stopEditInputWidthAdjuster;

  started = true;
  active = true;
  const generation = ++lifecycleGeneration;
  const requestRevision = settingsRevision;

  storageChangeHandler = (changes, area) => {
    if (!active || area !== 'sync') return;

    if (changes[VALUE_KEY] !== undefined) {
      widthRevision = ++settingsRevision;
      applyStoredWidth(changes[VALUE_KEY].newValue);
    }

    if (changes[ENABLED_KEY] !== undefined) {
      enabledRevision = ++settingsRevision;
      applyEnabled(changes[ENABLED_KEY].newValue);
    }
  };

  chrome.storage?.onChanged?.addListener(storageChangeHandler);

  try {
    chrome.storage?.sync?.get([VALUE_KEY, ENABLED_KEY], (result) => {
      if (!active || generation !== lifecycleGeneration) return;

      const storedWidth = result?.[VALUE_KEY];
      if (widthRevision <= requestRevision) applyStoredWidth(storedWidth);

      if (enabledRevision <= requestRevision) {
        const storedEnabled = result?.[ENABLED_KEY];
        const migratedEnabled =
          storedEnabled === undefined &&
          typeof storedWidth === 'number' &&
          normalizePercent(storedWidth, DEFAULT_PERCENT) !== DEFAULT_PERCENT;

        applyEnabled(storedEnabled === true || migratedEnabled);
        if (migratedEnabled) persistSyncValue({ [ENABLED_KEY]: true });
      }
    });
  } catch {
    // Keep the storage listener available if the initial read races teardown.
  }

  return stopEditInputWidthAdjuster;
}
