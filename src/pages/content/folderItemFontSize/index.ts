const STYLE_ID = 'gv-folder-item-font-size-style';
const STORAGE_KEY = 'gvFolderItemFontSize';
const DEFAULT_SIZE = 13;
const MIN_SIZE = 12;
const MAX_SIZE = 18;

let activeCleanup: (() => void) | null = null;

function clamp(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_SIZE;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(numeric)));
}

function applyFontSize(size: number): void {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = `
    .gv-folder-container .gv-folder-name,
    .gv-folder-container .gv-conversation-title {
      font-size: ${size}px !important;
      line-height: ${Math.round(size * 1.3)}px !important;
    }
  `;
}

export function stopFolderItemFontSizeAdjuster(): void {
  activeCleanup?.();
}

export function startFolderItemFontSizeAdjuster(): () => void {
  if (activeCleanup) return activeCleanup;
  let disposed = false;
  const onStorageChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (disposed || areaName !== 'sync' || !changes[STORAGE_KEY]) return;
    applyFontSize(clamp(changes[STORAGE_KEY].newValue));
  };
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    document.getElementById(STYLE_ID)?.remove();
    chrome.storage?.onChanged?.removeListener(onStorageChanged);
    if (activeCleanup === cleanup) activeCleanup = null;
  };
  activeCleanup = cleanup;
  chrome.storage?.sync?.get({ [STORAGE_KEY]: DEFAULT_SIZE }, (result) => {
    if (!disposed) applyFontSize(clamp(result?.[STORAGE_KEY]));
  });
  chrome.storage?.onChanged?.addListener(onStorageChanged);
  return cleanup;
}
