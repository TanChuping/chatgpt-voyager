/**
 * Adjusts the chat area width: a percentage of the pane the thread sits in.
 *
 * 2026-09 app shell: two hosts define the column width for everything below
 * them — the transcript and the composer — as
 * `--thread-content-max-width: var(--thread-content-responsive-max-width, inherit)`.
 * Setting that responsive variable there moves the messages, their action
 * bars and the composer together. The value is container-relative (`cqi`), so
 * it follows the pane through window resizes and sidebar folds without JS and
 * without a style recalc. The transcript's query container sits inside the
 * scroller's gutter (`scrollbar-gutter: stable both-edges`), the composer's
 * does not, so the composer subtracts the measured gutter to stay aligned.
 * The "composer width" setting (editInputWidth) overrides the composer host
 * with a more specific selector while it is on.
 *
 * The 2026-07 layout rule is kept; the pixel caps written for Gemini-era and
 * older ChatGPT markup are gone — `[data-message-author-role]` now also marks
 * the new message blocks (domCompat), where those caps squeezed the column.
 */
import { addPageExitListener } from '@/core/utils/pageLifecycle';

import {
  THREAD_WIDTH_HOST_SELECTOR,
  TRANSCRIPT_WIDTH_HOST_SELECTOR,
  measureThreadGutter,
} from '../chatgptDom';

const STYLE_ID = 'gpt-voyager-chat-width';
const DEFAULT_PERCENT = 70;
const MIN_PERCENT = 30;
const MAX_PERCENT = 100;
const LEGACY_BASELINE_PX = 1200;

const clampPercent = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

const normalizePercent = (value: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback;
  if (value > MAX_PERCENT) {
    const approx = (value / LEGACY_BASELINE_PX) * 100;
    return clampPercent(approx, MIN_PERCENT, MAX_PERCENT);
  }
  return clampPercent(value, MIN_PERCENT, MAX_PERCENT);
};

let threadGutterPx: number | null = null;

function buildStyle(percent: number): string {
  const fraction = percent / 100;
  const gutter = threadGutterPx ?? 0;
  return `
    /* 2026-09 app shell */
    ${THREAD_WIDTH_HOST_SELECTOR} {
      --thread-content-responsive-max-width: calc((100cqi - ${gutter}px) * ${fraction});
    }
    ${TRANSCRIPT_WIDTH_HOST_SELECTOR} {
      --thread-content-responsive-max-width: calc(100cqi * ${fraction});
    }

    /* 2026-07 layout */
    [class*="group/turn-messages"],
    #thread-bottom [class*="--thread-content-max-width"]:has(form[data-type="unified-composer"]) {
      --thread-content-max-width: ${percent}% !important;
    }
  `;
}

function applyWidth(widthPercent: number) {
  const normalizedPercent = normalizePercent(widthPercent, DEFAULT_PERCENT);
  threadGutterPx = measureThreadGutter() ?? threadGutterPx;
  const css = buildStyle(normalizedPercent);

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  // Rewriting a stylesheet re-matches every rule on the page; skip no-ops.
  if (style.textContent !== css) style.textContent = css;
}

function removeStyles() {
  const style = document.getElementById(STYLE_ID);
  if (style) {
    style.remove();
  }
}

const ENABLED_KEY = 'gvChatWidthEnabled';

let started = false;
let lifecycleGeneration = 0;
let currentWidthPercent = DEFAULT_PERCENT;
let enabled = false;
let storageChangeHandler:
  | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
  | null = null;
let widthObserver: MutationObserver | null = null;
let debounceTimer: number | null = null;
let removePageExitListener: (() => void) | null = null;

function isActiveGeneration(generation: number): boolean {
  return started && generation === lifecycleGeneration;
}

export function stopChatWidthAdjuster(): void {
  started = false;
  lifecycleGeneration += 1;
  enabled = false;

  if (debounceTimer !== null) {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  widthObserver?.disconnect();
  widthObserver = null;
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

export function startChatWidthAdjuster(): () => void {
  if (started) return stopChatWidthAdjuster;
  started = true;
  const generation = ++lifecycleGeneration;
  currentWidthPercent = DEFAULT_PERCENT;
  enabled = false;

  // Load initial state 鈥?request keys without defaults so we can distinguish
  // "key never existed" (upgrade) from "explicitly set to false"
  chrome.storage?.sync?.get(['gptChatWidth', ENABLED_KEY], (res) => {
    if (!isActiveGeneration(generation)) return;
    const storedWidth = res?.gptChatWidth;
    const numericStoredWidth = typeof storedWidth === 'number' ? storedWidth : DEFAULT_PERCENT;
    const normalized = normalizePercent(numericStoredWidth, DEFAULT_PERCENT);
    currentWidthPercent = normalized;

    const enabledRaw = res?.[ENABLED_KEY];
    if (enabledRaw === undefined) {
      // Upgrade path: enabled key was never set.
      // Auto-enable if user had previously customized the width.
      enabled =
        typeof storedWidth === 'number' &&
        normalizePercent(storedWidth, DEFAULT_PERCENT) !== DEFAULT_PERCENT;
      if (enabled) {
        try {
          chrome.storage?.sync?.set({ [ENABLED_KEY]: true });
        } catch {}
      }
    } else {
      enabled = enabledRaw === true;
    }

    if (enabled) {
      applyWidth(currentWidthPercent);
    }

    if (typeof storedWidth === 'number' && storedWidth !== normalized) {
      try {
        chrome.storage?.sync?.set({ gptChatWidth: normalized });
      } catch (e) {
        console.warn('[GPT-Voyager] Failed to migrate chat width to %:', e);
      }
    }
  });

  // Listen for changes from storage
  storageChangeHandler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (!isActiveGeneration(generation)) return;
    if (area !== 'sync') return;

    if (changes[ENABLED_KEY]) {
      enabled = changes[ENABLED_KEY].newValue === true;
      if (enabled) {
        applyWidth(currentWidthPercent);
      } else {
        removeStyles();
      }
    }

    if (changes.gptChatWidth) {
      const newWidth = changes.gptChatWidth.newValue;
      if (typeof newWidth === 'number') {
        const normalized = normalizePercent(newWidth, DEFAULT_PERCENT);
        currentWidthPercent = normalized;
        if (enabled) {
          applyWidth(currentWidthPercent);
        }

        if (normalized !== newWidth) {
          try {
            chrome.storage?.sync?.set({ gptChatWidth: normalized });
          } catch (e) {
            console.warn('[GPT-Voyager] Failed to migrate chat width to % on change:', e);
          }
        }
      }
    }
  };

  try {
    chrome.storage?.onChanged?.addListener(storageChangeHandler);
  } catch {
    storageChangeHandler = null;
  }

  // CSS covers new content by itself; the only thing to learn from the DOM is
  // the thread scroller's gutter, once a thread is open. Stop watching then.
  widthObserver = new MutationObserver(() => {
    if (!isActiveGeneration(generation) || debounceTimer !== null) return;
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      if (!isActiveGeneration(generation)) return;
      const gutter = measureThreadGutter();
      if (gutter === null) return;
      widthObserver?.disconnect();
      widthObserver = null;
      if (gutter !== threadGutterPx) {
        threadGutterPx = gutter;
        if (enabled) applyWidth(currentWidthPercent);
      }
    }, 300);
  });
  widthObserver.observe(document.body, { childList: true, subtree: true });

  removePageExitListener = addPageExitListener(stopChatWidthAdjuster);
  return stopChatWidthAdjuster;
}
