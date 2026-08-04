/**
 * Adjusts only the inline user-message editor width.
 *
 * Current ChatGPT renders that editor as a textarea inside a conversation
 * turn. The bottom unified composer is intentionally outside this feature.
 * Named `.edit-mode` rules remain as lightweight Gemini-era compatibility.
 */

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

function applyWidth(widthPercent: number): void {
  const widthValue = `${normalizePercent(widthPercent, DEFAULT_PERCENT)}vw`;

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }

  style.textContent = `
    /* Current ChatGPT inline user-message editor. */
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

function removeStyles(): void {
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
let beforeUnloadHandler: (() => void) | null = null;

function persistSyncValue(value: Record<string, unknown>): void {
  try {
    chrome.storage?.sync?.set(value);
  } catch {
    // A torn-down extension context cannot be repaired from the page.
  }
}

function updateBeforeUnloadHandler(): void {
  if (enabled && !beforeUnloadHandler) {
    beforeUnloadHandler = () => stopEditInputWidthAdjuster();
    window.addEventListener('beforeunload', beforeUnloadHandler, { once: true });
  } else if (!enabled && beforeUnloadHandler) {
    window.removeEventListener('beforeunload', beforeUnloadHandler);
    beforeUnloadHandler = null;
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
  updateBeforeUnloadHandler();
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

  if (beforeUnloadHandler) {
    window.removeEventListener('beforeunload', beforeUnloadHandler);
    beforeUnloadHandler = null;
  }

  started = false;
  enabled = false;
  currentWidthPercent = DEFAULT_PERCENT;
}

/**
 * Starts the setting bridge. CSS handles future edit composers by itself, so
 * this feature never needs a MutationObserver or a DOM rescan.
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
