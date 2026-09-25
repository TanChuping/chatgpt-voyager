/*
 * Adjust ChatGPT's sidebar width.
 *
 * Legacy layout: through its live --sidebar-width CSS variable.
 *
 * 2026-09 app shell: ChatGPT owns the left panel's width — its own drag handle,
 * collapse to the icon rail, the open/close animation, and persistence. A CSS
 * width override pins the panel and breaks all of them (and any rule that also
 * matches the handle stretches it over the whole sidebar, swallowing clicks).
 * So on this layout the stored width is fed through ChatGPT's own resize
 * handle, and the user's drags on that handle are written back to the setting.
 */
import { addPageExitListener } from '@/core/utils/pageLifecycle';

import { APP_SHELL_LEFT_PANEL_SELECTOR, APP_SHELL_PANEL_RESIZER_SELECTOR } from '../chatgptDom';

const STYLE_ID = 'gv-sidebar-width-style';
const STORAGE_KEY = 'gptSidebarWidth';
const LEGACY_ENABLED_KEY = 'gvSidebarWidthEnabled';

const DEFAULT_PX = 280;
const MIN_PX = 240;
const MAX_PX = 600;
const LEGACY_BASELINE_PX = 1200;
const LEGACY_MAX_PERCENT = 45;

/** A double-click resets the size in the click that follows pointerup. */
const WRITE_BACK_DELAY_MS = 150;
const MAX_REPLAYS = 3;

let started = false;
let lifecycleGeneration = 0;
let storageChangeHandler:
  | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
  | null = null;
let removePageExitListener: (() => void) | null = null;
let removeResizerListener: (() => void) | null = null;

let appShellTarget: number | null = null;
let replaying = false;
let resizerObserver: MutationObserver | null = null;
let resizerCheckTimer: number | null = null;

function isActiveGeneration(generation: number): boolean {
  return started && generation === lifecycleGeneration;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

const nextTask = (ms = 0) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

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

function findAppShellResizer(): HTMLElement | null {
  return document.querySelector<HTMLElement>(APP_SHELL_PANEL_RESIZER_SELECTOR);
}

/** ChatGPT mirrors the panel's current size into its content wrapper's inline width. */
function readAppShellPanelWidth(): number | null {
  const panel = document.querySelector(APP_SHELL_LEFT_PANEL_SELECTOR);
  if (!panel) return null;
  for (const child of Array.from(panel.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.querySelector(":scope > [role='separator']")) continue;
    const width = parseFloat(child.style.width);
    if (Number.isFinite(width)) return width;
  }
  return null;
}

function appShellZoom(): number {
  const frame = document.querySelector('[data-app-shell-frame]');
  const zoom = frame
    ? parseFloat(getComputedStyle(frame).getPropertyValue('--codex-window-zoom'))
    : NaN;
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

/**
 * Replays a left-button drag on ChatGPT's handle so ChatGPT resizes (and
 * persists) the panel itself. Its drag is relative to its own stored size, and
 * it starts listening for moves only after the press re-renders — hence the
 * task break between press and move.
 */
async function dragResizer(resizer: HTMLElement, delta: number): Promise<void> {
  const rect = resizer.getBoundingClientRect();
  const startX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  const endX = startX + delta * appShellZoom();
  const fire = (type: string, clientX: number, buttons: number) =>
    resizer.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX,
        clientY,
        button: 0,
        buttons,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }),
    );

  fire('pointerdown', startX, 1);
  try {
    await nextTask();
    fire('pointermove', endX, 1);
  } finally {
    fire('pointerup', endX, 0);
    try {
      if (resizer.hasPointerCapture(1)) resizer.releasePointerCapture(1);
    } catch {}
  }
  await nextTask(50);
}

