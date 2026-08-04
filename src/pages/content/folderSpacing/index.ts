/**
 * Adjusts spacing between GPT-Voyager folders and conversation rows.
 */

const STYLE_ID = 'gv-folder-spacing-style';
const STORAGE_KEY = 'gvFolderSpacing';
const DEFAULT_SPACING = 2;
const MIN_SPACING = 0;
const MAX_SPACING = 16;

let activeCleanup: (() => void) | null = null;

function clamp(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPACING;
  return Math.min(MAX_SPACING, Math.max(MIN_SPACING, Math.round(value)));
}

function applySpacing(spacing: number) {
  const clamped = clamp(spacing);
  // The stored default remains 2 for compatibility, but its visual baseline
  // matches ChatGPT's native 36px rows with no inter-row gap.
  const rowGap = Math.max(0, clamped - DEFAULT_SPACING);
  const vPad = Math.max(4, Math.round(5 + clamped * 0.5));

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }

  style.textContent = `
    .gv-folder-list,
    .gv-folder-content {
      gap: ${rowGap}px !important;
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

export function stopFolderSpacingAdjuster(): void {
  activeCleanup?.();
}

export function startFolderSpacingAdjuster(): () => void {
  if (activeCleanup) return activeCleanup;

  let currentSpacing = DEFAULT_SPACING;
  let disposed = false;

  const storageChangeHandler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (disposed || area !== 'sync' || !changes[STORAGE_KEY]) return;

    const newValue = changes[STORAGE_KEY].newValue;
    if (typeof newValue === 'number') {
      currentSpacing = clamp(newValue);
      applySpacing(currentSpacing);
    }
  };

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    removeStyles();
    window.removeEventListener('beforeunload', cleanup);
    try {
      chrome.storage?.onChanged?.removeListener(storageChangeHandler);
    } catch {
      // Ignore cleanup errors while the extension context is being torn down.
    }
    if (activeCleanup === cleanup) activeCleanup = null;
  };

  activeCleanup = cleanup;

  chrome.storage?.sync?.get({ [STORAGE_KEY]: DEFAULT_SPACING }, (res) => {
    if (disposed) return;
    const stored = res?.[STORAGE_KEY];
    if (typeof stored === 'number') {
      currentSpacing = clamp(stored);
    }
    applySpacing(currentSpacing);
  });

  chrome.storage?.onChanged?.addListener(storageChangeHandler);
  window.addEventListener('beforeunload', cleanup, { once: true });

  return cleanup;
}
