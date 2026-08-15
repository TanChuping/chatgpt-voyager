/**
 * Folder-as-Project feature
 *
 * When enabled, injects a folder picker above the ChatGPT input on new-chat
 * pages. On the first send, it prepends any folder instructions just-in-time
 * and automatically assigns the new conversation to the selected folder.
 */
import { StorageKeys } from '@/core/types/common';
import { addPageExitListener } from '@/core/utils/pageLifecycle';
import { getTranslationSyncUnsafe } from '@/utils/i18n';

import { findChatInput } from '../chatInput/index';
import { extractChatGptConversationIdFromUrl } from '../chatgptDom';
import { getFolderColor, isDarkMode } from '../folder/folderColors';
import type { FolderManager } from '../folder/manager';
import {
  PLAIN_TEXT_BEFORE_SEND_EVENT,
  PLAIN_TEXT_NATIVE_SEND_ATTRIBUTE,
  type PlainTextBeforeSendDetail,
} from '../shared/plainTextInputBridge';
import { setInputText } from '../utils/inputHelper';
import {
  buildInstructionBlock,
  hasInstructionBlock,
  stripInstructionBlock,
} from './instructionBlock';

// ============================================================================
// Module state (per-tab, reset on navigation)
// ============================================================================

let featureInitialized = false;
let selectedFolderId: string | null = null;
let selectedFolderName: string | null = null;
let selectedFolderInstructions: string | null = null;
let pickerContainer: HTMLElement | null = null;
let pickerCleanup: (() => void) | null = null;
let lastHref = '';
let urlWatcherInterval: ReturnType<typeof setInterval> | null = null;
let urlWatcherCheckFn: (() => void) | null = null;
let ctrlEnterSendEnabled = false;
let pendingSend = false;
let pendingSendResetTimer: ReturnType<typeof setTimeout> | null = null;
let sendClickListener: ((e: Event) => void) | null = null;
let sendKeydownListener: ((e: KeyboardEvent) => void) | null = null;
let plainTextBeforeSendListener: ((e: Event) => void) | null = null;
let started = false;
let lifecycleGeneration = 0;
let activationGeneration = 0;
let storageChangeHandler:
  | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
  | null = null;
let removePageExitListener: (() => void) | null = null;

const SEND_BUTTON_SELECTOR =
  'button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="send"], ' +
  'button[data-tooltip*="Send"], button[data-tooltip*="send"], ' +
  '[data-send-button], .send-button';
const PLAIN_TEXT_NATIVE_SEND_SELECTOR = `[${PLAIN_TEXT_NATIVE_SEND_ATTRIBUTE}="true"]`;

function isCurrentLifecycle(generation: number): boolean {
  return started && generation === lifecycleGeneration;
}

function isActiveActivation(generation: number): boolean {
  return started && featureInitialized && generation === activationGeneration;
}

// ============================================================================
// i18n helper
// ============================================================================

function t(key: string): string {
  return getTranslationSyncUnsafe(key);
}

// ============================================================================
// URL helpers
// ============================================================================

