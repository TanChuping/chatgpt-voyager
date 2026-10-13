/**
 * Conversation shortcuts mounted at the top-left of ChatGPT's header.
 *
 * The folder shortcut is the Issue #8 compatibility entry point; beside it
 * sits a read-only title of the current conversation, kept in sync with
 * ChatGPT's native title sources. Rename delegates to the native conversation
 * menu, so ChatGPT owns the dialog, title update and persistence.
 */
import { getTranslationSync } from '@/utils/i18n';

import {
  extractChatGptConversationIdFromUrl,
  findChatGptSidebar,
  getChatGptConversationElements,
  getChatGptConversationId,
  getChatGptConversationTitle,
} from '../chatgptDom';
import { createFolderSvgIcon } from '../folder/folderIcon';
import type { FolderManager } from '../folder/manager';
import {
  findRenameConversationMenuItem,
  isNativeConversationMenuBoundToTrigger,
} from '../folder/nativeConversationBridge';
import { buildClonedButtonClassName } from '../shared/clonedButtonClass';
import {
  PAGE_HEADER_SELECTOR,
  findActivePageHeader,
  findHeaderLeftSlot,
} from '../shared/headerActionSlot';

const FOLDER_TAG = 'data-gv-folder-header-btn';
const TITLE_TAG = 'data-gv-conversation-title-header';
const RENAME_TAG = 'data-gv-conversation-rename-header-btn';
const INJECT_DEBOUNCE_MS = 50;

let lifecycleGeneration = 0;
let activeGeneration: number | null = null;
let injectedFolderButton: HTMLButtonElement | null = null;
let injectedTitle: HTMLSpanElement | null = null;
let injectedRenameButton: HTMLButtonElement | null = null;
let stopPendingRename: (() => void) | null = null;
let folderManager: FolderManager | null = null;
let observer: MutationObserver | null = null;
let titleObserver: MutationObserver | null = null;
let injectTimer: number | null = null;
let locationChangeHandler: (() => void) | null = null;

function isActiveGeneration(generation: number): boolean {
  return activeGeneration === generation;
}

function getCurrentConversationId(): string | null {
  try {
    return extractChatGptConversationIdFromUrl(window.location.href);
  } catch {
    return null;
  }
}

function isConversationPage(): boolean {
  return getCurrentConversationId() !== null;
}

function removeTrackedButtons(): void {
  stopPendingRename?.();
  injectedFolderButton?.remove();
  injectedTitle?.remove();
  injectedRenameButton?.remove();
  injectedFolderButton = null;
  injectedTitle = null;
  injectedRenameButton = null;
}

function openNativeRename(generation: number): void {
  stopPendingRename?.();
  const conversationId = getCurrentConversationId();
  const trigger = findActivePageHeader()?.querySelector<HTMLElement>(
    '[data-testid="conversation-options-button"]',
  );
  if (!trigger || !conversationId) return;
  const menuObserver = new MutationObserver(activate);
  const timeout = window.setTimeout(cleanup, 2000);
  function cleanup(): void {
    menuObserver.disconnect();
    window.clearTimeout(timeout);
    stopPendingRename = null;
  }
  function activate(): boolean {
    if (
      !isActiveGeneration(generation) ||
      getCurrentConversationId() !== conversationId ||
      !trigger?.isConnected
    ) {
      cleanup();
      return false;
    }
    const menu = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]')).find(
      (candidate) => isNativeConversationMenuBoundToTrigger(candidate, trigger),
    );
    const rename = menu && findRenameConversationMenuItem(menu);
    if (!rename) return false;
    cleanup();
    rename.click();
    return true;
  }
  stopPendingRename = cleanup;
  if (activate()) return;
  menuObserver.observe(document.body, { childList: true, subtree: true });
  // Radix opens on pointerdown. Preserve its own rename dialog and save flow.
  const Pointer = window.PointerEvent ?? MouseEvent;
  trigger.dispatchEvent(
    new Pointer('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
    }),
  );
  trigger.dispatchEvent(
    new Pointer('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }),
  );
  activate();
}

function createRenameIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({
    width: '20',
    height: '20',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }))
    svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', 'm16 3 5 5-13 13-5 1 1-5L16 3z M14 5l5 5');
  svg.appendChild(path);
  return svg;
}

function normalizeTitle(value: string | null | undefined): string | null {
  const title = (value || '').replace(/\s+/g, ' ').trim();
  return title || null;
}

type NativeTitleSource = 'sidebar-title' | 'header-title' | 'document-title';

function readNativeConversationTitleSources(
  conversationId: string,
): Map<NativeTitleSource, string | null> {
  const titles = new Map<NativeTitleSource, string | null>();
  const sidebarTitles = new Set<string>();
  const sidebar = findChatGptSidebar();
  for (const conversation of sidebar ? getChatGptConversationElements(sidebar) : []) {
    if (getChatGptConversationId(conversation) !== conversationId) continue;
    const sidebarTitle = normalizeTitle(getChatGptConversationTitle(conversation));
    if (sidebarTitle) sidebarTitles.add(sidebarTitle);
  }
  // Duplicate virtualized rows can temporarily disagree. Such a source is
  // ambiguous, so the title falls back to the header/document sources.
  if (sidebarTitles.size === 1) {
    titles.set('sidebar-title', [...sidebarTitles][0]);
  } else if (sidebarTitles.size > 1) {
    titles.set('sidebar-title', null);
  }

  const activeHeader = findActivePageHeader();
  const headerTitle = normalizeTitle(
    activeHeader?.querySelector<HTMLElement>('[data-testid="conversation-title"], h1')?.textContent,
  );
  if (headerTitle) titles.set('header-title', headerTitle);

  const documentTitle = normalizeTitle(
    document.title.replace(/\s+-\s*(?:ChatGPT|OpenAI)\s*$/i, ''),
  );
  if (documentTitle) titles.set('document-title', documentTitle);
  return titles;
}

function readCurrentConversationTitle(conversationId: string): string {
  const sources = readNativeConversationTitleSources(conversationId);
  return (
    sources.get('sidebar-title') ||
    sources.get('header-title') ||
    sources.get('document-title') ||
    getTranslationSync('conversation_untitled')
  );
}

function refreshInjectedTitle(): void {
  if (!injectedTitle?.isConnected) return;
  const conversationId = getCurrentConversationId();
  if (!conversationId) return;
  const title = readCurrentConversationTitle(conversationId);
  if (injectedTitle.textContent !== title) injectedTitle.textContent = title;
  if (injectedTitle.title !== title) injectedTitle.title = title;
  if (injectedTitle.getAttribute('aria-label') !== title) {
    injectedTitle.setAttribute('aria-label', title);
  }
}

function createHeaderButton(
  styleSource: HTMLElement,
  className: string,
  tag: string,
  label: string,
  icon: SVGSVGElement,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = buildClonedButtonClassName(styleSource.className, className);
  button.type = 'button';
  button.setAttribute(tag, '1');
  button.setAttribute('aria-label', label);
  button.title = label;
  button.replaceChildren(icon);
  return button;
}

function createHeaderTitle(): HTMLSpanElement {
  const title = document.createElement('span');
  title.className = 'gv-conversation-title-header';
  title.setAttribute(TITLE_TAG, '1');
  return title;
}

