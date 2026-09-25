/**
 * Conversation shortcuts mounted at the top-left of ChatGPT's header.
 *
 * The folder shortcut is the Issue #8 compatibility entry point; beside it
 * sits a read-only title of the current conversation, kept in sync with
 * ChatGPT's native title sources. The Issue #9 rename shortcut was removed in
 * 1.8.15 because ChatGPT's own "…" conversation menu already covers rename.
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
import { buildClonedButtonClassName } from '../shared/clonedButtonClass';
import { findActivePageHeader, findHeaderLeftSlot } from '../shared/headerActionSlot';

const FOLDER_TAG = 'data-gv-folder-header-btn';
const TITLE_TAG = 'data-gv-conversation-title-header';
const INJECT_DEBOUNCE_MS = 50;

let lifecycleGeneration = 0;
let activeGeneration: number | null = null;
let injectedFolderButton: HTMLButtonElement | null = null;
let injectedTitle: HTMLSpanElement | null = null;
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
  injectedFolderButton?.remove();
  injectedTitle?.remove();
  injectedFolderButton = null;
  injectedTitle = null;
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

  const slot = findHeaderLeftSlot();
  if (!slot) return;
  const { parent: host, before, styleSource } = slot;
  if (
    (injectedFolderButton && injectedFolderButton.parentElement !== host) ||
    (injectedTitle && injectedTitle.parentElement !== host)
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
    element.matches('header#page-header') ||
    element.closest('header#page-header') !== null ||
    (includeDescendants && element.querySelector('header#page-header') !== null)
  );
}

function mutationsMayAffectHeader(records: MutationRecord[]): boolean {
  const trackedButtonInvalid =
    (injectedFolderButton && !injectedFolderButton.isConnected) ||
    (injectedTitle && !injectedTitle.isConnected);
  const knownHeader =
    injectedFolderButton?.closest<HTMLElement>('header#page-header') ||
    injectedTitle?.closest<HTMLElement>('header#page-header') ||
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
    (injectedFolderButton && injectedFolderButton.closest('header#page-header') !== header) ||
    (injectedTitle && injectedTitle.closest('header#page-header') !== header)
  ) {
    return true;
  }

  return records.some((record) => {
    if (record.target instanceof Element && record.target.matches('header#page-header'))
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
    .querySelectorAll<HTMLElement>(`[${FOLDER_TAG}], [${TITLE_TAG}]`)
    .forEach((button) => button.remove());
}
