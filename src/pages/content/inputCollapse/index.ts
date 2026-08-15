import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';
import { addPageExitListener } from '@/core/utils/pageLifecycle';

import { getTranslationSync } from '../../../utils/i18n';
import { extractChatGptConversationIdFromUrl } from '../chatgptDom';

const STYLE_ID = 'gpt-voyager-input-collapse';
const COLLAPSED_CLASS = 'gv-input-collapsed';
const PLACEHOLDER_CLASS = 'gv-collapse-placeholder';
const PROCESSED_CLASS = 'gv-input-collapse-processed';
const TRANSITION_CLASS = 'gv-input-collapse-transition';
const OBSERVER_DEBOUNCE_MS = 100;
const CURRENT_ATTACHMENT_PREVIEW_SELECTORS = [
  '[data-testid*="file-attachment"]',
  '[data-testid*="attachment-preview"]',
  '[data-testid*="file-preview"]',
  '[class*="file-tile"][aria-label]',
];
const CURRENT_INPUT_RELATED_SELECTORS = [
  '[role="menu"]',
  '[role="dialog"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="combobox"]',
  ...CURRENT_ATTACHMENT_PREVIEW_SELECTORS,
  '[data-testid*="upload"]',
];
const LEGACY_GEMINI_INPUT_RELATED_SELECTORS = [
  '.cdk-overlay-container',
  '.mat-mdc-menu-panel',
  '.mat-mdc-dialog-container',
  '.ng-trigger',
  '[data-test-id*="attachment"]',
  '[data-test-id*="upload"]',
  '[data-test-id*="file"]',
];
const INPUT_RELATED_SELECTOR = [
  ...CURRENT_INPUT_RELATED_SELECTORS,
  ...LEGACY_GEMINI_INPUT_RELATED_SELECTORS,
].join(', ');

/**
 * Checks if the current page is the homepage or a new conversation page.
 * ChatGPT conversation pages use /c/<conversation-id>. Any route without a
 * conversation id is treated as a new/home surface and remains expanded.
 * Examples of homepage/new conversation:
 *   - /
 *   - /?model=auto
 *   - /g/<gpt-id>
 * Examples of existing conversations (should NOT match):
 *   - /c/abc123def456
 *   - /c/abc123def456?model=auto
 */
function isHomepageOrNewConversation(): boolean {
  return !extractChatGptConversationIdFromUrl(window.location.href);
}

/**
 * Checks if the current page is a gems editor page (create or edit).
 * These pages should not have auto-collapse behavior.
 */
function isGemsEditorPage(): boolean {
  const pathname = window.location.pathname;
  return /^(?:\/gpts\/(?:editor|mine|discovery)|\/g\/create)(?:\/|$)/.test(pathname);
}

/**
 * Checks if auto-collapse should be disabled on the current page.
 */
function shouldDisableAutoCollapse(): boolean {
  return isHomepageOrNewConversation() || isGemsEditorPage();
}