function injectIfNeeded(generation: number): void {
  if (!isActiveGeneration(generation)) return;
  if (!isConversationPage()) {
    titleObserver?.disconnect();
    titleObserver = null;
    removeTrackedButtons();
    return;
  }

  if (injectedFolderButton && !injectedFolderButton.isConnected) injectedFolderButton = null;
  if (injectedTitle && !injectedTitle.isConnected) injectedTitle = null;
  if (injectedRenameButton && !injectedRenameButton.isConnected) injectedRenameButton = null;

  const slot = findHeaderLeftSlot();
  if (!slot) return;
  const { parent: host, before, styleSource } = slot;
  if (
    (injectedFolderButton && injectedFolderButton.parentElement !== host) ||
    (injectedTitle && injectedTitle.parentElement !== host) ||
    (injectedRenameButton && injectedRenameButton.parentElement !== host)
  ) {
    removeTrackedButtons();
  }

  injectedFolderButton =
    host.querySelector<HTMLButtonElement>(`[${FOLDER_TAG}]`) || injectedFolderButton;
  if (!injectedFolderButton) {
    const label = getTranslationSync('conversation_move_to_folder');
    injectedFolderButton = createHeaderButton(
      styleSource,
      'gv-folder-header-btn',
      FOLDER_TAG,
      label,
      createFolderSvgIcon(20),
    );
    injectedFolderButton.addEventListener('click', (event) => {
      if (!isActiveGeneration(generation)) return;
      event.preventDefault();
      event.stopPropagation();
      folderManager?.openMoveToFolderDialogForCurrentConversation();
    });
    host.insertBefore(injectedFolderButton, injectedTitle ?? before);
  }

  injectedTitle = host.querySelector<HTMLSpanElement>(`[${TITLE_TAG}]`) || injectedTitle;
  if (!injectedTitle) {
    injectedTitle = createHeaderTitle();
    host.insertBefore(injectedTitle, before);
  }
  injectedRenameButton =
    host.querySelector<HTMLButtonElement>(`[${RENAME_TAG}]`) || injectedRenameButton;
  if (!injectedRenameButton) {
    injectedRenameButton = createHeaderButton(
      styleSource,
      'gv-conversation-rename-header-btn',
      RENAME_TAG,
      getTranslationSync('conversation_rename'),
      createRenameIcon(),
    );
    injectedRenameButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (isActiveGeneration(generation)) openNativeRename(generation);
    });
    host.insertBefore(injectedRenameButton, injectedTitle);
  }
  refreshInjectedTitle();
  bindNativeTitleObserver(generation);
}

function bindNativeTitleObserver(generation: number): void {
  titleObserver?.disconnect();
  titleObserver = null;
  if (!isActiveGeneration(generation) || !isConversationPage()) return;

  const targets = new Set<HTMLElement>();
  const sidebar = findChatGptSidebar();
  if (sidebar) targets.add(sidebar);
  const headerTitle = findActivePageHeader()?.querySelector<HTMLElement>(
    '[data-testid="conversation-title"], h1',
  );
  if (headerTitle) targets.add(headerTitle);
  const documentTitle = document.querySelector<HTMLElement>('title');
  if (documentTitle) targets.add(documentTitle);
  if (targets.size === 0) return;

  titleObserver = new MutationObserver(() => {
    if (isActiveGeneration(generation)) refreshInjectedTitle();
  });
  for (const target of targets) {
    titleObserver.observe(target, {
      attributes: true,
      attributeFilter: ['aria-label', 'title'],
      childList: true,
      characterData: true,
      subtree: true,
    });
  }
}

function nodeTouchesHeader(
  node: Node,
  header: HTMLElement | null,
  includeDescendants = false,
): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  if (!element) return false;
  if (header && (element === header || header.contains(element))) {
    return true;
  }
  return (
    element.matches(PAGE_HEADER_SELECTOR) ||
    element.closest(PAGE_HEADER_SELECTOR) !== null ||
    (includeDescendants && element.querySelector(PAGE_HEADER_SELECTOR) !== null)
  );
}

