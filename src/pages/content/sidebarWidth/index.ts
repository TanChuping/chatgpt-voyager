/* Adjust ChatGPT's sidebar through its live --sidebar-width CSS variable. */
import { addPageExitListener } from '@/core/utils/pageLifecycle';

const STYLE_ID = 'gv-sidebar-width-style';
const STORAGE_KEY = 'gptSidebarWidth';
const LEGACY_ENABLED_KEY = 'gvSidebarWidthEnabled';

const DEFAULT_PX = 280;
const MIN_PX = 240;
const MAX_PX = 600;
const LEGACY_BASELINE_PX = 1200;
const LEGACY_MAX_PERCENT = 45;
let started = false;
let lifecycleGeneration = 0;
let storageChangeHandler:
  | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
  | null = null;
let removePageExitListener: (() => void) | null = null;

function isActiveGeneration(generation: number): boolean {
  return started && generation === lifecycleGeneration;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

function normalizeWidth(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_PX;

  // Older builds stored 15–45 as a viewport percentage. The popup now
  // exposes pixels, so migrate those values once and keep one unit end-to-end.
  if (numeric <= LEGACY_MAX_PERCENT) {
    return clamp((numeric / 100) * LEGACY_BASELINE_PX, MIN_PX, MAX_PX);
  }

  return clamp(numeric, MIN_PX, MAX_PX);
}

function buildStyle(width: number): string {
  return `
    :root,
    #stage-slideover-sidebar,
    #stage-slideover-sidebar [style*='--sidebar-width'],
    #stage-slideover-sidebar [class*='w-(--sidebar-width)'] {
      --sidebar-width: ${width}px !important;
    }
  `;
}

function applyWidth(value: unknown): number {
  const width = normalizeWidth(value);
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.documentElement.appendChild(style);
  }
  style.textContent = buildStyle(width);
  return width;
}

function removeStyles(): void {
  document.getElementById(STYLE_ID)?.remove();
}

/**
 * The popup intentionally shows this setting as a plain slider (there is no
 * enable switch), so the selected/default width must always be active.
 * `gvSidebarWidthEnabled` remains readable only for backup compatibility.
 */
export function stopSidebarWidthAdjuster(): void {
  started = false;
  lifecycleGeneration += 1;
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
  removeStyles();
}

export function startSidebarWidthAdjuster(): () => void {
  if (started) return stopSidebarWidthAdjuster;
  started = true;
  const generation = ++lifecycleGeneration;
  chrome.storage?.sync?.get([STORAGE_KEY, LEGACY_ENABLED_KEY], (result) => {
    if (!isActiveGeneration(generation)) return;
    const raw = result?.[STORAGE_KEY];
    const normalized = applyWidth(raw);

    if (raw !== undefined && raw !== normalized) {
      try {
        chrome.storage?.sync?.set({ [STORAGE_KEY]: normalized });
      } catch (error) {
        console.warn('[GPT-Voyager] Failed to migrate sidebar width:', error);
      }
    }
  });

  storageChangeHandler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (!isActiveGeneration(generation)) return;
    if (area !== 'sync' || !changes[STORAGE_KEY]) return;

    const raw = changes[STORAGE_KEY].newValue;
    const normalized = applyWidth(raw);
    if (raw !== undefined && raw !== normalized) {
      try {
        chrome.storage?.sync?.set({ [STORAGE_KEY]: normalized });
      } catch (error) {
        console.warn('[GPT-Voyager] Failed to normalize sidebar width:', error);
      }
    }
  };

  try {
    chrome.storage?.onChanged?.addListener(storageChangeHandler);
  } catch {
    storageChangeHandler = null;
  }

  removePageExitListener = addPageExitListener(stopSidebarWidthAdjuster);
  return stopSidebarWidthAdjuster;
}