/**
 * Injects the CSS styles for the collapsed input state.
 */
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    /* Transitions for the input container */
    .${TRANSITION_CLASS} {
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    /* 
     * Collapsed State Styles
     */
    .${COLLAPSED_CLASS} {
      /* Compact dimensions */
      height: 48px !important;
      min-height: 48px !important;
      max-height: 48px !important;
      
      /* Pill shape */
      border-radius: 24px !important;
      width: auto !important;
      min-width: 200px !important;
      max-width: 600px !important;
      margin-left: auto !important;
      margin-right: auto !important;
      padding: 0 24px !important;
      
      /* Hide overflow */
      overflow: hidden !important;
      
      /* Visual styling - Clean, no borders if possible to avoid "shadow edge" issues */
      background-color: var(--composer-surface-primary, var(--main-surface-secondary, #f0f4f9)) !important;
      /* Subtle shadow */
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08) !important;
      border: none !important;
      
      /* Center content */
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      
      /* Ensure it's clickable */
      cursor: pointer !important;
      position: relative !important;
      z-index: 999 !important;
      
      /* Reset layout */
      gap: 0 !important;
      transform: none !important;
    }

    /* Hiding Strategy:
       Target ALL descendants that are NOT our placeholder.
       Use opacity 0 to hide.
    */
    .${COLLAPSED_CLASS} > *:not(.${PLACEHOLDER_CLASS}) {
      visibility: hidden !important;
      opacity: 0 !important;
      width: 0 !important;
      height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      position: absolute !important;
      pointer-events: none !important;
    }

    /* Placeholder Styling - HIDDEN by default */
    .${PLACEHOLDER_CLASS} {
      /* Hidden by default when not collapsed */
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
    }
    
    /* Show placeholder ONLY when collapsed */
    .${COLLAPSED_CLASS} > .${PLACEHOLDER_CLASS} {
      /* Force visibility */
      visibility: visible !important;
      opacity: 1 !important;
      display: flex !important;
      position: relative !important;
      
      /* Typography - Brighter color */
      color: var(--text-primary, #1f1f1f);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 15px; 
      font-weight: 500;
      white-space: nowrap;
      
      align-items: center;
      gap: 10px;
      pointer-events: auto;
      cursor: pointer;
      border: 0;
      padding: 0;
      background: transparent;
    }

    /* Dark mode adjustments */
    @media (prefers-color-scheme: dark) {
      .${COLLAPSED_CLASS} {
        background-color: var(--composer-surface-primary, #2b2b2b) !important;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3) !important; 
      }
      .${COLLAPSED_CLASS} > .${PLACEHOLDER_CLASS} {
        color: var(--text-primary, #e8eaed);
      }
    }
    
    body[data-theme="dark"] .${COLLAPSED_CLASS},
    body.dark-theme .${COLLAPSED_CLASS} {
        background-color: #2b2b2b !important;
    }
    body[data-theme="dark"] .${COLLAPSED_CLASS} > .${PLACEHOLDER_CLASS},
    body.dark-theme .${COLLAPSED_CLASS} > .${PLACEHOLDER_CLASS} {
        color: #e8eaed;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Finds the logical root of the input bar.
 * We need the container that holds the background color and the full width.
 */
function getInputContainer(): HTMLElement | null {
  // Safety check for test environments and edge cases
  if (typeof document === 'undefined') return null;

  const textarea =
    document.querySelector('#prompt-textarea') ||
    document.querySelector(
      'form[data-type="unified-composer"] [contenteditable="true"], ' +
        '[data-testid="composer"] [contenteditable="true"], ' +
        'form[data-type="unified-composer"] textarea, ' +
        '[data-testid="composer"] textarea, ' +
        'form[data-type="unified-composer"] rich-textarea, ' +
        '[data-testid="composer"] rich-textarea',
    );
  if (!textarea) return null;

  let current = textarea.parentElement;
  let bestCandidate: HTMLElement | null = null;

  // Traverse up to 8 levels
  for (let i = 0; i < 8; i++) {
    if (!current) break;

    // Check computed style for background color to find the visual "island"
    const style = window.getComputedStyle(current);
    const hasBackground =
      style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent';
    const isFlex = style.display.includes('flex');

    // Check for specific ChatGPT/Material classes or roles
    // We prioritize the container that has a background color
    if (hasBackground) {
      bestCandidate = current as HTMLElement;
      // If we found a substantial container (flex + background), it's a strong candidate.
      if (isFlex) {
        // Continue one more level just in case there's a wrapper, but update bestCandidate
      }
    }

    // Stop if we hit the limit or dangerous nodes
    if (
      current.tagName === 'MAIN' ||
      current.tagName === 'BODY' ||
      current.classList.contains('content-wrapper')
    ) {
      break;
    }

    current = current.parentElement;
  }

  // If we found a candidate with a background, use it.
  // Otherwise fallback to heuristic parents.
  return bestCandidate || textarea.parentElement?.parentElement || textarea.parentElement;
}

export function expandInputCollapseIfNeeded(): void {
  const container = getInputContainer();
  if (!container) return;
  expand(container);
}

/**
 * Expands the input area and moves cursor to the end (for keyboard shortcut)
 */
export function expandInputWithCursorAtEnd(): void {
  const container = getInputContainer();
  if (!container) return;
  expand(container, true); // true = move cursor to end
}

/**
 * Collapses the input area immediately (for keyboard shortcut)
 * This bypasses the delay and state checks in tryCollapse
 */
export function collapseInput(): void {
  const container = getInputContainer();
  if (!container) return;

  // Respect the "collapse when not empty" setting
  if (!allowCollapseWhenNotEmpty && !isInputEmpty(container)) return;

  // Remove focus from the input
  const active = document.activeElement;
  const hadComposerFocus = Boolean(active && container.contains(active));
  setCollapsedState(container, true);
  if (hadComposerFocus) {
    (active as HTMLElement).blur();
    const placeholder = container.querySelector<HTMLButtonElement>(`.${PLACEHOLDER_CLASS}`);
    if (placeholder) scheduleTimer(() => placeholder.isConnected && placeholder.focus(), 0);
  }
}

/**
 * Checks if the input is effectively empty.
 */
function isInputEmpty(container: HTMLElement): boolean {
  // Check the text content of the rich-textarea
  const textarea =
    container.querySelector('textarea[data-gv-plain-text-input="true"]') ||
    container.querySelector('rich-textarea') ||
    container.querySelector('textarea') ||
    container.querySelector('[contenteditable="true"]');
  if (!textarea) return true;

  // Check for attachments. If attachments exist, the input is not considered empty.
  const attachmentsArea =
    container.querySelector(CURRENT_ATTACHMENT_PREVIEW_SELECTORS.join(', ')) ||
    container.querySelector('uploader-file-preview') ||
    container.querySelector('.file-preview-wrapper');
  if (attachmentsArea) return false;

  const text =
    textarea instanceof HTMLTextAreaElement
      ? textarea.value.trim()
      : textarea.textContent?.trim() || '';
  return text.length === 0;
}

/**
 * Adds the placeholder element to the container if it doesn't exist.
 */
function ensurePlaceholder(container: HTMLElement): HTMLButtonElement {
  const existing = container.querySelector(`.${PLACEHOLDER_CLASS}`);
  if (existing instanceof HTMLButtonElement) {
    const editor = container.querySelector<HTMLElement>(
      '#prompt-textarea, [contenteditable="true"]',
    );
    if (editor?.id) existing.setAttribute('aria-controls', editor.id);
    return existing;
  }
  existing?.remove();

  const placeholder = document.createElement('button');
  placeholder.type = 'button';
  placeholder.className = PLACEHOLDER_CLASS;

  // Use i18n for the placeholder text
  const text = getTranslationSync('inputCollapsePlaceholder') || 'Message ChatGPT';

  placeholder.innerHTML = `
      <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" height="20" viewBox="0 -960 960 960" width="20" fill="currentColor">
        <path d="M240-400h320v-80H240v80Zm0-120h480v-80H240v80Zm0-120h480v-80H240v80ZM80-80v-720q0-33 23.5-56.5T160-880h640q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H240L80-80Zm126-240h594v-480H160v525l46-45Zm-46 0v-480 480Z"/>
      </svg>
      <span></span>
    `;
  const textElement = placeholder.querySelector('span');
  if (textElement) textElement.textContent = text;
  placeholder.setAttribute('aria-label', text);
  placeholder.setAttribute(
    'aria-expanded',
    container.classList.contains(COLLAPSED_CLASS) ? 'false' : 'true',
  );
  const editor = container.querySelector<HTMLElement>('#prompt-textarea, [contenteditable="true"]');
  if (editor?.id) placeholder.setAttribute('aria-controls', editor.id);

  container.appendChild(placeholder);
  return placeholder;
}

export function startInputCollapse() {
  if (started) return;
  started = true;
  const generation = ++settingsRequestGeneration;
  const requestRevision = settingsRevision;

  // Listen for setting changes exactly once for this content-script lifetime.
  settingsChangeHandler = (changes, area) => {
    if (area !== 'sync') return;
    if (
      !changes[StorageKeys.INPUT_COLLAPSE_ENABLED] &&
      !changes[StorageKeys.INPUT_COLLAPSE_WHEN_NOT_EMPTY]
    )
      return;

    const revision = ++settingsRevision;

    if (changes[StorageKeys.INPUT_COLLAPSE_WHEN_NOT_EMPTY]) {
      settingRevisions[StorageKeys.INPUT_COLLAPSE_WHEN_NOT_EMPTY] = revision;
      allowCollapseWhenNotEmpty =
        changes[StorageKeys.INPUT_COLLAPSE_WHEN_NOT_EMPTY].newValue === true;

      const container = initialized ? getInputContainer() : null;
      if (container) {
        if (!allowCollapseWhenNotEmpty && !isInputEmpty(container)) {
          setCollapsedState(container, false);
        } else {
          tryCollapse(container);
        }
      }
    }

    const enabledChange = changes[StorageKeys.INPUT_COLLAPSE_ENABLED];
    if (enabledChange) {
      settingRevisions[StorageKeys.INPUT_COLLAPSE_ENABLED] = revision;
      featureEnabled = enabledChange.newValue === true;
      if (featureEnabled) {
        initInputCollapse(allowCollapseWhenNotEmpty);
      } else if (initialized) {
        teardownInputCollapse();
      }
    }
  };
  chrome.storage?.onChanged?.addListener(settingsChangeHandler);

  // Install the listener before reading storage. Per-key revisions let this
  // snapshot fill unchanged fields without overwriting a newer onChanged value.
  chrome.storage?.sync?.get(SETTINGS_DEFAULTS, (res) => {
    if (!started || generation !== settingsRequestGeneration) return;

    if (settingRevisions[StorageKeys.INPUT_COLLAPSE_WHEN_NOT_EMPTY] <= requestRevision) {
      allowCollapseWhenNotEmpty = res?.[StorageKeys.INPUT_COLLAPSE_WHEN_NOT_EMPTY] === true;
    }
    if (settingRevisions[StorageKeys.INPUT_COLLAPSE_ENABLED] <= requestRevision) {
      featureEnabled = res?.[StorageKeys.INPUT_COLLAPSE_ENABLED] === true;
    }

    if (featureEnabled) initInputCollapse(allowCollapseWhenNotEmpty);
    else if (initialized) teardownInputCollapse();
  });
}

let observer: MutationObserver | null = null;
let initialized = false;
let started = false;
let featureEnabled = false;
let settingsRequestGeneration = 0;
let settingsRevision = 0;
let settingRevisions = {
  [StorageKeys.INPUT_COLLAPSE_ENABLED]: 0,
  [StorageKeys.INPUT_COLLAPSE_WHEN_NOT_EMPTY]: 0,
};
let eventController: AbortController | null = null;
let allowCollapseWhenNotEmpty = false; // Track the "collapse when not empty" setting
let collapseTimer: number | null = null; // Timer for delayed collapse
let observerScanTimer: number | null = null;
let pendingTimers = new Set<number>();
let processedContainers = new WeakSet<HTMLElement>();
let settingsChangeHandler:
  | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
  | null = null;
let removePageExitListener: (() => void) | null = null;
let languageChangeHandler:
  | ((changes: Record<string, browser.Storage.StorageChange>, areaName: string) => void)
  | null = null;

const SETTINGS_DEFAULTS = {
  [StorageKeys.INPUT_COLLAPSE_ENABLED]: false,
  [StorageKeys.INPUT_COLLAPSE_WHEN_NOT_EMPTY]: false,
};

function ensurePageExitListener(): void {
  if (removePageExitListener) return;
  removePageExitListener = addPageExitListener(cleanup);
}

function removeRegisteredPageExitListener(): void {
  if (!removePageExitListener) return;
  removePageExitListener();
  removePageExitListener = null;
}

function scheduleTimer(callback: () => void, delay: number): number {
  const timer = window.setTimeout(() => {
    pendingTimers.delete(timer);
    callback();
  }, delay);
  pendingTimers.add(timer);
  return timer;
}

function cancelTimer(timer: number | null): void {
  if (timer === null) return;
  window.clearTimeout(timer);
  pendingTimers.delete(timer);
}

/**
 * Cleans up the input collapse feature.
 * Removes all event listeners, styles, and resets state.
 * Exported for testing purposes.
 */
export function cleanup() {
  featureEnabled = false;
  settingsRequestGeneration += 1;
  teardownInputCollapse();

  if (settingsChangeHandler) {
    try {
      chrome.storage?.onChanged?.removeListener(settingsChangeHandler);
    } catch {}
    settingsChangeHandler = null;
  }

  removeRegisteredPageExitListener();

  started = false;
}

function teardownInputCollapse() {
  // Clear any pending collapse timer
  cancelTimer(collapseTimer);
  collapseTimer = null;
  cancelTimer(observerScanTimer);
  observerScanTimer = null;
  pendingTimers.forEach((timer) => window.clearTimeout(timer));
  pendingTimers.clear();

  // Abort all event listeners managed by the controller
  if (eventController) {
    eventController.abort();
    eventController = null;
  }

  // Remove styles
  const style = document.getElementById(STYLE_ID);
  if (style) style.remove();

  // Remove classes from containers
  document.querySelectorAll(`.${COLLAPSED_CLASS}`).forEach((el) => {
    el.classList.remove(COLLAPSED_CLASS);
  });
  document.querySelectorAll(`.${TRANSITION_CLASS}`).forEach((el) => {
    el.classList.remove(TRANSITION_CLASS);
  });
  document.querySelectorAll(`.${PROCESSED_CLASS}`).forEach((el) => {
    el.classList.remove(PROCESSED_CLASS);
  });
  document.querySelectorAll(`.${PLACEHOLDER_CLASS}`).forEach((el) => {
    el.remove();
  });

  // Disconnect observer
  if (observer) {
    observer.disconnect();
    observer = null;
  }

  if (languageChangeHandler) {
    try {
      browser.storage.onChanged.removeListener(languageChangeHandler);
    } catch {}
    languageChangeHandler = null;
  }

  initialized = false;
  processedContainers = new WeakSet<HTMLElement>();
  removeRegisteredPageExitListener();
}

function setCollapsedState(container: HTMLElement, collapsed: boolean): void {
  container.classList.toggle(COLLAPSED_CLASS, collapsed);
  const placeholder = container.querySelector<HTMLButtonElement>(`.${PLACEHOLDER_CLASS}`);
  if (placeholder) placeholder.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function processInputContainer(container: HTMLElement): void {
  if (processedContainers.has(container)) {
    // ChatGPT may replace the contents of a stable composer shell. Restore our
    // lightweight placeholder if that inner re-render removed it.
    ensurePlaceholder(container);
    return;
  }

  processedContainers.add(container);
  container.classList.add(PROCESSED_CLASS, TRANSITION_CLASS);
  ensurePlaceholder(container);

  const signal = eventController?.signal;
  if (!signal) return;

  container.addEventListener(
    'click',
    () => {
      expand(container);
    },
    { signal },
  );

  container.addEventListener(
    'focusin',
    (event) => {
      const target = event.target as Element | null;
      if (target?.closest(`.${PLACEHOLDER_CLASS}`)) {
        cancelTimer(collapseTimer);
        collapseTimer = null;
        return;
      }
      expand(container);
      cancelTimer(collapseTimer);
      collapseTimer = null;
    },
    { signal },
  );

  container.addEventListener(
    'keydown',
    (event) => {
      const target = event.target as Element | null;
      if (!target?.closest(`.${PLACEHOLDER_CLASS}`)) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;

      event.preventDefault();
      event.stopPropagation();
      expand(container, true);
    },
    { signal },
  );

  container.addEventListener(
    'focusout',
    (e) => {
      cancelTimer(collapseTimer);
      collapseTimer = null;

      const newFocus = e.relatedTarget as HTMLElement | null;
      if (newFocus && container.contains(newFocus)) return;

      collapseTimer = scheduleTimer(() => {
        collapseTimer = null;
        if (!initialized || !container.isConnected) return;

        const active = document.activeElement as HTMLElement | null;
        if (active && container.contains(active)) return;
        if (
          (newFocus && isInputRelatedElement(newFocus, container)) ||
          (active && isInputRelatedElement(active, container))
        ) {
          return;
        }

        tryCollapse(container);
      }, 100);
    },
    { signal },
  );

  if (shouldDisableAutoCollapse()) {
    setCollapsedState(container, false);
  } else {
    tryCollapse(container);
  }
}

function processCurrentInputContainer(): void {
  const container = getInputContainer();
  if (container) processInputContainer(container);
}

function initInputCollapse(allowCollapseNotEmpty: boolean = false) {
  allowCollapseWhenNotEmpty = allowCollapseNotEmpty;
  if (initialized) {
    const container = getInputContainer();
    if (container) {
      const alreadyProcessed = processedContainers.has(container);
      processInputContainer(container);
      if (alreadyProcessed) {
        if (
          shouldDisableAutoCollapse() ||
          (!allowCollapseWhenNotEmpty && !isInputEmpty(container))
        ) {
          setCollapsedState(container, false);
        } else {
          tryCollapse(container);
        }
      }
    }
    return;
  }
  initialized = true;
  ensurePageExitListener();

  injectStyles();

  let lastPathname = window.location.pathname;

  // Create AbortController for managing all event listeners
  eventController = new AbortController();
  const { signal } = eventController;

  // Auto-expand the input area when a file is dragged into the window.
  document.addEventListener(
    'dragenter',
    (e) => {
      if (e.dataTransfer?.types.includes('Files')) {
        const container = getInputContainer();
        if (container && container.classList.contains(COLLAPSED_CLASS)) {
          expand(container);
        }
      }
    },
    { signal, capture: true },
  );

  // Handle URL changes for SPA navigation
  const urlChangeHandler = () => {
    // Safety check for test environments and edge cases
    if (typeof window === 'undefined' || !window.location) return;

    const currentPathname = window.location.pathname;
    if (currentPathname === lastPathname) return;

    lastPathname = currentPathname;

    const container = getInputContainer();
    if (!container) return;

    if (shouldDisableAutoCollapse()) {
      // On homepage/new conversation/gems create: expand the input
      setCollapsedState(container, false);
    } else {
      // On conversation page: try to collapse if appropriate
      tryCollapse(container);
    }
  };

  // Listen for URL changes (browser back/forward)
  window.addEventListener('popstate', urlChangeHandler, { signal });

  // MutationObserver to re-apply when ChatGPT re-renders and detect SPA navigation
  // Use MutationObserver so we re-apply if ChatGPT re-renders (common in SPAs)
  observer = new MutationObserver(() => {
    cancelTimer(observerScanTimer);
    observerScanTimer = scheduleTimer(() => {
      observerScanTimer = null;
      // Check for URL changes on DOM mutations (catches SPA navigation)
      urlChangeHandler();
      processCurrentInputContainer();
    }, OBSERVER_DEBOUNCE_MS);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Add keyboard shortcuts for collapse/expand
  document.addEventListener(
    'keydown',
    (e) => {
      const container = getInputContainer();
      if (!container) return;

      // ESC key - collapse input
      if (e.key === 'Escape') {
        // Only respond when focus is within the input container
        const active = document.activeElement;
        if (active && container.contains(active)) {
          e.preventDefault();
          e.stopPropagation();
          collapseInput();
        }
        return;
      }

      // Ctrl+I - expand input and focus with cursor at end
      if (e.key === 'i' || e.key === 'I') {
        if (e.ctrlKey || e.metaKey) {
          // Only respond when input is collapsed
          if (container.classList.contains(COLLAPSED_CLASS)) {
            e.preventDefault();
            e.stopPropagation();
            expandInputWithCursorAtEnd();
          }
        }
        return;
      }
    },
    { signal, capture: true }, // capture phase to ensure we intercept before other handlers
  );

  // Listen for language changes and update placeholder text.
  languageChangeHandler = (changes, areaName) => {
    if ((areaName === 'sync' || areaName === 'local') && changes[StorageKeys.LANGUAGE]) {
      // Update all placeholder text
      document
        .querySelectorAll<HTMLButtonElement>(`.${PLACEHOLDER_CLASS}`)
        .forEach((placeholder) => {
          const span = placeholder.querySelector('span');
          if (span) {
            const text = getTranslationSync('inputCollapsePlaceholder') || 'Message ChatGPT';
            span.textContent = text;
            placeholder.setAttribute('aria-label', text);
          }
        });
    }
  };
  browser.storage.onChanged.addListener(languageChangeHandler);

  // Process an already-mounted composer explicitly. Runtime enabling must not
  // depend on an unrelated future DOM mutation to become effective.
  processCurrentInputContainer();
}

/**
 * Check if an element is part of input-related UI (menus, overlays, etc.)
 * This prevents collapse when clicking model selector, attachment button, etc.
 */
function isInputRelatedElement(element: HTMLElement, container: HTMLElement): boolean {
  if (!element) return false;

  // Check current ChatGPT surfaces first; named legacy selectors are retained
  // only as compatibility fallbacks for older persisted pages.
  if (element.matches(INPUT_RELATED_SELECTOR) || element.closest(INPUT_RELATED_SELECTOR)) {
    return true;
  }

  // Additional heuristic: check if element is within a reasonable proximity
  // to the input container (within 5 levels up, but not the body/main)
  let parent = element.parentElement;
  let levels = 0;
  while (parent && levels < 5) {
    // If we reach body or main, we've gone too far
    if (parent.tagName === 'BODY' || parent.tagName === 'MAIN') {
      break;
    }
    // If we find the container, the element is input-related
    if (parent === container) {
      return true;
    }
    parent = parent.parentElement;
    levels++;
  }

  return false;
}

function expand(container: HTMLElement, moveCursorToEnd: boolean = false) {
  if (container.classList.contains(COLLAPSED_CLASS)) {
    setCollapsedState(container, false);

    // Focus the visible plain-text layer first when that mode owns the composer.
    const editor =
      container.querySelector('textarea[data-gv-plain-text-input="true"]') ||
      container.querySelector('.ql-editor') ||
      container.querySelector('[contenteditable]') ||
      container.querySelector('rich-textarea');

    if (editor && editor instanceof HTMLElement) {
      scheduleTimer(() => {
        if (!initialized || !container.isConnected) return;
        editor.focus();
        if (moveCursorToEnd && !isInputEmpty(container)) {
          moveCursorToEndOfElement(editor);
        }
      }, 0);
    }
  }
}

/**
 * Moves the cursor to the end of the content in a contenteditable element
 */
function moveCursorToEndOfElement(element: HTMLElement): void {
  if (element instanceof HTMLTextAreaElement) {
    const end = element.value.length;
    element.setSelectionRange(end, end);
    return;
  }

  const selection = window.getSelection();
  if (!selection) return;

  const range = document.createRange();

  const targetNode = element.lastChild || element;

  range.selectNodeContents(targetNode);
  range.collapse(false); // false = collapse to end

  selection.removeAllRanges();
  selection.addRange(range);
}

function tryCollapse(container: HTMLElement) {
  // We need a small delay to handle transient states
  scheduleTimer(() => {
    if (!initialized || !container.isConnected) return;
    // Don't collapse on excluded pages (homepage, new conversation, gems create)
    if (shouldDisableAutoCollapse()) {
      setCollapsedState(container, false);
      return;
    }

    const active = document.activeElement;
    const isStillFocused = container.contains(active);

    if (!isStillFocused) {
      // Check if we should collapse based on setting and input state
      // If allowCollapseWhenNotEmpty is true, we can collapse even with content
      // Otherwise, only collapse when empty (original behavior)
      const canCollapse = allowCollapseWhenNotEmpty || isInputEmpty(container);
      if (canCollapse) {
        setCollapsedState(container, true);
      } else {
        setCollapsedState(container, false);
      }
    }
  }, 150);
}
