/**
 * Adjusts spacing between GPT-Voyager folders and conversation rows.
 */

const STYLE_ID = 'gv-folder-spacing-style';
const STORAGE_KEY = 'gvFolderSpacing';
const DEFAULT_SPACING = 2;
const MIN_SPACING = 0;
const MAX_SPACING = 16;

function clamp(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPACING;
  return Math.min(MAX_SPACING, Math.max(MIN_SPACING, Math.round(value)));
}

function applySpacing(spacing: number) {
  const clamped = clamp(spacing);
  const vPad = Math.max(4, Math.round(4 + clamped * 0.5));

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }

  style.textContent = `
    .gv-folder-list,
    .gv-folder-content {
      gap: ${clamped}px !important;
    }
    .gv-folder-item-header,
    .gv-folder-conversation {
      padding-top: ${vPad}px !important;
      padding-bottom: ${vPad}px !important;
    }
  `;
}

function removeStyles() {
  document.getElementById(STYLE_ID)?.remove();
}

export function startFolderSpacingAdjuster() {
  let currentSpacing = DEFAULT_SPACING;

  chrome.storage?.sync?.get({ [STORAGE_KEY]: DEFAULT_SPACING }, (res) => {
    const stored = res?.[STORAGE_KEY];
    if (typeof stored === 'number') {
      currentSpacing = clamp(stored);
    }
    applySpacing(currentSpacing);
  });

  const storageChangeHandler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area === 'sync' && changes[STORAGE_KEY]) {
      const newValue = changes[STORAGE_KEY].newValue;
      if (typeof newValue === 'number') {
        currentSpacing = clamp(newValue);
        applySpacing(currentSpacing);
      }
    }
  };

  chrome.storage?.onChanged?.addListener(storageChangeHandler);

  window.addEventListener(
    'beforeunload',
    () => {
      removeStyles();
      try {
        chrome.storage?.onChanged?.removeListener(storageChangeHandler);
      } catch {
        // Ignore cleanup errors during page teardown.
      }
    },
    { once: true },
  );
}