function mutationsMayAffectHeader(records: MutationRecord[]): boolean {
  const trackedButtonInvalid =
    (injectedFolderButton && !injectedFolderButton.isConnected) ||
    (injectedTitle && !injectedTitle.isConnected) ||
    (injectedRenameButton && !injectedRenameButton.isConnected);
  const knownHeader =
    injectedFolderButton?.closest<HTMLElement>(PAGE_HEADER_SELECTOR) ||
    injectedTitle?.closest<HTMLElement>(PAGE_HEADER_SELECTOR) ||
    null;
  const recordsTouchHeader = records.some(
    (record) =>
      nodeTouchesHeader(record.target, knownHeader) ||
      [...record.addedNodes, ...record.removedNodes].some((node) =>
        nodeTouchesHeader(node, knownHeader, true),
      ),
  );
  // Streaming answer text mutates the main conversation tree. Avoid the
  // visibility/layout work below unless the header itself or a tracked node
  // actually changed.
  if (!trackedButtonInvalid && !recordsTouchHeader) return false;

  const header = findActivePageHeader();
  if (
    !header ||
    trackedButtonInvalid ||
    (injectedFolderButton && injectedFolderButton.closest(PAGE_HEADER_SELECTOR) !== header) ||
    (injectedTitle && injectedTitle.closest(PAGE_HEADER_SELECTOR) !== header)
  ) {
    return true;
  }

  return records.some((record) => {
    if (record.target instanceof Element && record.target.matches(PAGE_HEADER_SELECTOR))
      return true;
    if (header.contains(record.target)) return true;
    return [...record.addedNodes, ...record.removedNodes].some((node) =>
      nodeTouchesHeader(node, header, true),
    );
  });
}

function nodeTouchesSidebarHost(node: Node, includeDescendants = false): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  if (!element) return false;
  const selector =
    '#stage-slideover-sidebar, [id="sidebar"], [data-testid="sidebar"], [data-testid="history-sidebar"], [data-testid="conversation-sidebar"]';
  return (
    element.matches(selector) ||
    element.closest(selector) !== null ||
    (includeDescendants && element.querySelector(selector) !== null)
  );
}

function mutationsMayAffectSidebarHost(records: MutationRecord[]): boolean {
  return records.some(
    (record) =>
      nodeTouchesSidebarHost(record.target) ||
      [...record.addedNodes, ...record.removedNodes].some((node) =>
        nodeTouchesSidebarHost(node, true),
      ),
  );
}

function scheduleInjection(generation: number): void {
  if (!isActiveGeneration(generation)) return;
  if (injectTimer !== null) window.clearTimeout(injectTimer);
  injectTimer = window.setTimeout(() => {
    injectTimer = null;
    injectIfNeeded(generation);
  }, INJECT_DEBOUNCE_MS);
}

export function startFolderHeaderButton(manager: FolderManager): () => void {
  folderManager = manager;

  if (activeGeneration !== null) {
    injectIfNeeded(activeGeneration);
    return stopFolderHeaderButton;
  }

  const generation = ++lifecycleGeneration;
  activeGeneration = generation;
  injectIfNeeded(generation);

  observer = new MutationObserver((records) => {
    if (mutationsMayAffectHeader(records) || mutationsMayAffectSidebarHost(records)) {
      scheduleInjection(generation);
    }
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['aria-hidden', 'class', 'hidden', 'inert', 'style'],
    childList: true,
    subtree: true,
  });

  locationChangeHandler = () => scheduleInjection(generation);
  window.addEventListener('popstate', locationChangeHandler);
  window.addEventListener('hashchange', locationChangeHandler);
  window.addEventListener('gv-location-change', locationChangeHandler);
  return stopFolderHeaderButton;
}

export function stopFolderHeaderButton(): void {
  activeGeneration = null;
  lifecycleGeneration++;
  folderManager = null;
  if (injectTimer !== null) {
    window.clearTimeout(injectTimer);
    injectTimer = null;
  }
  observer?.disconnect();
  observer = null;
  titleObserver?.disconnect();
  titleObserver = null;
  if (locationChangeHandler) {
    window.removeEventListener('popstate', locationChangeHandler);
    window.removeEventListener('hashchange', locationChangeHandler);
    window.removeEventListener('gv-location-change', locationChangeHandler);
    locationChangeHandler = null;
  }
  removeTrackedButtons();
  document
    .querySelectorAll<HTMLElement>(`[${FOLDER_TAG}], [${TITLE_TAG}], [${RENAME_TAG}]`)
    .forEach((button) => button.remove());
}