function stripChatGptLocalePrefix(path: string): string {
  const pathname = (path.split(/[?#]/, 1)[0] || '/').replace(/^([^/])/, '/$1');
  const withoutLocale = pathname.replace(/^\/[a-z]{2}(?:-[a-z0-9]{2,8})?(?=\/|$)/i, '');
  return withoutLocale || '/';
}

/**
 * Returns true when the current pathname is a new empty chat page, i.e. no conversation ID is present yet.
 *
 * Supports ChatGPT conversation paths.
 *
 * @param path - `window.location.pathname` to test
 */
export function isNewChatPath(path: string): boolean {
  const normalized = stripChatGptLocalePrefix(path);
  return normalized === '/' || /^\/g\/(?!create(?:\/|$))[^/]+\/?$/.test(normalized);
}

/**
 * Extracts the conversation ID from a ChatGPT conversation URL path.
 *
 * @param path - `window.location.pathname` to parse
 * @returns Conversation ID string, or null if none present
 */
export function extractConvId(path: string): string | null {
  return extractChatGptConversationIdFromUrl(path);
}

/** Return the custom GPT id from `/g/:gptId/c/:conversationId` routes. */
export function extractCustomGptId(path: string): string | null {
  const normalized = stripChatGptLocalePrefix(path);
  return normalized.match(/^\/g\/([^/]+)\/c\/[^/?#]+\/?$/)?.[1] ?? null;
}

// ============================================================================
// DOM helper
// ============================================================================

/**
 * Waits for an element matching the selector to appear and have nonzero height.
 *
 * @param selector - CSS selector to query
 * @param timeoutMs - Maximum wait time in milliseconds
 * @returns Matched element, or null on timeout
 */
export function waitForElement(
  selector: string,
  timeoutMs: number,
  shouldContinue: () => boolean = () => true,
): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    if (!shouldContinue()) {
      resolve(null);
      return;
    }
    const existing = document.querySelector<HTMLElement>(selector);
    if (existing && existing.getBoundingClientRect().height > 0) {
      resolve(existing);
      return;
    }
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (!shouldContinue()) {
        resolve(null);
        return;
      }
      const el = document.querySelector<HTMLElement>(selector);
      if (el && el.getBoundingClientRect().height > 0) {
        resolve(el);
        return;
      }
      if (Date.now() > deadline) {
        resolve(null);
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

// ============================================================================
// Send detection - distinguishes message sends from sidebar navigation
// ============================================================================

function readInputText(input: HTMLElement): string {
  return input instanceof HTMLTextAreaElement
    ? input.value
    : (input.innerText ?? input.textContent ?? '');
}

function clearPendingSendState(): void {
  if (pendingSendResetTimer !== null) {
    clearTimeout(pendingSendResetTimer);
    pendingSendResetTimer = null;
  }
  pendingSend = false;
}

function clearPreparedInstructions(): void {
  const input = findChatInput();
  if (!input) return;

  const currentText = readInputText(input);
  if (!hasInstructionBlock(currentText)) return;

  setInputText(input, stripInstructionBlock(currentText));
}

function prepareInputForSend(input: HTMLElement | null): void {
  if (!input || !selectedFolderInstructions || !selectedFolderName) return;

  const currentText = stripInstructionBlock(readInputText(input));
  const combined = `${buildInstructionBlock(selectedFolderName, selectedFolderInstructions)}${currentText}`;
  setInputText(input, combined);
}

function schedulePendingSendReset(): void {
  if (pendingSendResetTimer !== null) {
    clearTimeout(pendingSendResetTimer);
  }

  pendingSendResetTimer = setTimeout(() => {
    if (!pendingSend) return;
    clearPendingSendState();
    if (isNewChatPath(window.location.pathname)) {
      clearPreparedInstructions();
    }
  }, 4000);
}

function markPendingSend(input: HTMLElement | null): void {
  prepareInputForSend(input);
  pendingSend = true;
  schedulePendingSendReset();
}

function isKeyboardSend(event: KeyboardEvent): boolean {
  if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return false;

  if (ctrlEnterSendEnabled) {
    return event.ctrlKey || event.metaKey;
  }

  return !event.ctrlKey && !event.metaKey;
}

function isEditableTarget(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;

  return (
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable ||
    target.getAttribute('contenteditable') === 'true' ||
    target.getAttribute('role') === 'textbox'
  );
}

function setupSendDetection(): void {
  if (sendClickListener || sendKeydownListener || plainTextBeforeSendListener) return;

  sendClickListener = (e: Event) => {
    if (!selectedFolderId) return;
    const target = e.target as HTMLElement;
    if (target.closest(PLAIN_TEXT_NATIVE_SEND_SELECTOR)) return;
    if (target.closest(SEND_BUTTON_SELECTOR)) {
      markPendingSend(findChatInput());
    }
  };

  sendKeydownListener = (e: KeyboardEvent) => {
    if (!selectedFolderId || !isKeyboardSend(e) || !isEditableTarget(e.target)) return;
    markPendingSend(e.target);
  };

  plainTextBeforeSendListener = (event: Event) => {
    if (!selectedFolderId) return;
    const input = (event as CustomEvent<PlainTextBeforeSendDetail>).detail?.input;
    if (!(input instanceof HTMLTextAreaElement) || !input.isConnected) return;
    markPendingSend(input);
  };

  document.addEventListener('click', sendClickListener, true);
  document.addEventListener('keydown', sendKeydownListener, true);
  document.addEventListener(PLAIN_TEXT_BEFORE_SEND_EVENT, plainTextBeforeSendListener);
}

function teardownSendDetection(): void {
  if (sendClickListener) {
    document.removeEventListener('click', sendClickListener, true);
    sendClickListener = null;
  }
  if (sendKeydownListener) {
    document.removeEventListener('keydown', sendKeydownListener, true);
    sendKeydownListener = null;
  }
  if (plainTextBeforeSendListener) {
    document.removeEventListener(PLAIN_TEXT_BEFORE_SEND_EVENT, plainTextBeforeSendListener);
    plainTextBeforeSendListener = null;
  }
  clearPendingSendState();
}

// ============================================================================
// Picker UI
// ============================================================================

async function populateDropdown(
  dropdown: HTMLElement,
  manager: FolderManager,
  chip: HTMLButtonElement,
  generation: number,
): Promise<void> {
  dropdown.innerHTML = '';
  await manager.ensureDataLoaded();
  if (!isActiveActivation(generation)) return;
  const allFolders = manager.getFolders();

  if (allFolders.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'gv-fp-item';
    empty.textContent = t('folderAsProject_noFolder');
    dropdown.appendChild(empty);
    return;
  }

  // Index children by parentId for tree traversal
  const childrenOf = new Map<string, (typeof allFolders)[number][]>();
  for (const f of allFolders) {
    const key = f.parentId ?? '__root__';
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(f);
  }

  // Handler for selecting a folder
  const selectFolder = (folder: (typeof allFolders)[number]) => {
    selectedFolderId = folder.id;
    selectedFolderName = folder.name;
    selectedFolderInstructions = folder.instructions ?? null;
    chip.textContent = `Folder: ${folder.name}`;
    chip.dataset.selected = folder.id;
    dropdown.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
    clearPreparedInstructions();
  };

  // "No folder" / clear selection option
  const noneItem = document.createElement('button');
  noneItem.className = 'gv-fp-item';
  noneItem.type = 'button';
  noneItem.setAttribute('role', 'option');
  noneItem.textContent = t('folderAsProject_noFolder');
  noneItem.addEventListener('click', () => {
    selectedFolderId = null;
    selectedFolderName = null;
    selectedFolderInstructions = null;
    chip.textContent = t('folderAsProject_selectFolder');
    chip.removeAttribute('data-selected');
    dropdown.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
    clearPreparedInstructions();
  });
  dropdown.appendChild(noneItem);

  /**
   * Render folder items for a given parent level.
   *
   * @param parentId - Parent folder ID, or '__root__' for top-level
   * @param container - DOM element to append items to
   */
  const renderLevel = (parentId: string, container: HTMLElement) => {
    const siblings = childrenOf.get(parentId) ?? [];
    for (const folder of siblings) {
      const hasChildren = childrenOf.has(folder.id);

      const row = document.createElement('div');
      row.className = 'gv-fp-tree-row';

      const item = document.createElement('button');
      item.className = 'gv-fp-item';
      item.type = 'button';
      item.setAttribute('role', 'option');
      item.dataset.folderId = folder.id;

      if (folder.color && folder.color !== 'default') {
        const dot = document.createElement('span');
        dot.className = 'gv-fp-color-dot';
        dot.style.backgroundColor = getFolderColor(folder.color, isDarkMode());
        item.appendChild(dot);
      }

      const label = document.createElement('span');
      label.textContent = folder.name;
      item.appendChild(label);

      item.addEventListener('click', () => selectFolder(folder));
      row.appendChild(item);

      if (hasChildren) {
        const arrow = document.createElement('button');
        arrow.className = 'gv-fp-expand-btn';
        arrow.type = 'button';
        arrow.setAttribute('aria-label', t('folderAsProject_expand'));
        arrow.setAttribute('aria-expanded', 'false');
        arrow.innerHTML =
          '<svg class="gv-fp-expand-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z"/></svg>';

        const sublist = document.createElement('div');
        sublist.className = 'gv-fp-sublist';
        sublist.hidden = true;

        arrow.addEventListener('click', (e) => {
          e.stopPropagation();
          const expanding = sublist.hidden;
          sublist.hidden = !expanding;
          arrow.classList.toggle('gv-fp-expand-btn--open', expanding);
          arrow.setAttribute('aria-expanded', String(expanding));
          arrow.setAttribute(
            'aria-label',
            expanding ? t('folderAsProject_collapse') : t('folderAsProject_expand'),
          );
          // Lazy render children on first expand
          if (expanding && sublist.children.length === 0) {
            renderLevel(folder.id, sublist);
          }
        });

        row.appendChild(arrow);
        container.appendChild(row);
        container.appendChild(sublist);
      } else {
        container.appendChild(row);
      }
    }
  };

  renderLevel('__root__', dropdown);
}

function buildFolderPicker(
  manager: FolderManager,
  generation: number,
): {
  element: HTMLElement;
  chip: HTMLButtonElement;
  cleanup: () => void;
} {
  const container = document.createElement('div');
  container.className = 'gv-fp-picker-container';

  const chip = document.createElement('button');
  chip.className = 'gv-fp-chip';
  chip.type = 'button';
  chip.setAttribute('aria-haspopup', 'listbox');
  chip.setAttribute('aria-expanded', 'false');
  chip.textContent = t('folderAsProject_selectFolder');

  // Match font-size from the model picker button so it scales with ChatGPT CSS
  const modelBtn = document.querySelector<HTMLElement>('.model-picker-container button');
  if (modelBtn) {
    chip.style.fontSize = getComputedStyle(modelBtn).fontSize;
  }

  const dropdown = document.createElement('div');
  dropdown.className = 'gv-fp-dropdown';
  dropdown.setAttribute('role', 'listbox');
  dropdown.hidden = true;

  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!isActiveActivation(generation)) return;
    const isOpen = !dropdown.hidden;
    if (!isOpen) {
      void populateDropdown(dropdown, manager, chip, generation);
    }
    dropdown.hidden = isOpen;
    chip.setAttribute('aria-expanded', String(!isOpen));
  });

  const closeOnOutsideClick = (e: MouseEvent) => {
    if (!container.contains(e.target as Node)) {
      dropdown.hidden = true;
      chip.setAttribute('aria-expanded', 'false');
    }
  };
  document.addEventListener('click', closeOnOutsideClick);

  container.appendChild(chip);
  container.appendChild(dropdown);
  return {
    element: container,
    chip,
    cleanup: () => document.removeEventListener('click', closeOnOutsideClick),
  };
}

// ============================================================================
// Pending folder selection (from "New chat in folder" menu)
// ============================================================================

/**
 * Reads a pending folder ID written by the folder manager's
 * "New chat in this folder" menu item. When found, auto-selects the folder
 * in the picker and clears the pending value.
 */
export async function applyPendingFolderSelection(
  manager: FolderManager,
  chip: HTMLButtonElement,
  generation?: number,
): Promise<void> {
  if (!chrome.storage?.local) return;
  const isCurrent = () => generation === undefined || isActiveActivation(generation);
  if (!isCurrent()) return;

  const result = await chrome.storage.local.get([StorageKeys.FOLDER_PROJECT_PENDING_FOLDER_ID]);
  if (!isCurrent()) return;
  const pendingId = result?.[StorageKeys.FOLDER_PROJECT_PENDING_FOLDER_ID];
  if (!pendingId) return;

  // Clear immediately to avoid re-application
  await chrome.storage.local.remove([StorageKeys.FOLDER_PROJECT_PENDING_FOLDER_ID]);
  if (!isCurrent()) return;

  await manager.ensureDataLoaded();
  if (!isCurrent()) return;
  const folder = manager.getFolders().find((f) => f.id === pendingId);
  if (!folder) return;

  selectedFolderId = folder.id;
  selectedFolderName = folder.name;
  selectedFolderInstructions = folder.instructions ?? null;

  chip.textContent = `Folder: ${folder.name}`;
  chip.dataset.selected = folder.id;
}

// ============================================================================
// Picker lifecycle
// ============================================================================

function removePicker(): void {
  pickerCleanup?.();
  pickerCleanup = null;
  pickerContainer?.remove();
  pickerContainer = null;
}

async function injectPicker(manager: FolderManager, generation: number): Promise<void> {
  if (!isActiveActivation(generation) || pickerContainer) return;

  // Target the model-picker-container inside trailing-actions-wrapper (right side)
  const modelPicker = await waitForElement('.model-picker-container', 5000, () =>
    isActiveActivation(generation),
  );

  // Guard: if the feature stopped or navigation changed while waiting, abort.
  if (!isActiveActivation(generation) || !isNewChatPath(window.location.pathname)) return;
  // Guard: don't inject twice
  if (document.querySelector('.gv-fp-picker-container')) return;

  if (modelPicker?.parentElement) {
    const { element, cleanup, chip } = buildFolderPicker(manager, generation);
    if (!isActiveActivation(generation)) {
      cleanup();
      return;
    }
    // Insert before the model picker in trailing-actions-wrapper
    modelPicker.parentElement.insertBefore(element, modelPicker);
    pickerContainer = element;
    pickerCleanup = cleanup;
    void applyPendingFolderSelection(manager, chip, generation);
    return;
  }

  // Fallback: insert before rich-textarea (original behavior)
  const richTextarea = await waitForElement('rich-textarea', 3000, () =>
    isActiveActivation(generation),
  );
  if (!richTextarea) return;
  if (!isActiveActivation(generation) || !isNewChatPath(window.location.pathname)) return;
  if (document.querySelector('.gv-fp-picker-container')) return;

  const parent = richTextarea.parentElement;
  if (parent) {
    const { element, cleanup, chip } = buildFolderPicker(manager, generation);
    if (!isActiveActivation(generation)) {
      cleanup();
      return;
    }
    parent.insertBefore(element, richTextarea);
    pickerContainer = element;
    pickerCleanup = cleanup;
    void applyPendingFolderSelection(manager, chip, generation);
  }
}

// ============================================================================
// Conversation title
// ============================================================================

function getConversationTitle(convId: string): string {
  const escapedId = convId.replace(/"/g, '\\"');
  const link = document.querySelector<HTMLAnchorElement>(
    `a[href*="/c/${escapedId}"], a[href*="/c/"][href$="/${escapedId}"]`,
  );
  return link?.textContent?.trim() || document.title || 'New Chat';
}

// ============================================================================
// URL change handler
// ============================================================================

function handleNavigation(
  manager: FolderManager,
  prevPath: string,
  newPath: string,
  generation: number,
): void {
  if (!isActiveActivation(generation)) return;
  const prevWasNewChat = isNewChatPath(prevPath);
  const newConvId = extractConvId(newPath);

  // User sent their first message: new chat -> conversation.
  // Gate on pendingSend to avoid false assignment when clicking sidebar links
  if (prevWasNewChat && newConvId && selectedFolderId && pendingSend) {
    const title = getConversationTitle(newConvId);
    const customGptId = extractCustomGptId(newPath);
    manager.addConversationToFolderFromNative(
      selectedFolderId,
      newConvId,
      title,
      window.location.href,
      customGptId !== null,
      customGptId ?? undefined,
    );
    selectedFolderId = null;
    selectedFolderName = null;
    selectedFolderInstructions = null;
    clearPendingSendState();
  }

  if (isNewChatPath(newPath)) {
    // Navigated to a new chat page -> (re)show picker.
    selectedFolderId = null;
    selectedFolderName = null;
    selectedFolderInstructions = null;
    clearPendingSendState();
    clearPreparedInstructions();
    removePicker();
    void injectPicker(manager, generation);
  } else {
    // Left the new-chat page -> hide picker.
    clearPendingSendState();
    removePicker();
  }
}

// ============================================================================
// URL watcher
// ============================================================================

function stopURLWatcher(): void {
  if (urlWatcherInterval !== null) {
    clearInterval(urlWatcherInterval);
    urlWatcherInterval = null;
  }
  if (urlWatcherCheckFn) {
    window.removeEventListener('popstate', urlWatcherCheckFn);
    window.removeEventListener('hashchange', urlWatcherCheckFn);
    urlWatcherCheckFn = null;
  }
  teardownSendDetection();
}

function startURLWatcher(manager: FolderManager, generation: number): void {
  // Clean up any existing watcher (idempotent for toggle cycles)
  stopURLWatcher();

  lastHref = window.location.href;

  const checkUrl = () => {
    if (!isActiveActivation(generation)) return;
    const current = window.location.href;
    if (current === lastHref) return;
    const prevPath = new URL(lastHref).pathname;
    const newPath = new URL(current).pathname;
    lastHref = current;
    handleNavigation(manager, prevPath, newPath, generation);
  };

  urlWatcherCheckFn = checkUrl;
  urlWatcherInterval = setInterval(checkUrl, 500);
  window.addEventListener('popstate', checkUrl);
  window.addEventListener('hashchange', checkUrl);

  // Also check on initial load
  if (isNewChatPath(window.location.pathname)) {
    void injectPicker(manager, generation);
  }

  setupSendDetection();
}

// ============================================================================
// Entry point
// ============================================================================

function deactivateFolderProject(dropPendingSelection: boolean): void {
  featureInitialized = false;
  activationGeneration += 1;
  stopURLWatcher();
  clearPreparedInstructions();
  removePicker();
  selectedFolderId = null;
  selectedFolderName = null;
  selectedFolderInstructions = null;

  if (dropPendingSelection) {
    // An explicit user disable must not auto-select an old folder when the
    // option is later re-enabled. Lifecycle teardown preserves the handoff.
    void chrome.storage?.local?.remove([StorageKeys.FOLDER_PROJECT_PENDING_FOLDER_ID]);
  }
}

function activateFolderProject(manager: FolderManager): void {
  if (featureInitialized) return;
  featureInitialized = true;
  const generation = ++activationGeneration;
  startURLWatcher(manager, generation);
}

export function stopFolderProject(): void {
  if (!started && !featureInitialized && !storageChangeHandler && !removePageExitListener) return;
  started = false;
  lifecycleGeneration += 1;
  deactivateFolderProject(false);
  ctrlEnterSendEnabled = false;

  if (storageChangeHandler) {
    try {
      chrome.storage?.onChanged?.removeListener(storageChangeHandler);
    } catch {
      // Ignore cleanup errors while the extension context is being torn down.
    }
    storageChangeHandler = null;
  }

  if (removePageExitListener) {
    removePageExitListener();
    removePageExitListener = null;
  }
}

/**
 * Initialise the Folder-as-Project feature. Reads the enabled flag from
 * chrome.storage.sync and sets up the URL watcher + picker injection.
 *
 * @param manager - The active FolderManager instance
 */
export function startFolderProject(manager: FolderManager): () => void {
  if (started) return stopFolderProject;
  started = true;
  const generation = ++lifecycleGeneration;
  let featureSettingChanged = false;
  let ctrlSettingChanged = false;

  storageChangeHandler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (!isCurrentLifecycle(generation) || area !== 'sync') return;

    if (StorageKeys.CTRL_ENTER_SEND in changes) {
      ctrlSettingChanged = true;
      ctrlEnterSendEnabled = changes[StorageKeys.CTRL_ENTER_SEND].newValue === true;
    }

    if (!(StorageKeys.FOLDER_PROJECT_ENABLED in changes)) return;
    featureSettingChanged = true;
    if (changes[StorageKeys.FOLDER_PROJECT_ENABLED].newValue === true) {
      activateFolderProject(manager);
    } else {
      deactivateFolderProject(true);
    }
  };

  try {
    chrome.storage?.onChanged?.addListener(storageChangeHandler);
  } catch {
    storageChangeHandler = null;
  }

  removePageExitListener = addPageExitListener(stopFolderProject);

  chrome.storage?.sync?.get(
    {
      [StorageKeys.FOLDER_PROJECT_ENABLED]: false,
      [StorageKeys.CTRL_ENTER_SEND]: false,
    },
    (res) => {
      if (!isCurrentLifecycle(generation)) return;
      if (!ctrlSettingChanged) {
        ctrlEnterSendEnabled = res?.[StorageKeys.CTRL_ENTER_SEND] === true;
      }
      if (!featureSettingChanged && res?.[StorageKeys.FOLDER_PROJECT_ENABLED] === true) {
        activateFolderProject(manager);
      }
    },
  );

  return stopFolderProject;
}