async function replayAppShellWidth(generation: number): Promise<void> {
  if (replaying) return;
  replaying = true;
  try {
    // Re-read the target each round: the popup may change it meanwhile.
    for (let round = 0; round < MAX_REPLAYS; round++) {
      if (!isActiveGeneration(generation) || appShellTarget === null) return;
      const resizer = findAppShellResizer();
      const current = readAppShellPanelWidth();
      if (!resizer || current === null) {
        // Collapsed or not mounted yet: apply when the handle appears.
        watchForResizer(generation);
        return;
      }
      const delta = appShellTarget - current;
      if (Math.abs(delta) < 1) return;
      await dragResizer(resizer, delta);
      // ChatGPT clamps to its own range (290–520px in a ~1460px window);
      // a target outside it leaves the size where it was.
      const after = readAppShellPanelWidth();
      if (after === null || Math.abs(after - current) < 1) return;
    }
  } finally {
    replaying = false;
  }
}

function stopWatchingForResizer(): void {
  resizerObserver?.disconnect();
  resizerObserver = null;
  if (resizerCheckTimer !== null) {
    window.clearTimeout(resizerCheckTimer);
    resizerCheckTimer = null;
  }
}

function watchForResizer(generation: number): void {
  if (resizerObserver) return;
  resizerObserver = new MutationObserver(() => {
    if (resizerCheckTimer !== null) return;
    resizerCheckTimer = window.setTimeout(() => {
      resizerCheckTimer = null;
      if (!isActiveGeneration(generation)) {
        stopWatchingForResizer();
        return;
      }
      if (!findAppShellResizer() || readAppShellPanelWidth() === null) return;
      stopWatchingForResizer();
      void replayAppShellWidth(generation);
    }, 100);
  });
  resizerObserver.observe(document.documentElement, { childList: true, subtree: true });
}

/** Writes the user's own drag (or double-click reset) on ChatGPT's handle back to the setting. */
function listenForNativeResize(generation: number): () => void {
  const onPointerDown = (event: PointerEvent) => {
    if (!event.isTrusted || event.button !== 0) return;
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest(APP_SHELL_PANEL_RESIZER_SELECTOR)) return;
    // A press that doesn't change the size (a stray click on the handle) must
    // not adopt whatever width ChatGPT happens to show into the setting.
    const before = readAppShellPanelWidth();

    const finish = () => {
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
      window.setTimeout(() => {
        if (!isActiveGeneration(generation) || replaying) return;
        // Handle gone = the panel was collapsed, not resized.
        if (!findAppShellResizer()) return;
        const native = readAppShellPanelWidth();
        if (native === null || native === before) return;
        const width = clamp(native, MIN_PX, MAX_PX);
        if (width === appShellTarget) return;
        appShellTarget = width;
        try {
          chrome.storage?.sync?.set({ [STORAGE_KEY]: width });
        } catch (error) {
          console.warn('[GPT-Voyager] Failed to save sidebar width:', error);
        }
      }, WRITE_BACK_DELAY_MS);
    };
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
  };
  window.addEventListener('pointerdown', onPointerDown, true);
  return () => window.removeEventListener('pointerdown', onPointerDown, true);
}

function applyWidth(value: unknown, generation: number): number {
  const width = normalizeWidth(value);
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.documentElement.appendChild(style);
  }
  style.textContent = buildStyle(width);

  appShellTarget = width;
  void replayAppShellWidth(generation);
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
  removeResizerListener?.();
  removeResizerListener = null;
  stopWatchingForResizer();
  appShellTarget = null;
  removeStyles();
}

export function startSidebarWidthAdjuster(): () => void {
  if (started) return stopSidebarWidthAdjuster;
  started = true;
  const generation = ++lifecycleGeneration;
  removeResizerListener = listenForNativeResize(generation);
  chrome.storage?.sync?.get([STORAGE_KEY, LEGACY_ENABLED_KEY], (result) => {
    if (!isActiveGeneration(generation)) return;
    const raw = result?.[STORAGE_KEY];
    const normalized = applyWidth(raw, generation);

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
    const normalized = applyWidth(raw, generation);
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
