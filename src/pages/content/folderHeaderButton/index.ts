/**
 * "Add this conversation to a folder" button, top-left of the conversation
 * header.
 *
 * A build up to 1.7.4 had a button here; ChatGPT's 2026-07 header redesign took
 * it away, and issue #8 asked for it back. Today the same action lives in the
 * conversation's "…" menu, so this is a **second** entry point rather than the
 * only one — hence off by default, and only imported when the user turns it on
 * (see the `folder-header-button` lazy definition in `bootstrap/features.ts`).
 *
 * Clicking it opens the folder manager's move-to-folder dialog for whatever
 * conversation is on screen. The button hides itself outside a conversation,
 * where there is nothing to file.
 *
 * Structure mirrors `conversationExport/topBarButton.ts`: a generation counter
 * makes every async continuation abandonable, and a debounced, header-scoped
 * MutationObserver re-injects after ChatGPT replaces the header (which it does
 * on every route change).
 */
import { getTranslationSync } from '@/utils/i18n';

import { extractChatGptConversationIdFromUrl } from '../chatgptDom';
import { createFolderSvgIcon } from '../folder/folderIcon';
import type { FolderManager } from '../folder/manager';
import { buildClonedButtonClassName } from '../shared/clonedButtonClass';
import { findHeaderLeftSlot } from '../shared/headerActionSlot';

const TAG = 'data-gv-folder-header-btn';
const INJECT_DEBOUNCE_MS = 50;

let lifecycleGeneration = 0;
let activeGeneration: number | null = null;
let injectedButton: HTMLButtonElement | null = null;
let folderManager: FolderManager | null = null;
let observer: MutationObserver | null = null;
let injectTimer: number | null = null;
let locationChangeHandler: (() => void) | null = null;

function isActiveGeneration(generation: number): boolean {
  return activeGeneration === generation;
}

function isConversationPage(): boolean {
  try {
    return extractChatGptConversationIdFromUrl(window.location.href) !== null;
  } catch {
    return false;
  }
}

function removeTrackedButton(): void {
  injectedButton?.remove();
  injectedButton = null;
}

function injectIfNeeded(generation: number): void {
  if (!isActiveGeneration(generation)) return;

  // Nothing to file outside a conversation — drop the button rather than
  // leaving one that opens a dialog for a conversation that doesn't exist.
  if (!isConversationPage()) {
    removeTrackedButton();
    return;
  }

  if (injectedButton && !injectedButton.isConnected) removeTrackedButton();

  const slot = findHeaderLeftSlot();
  if (!slot) return;
  const { parent: host, before, styleSource } = slot;

  if (injectedButton && injectedButton.parentElement !== host) removeTrackedButton();
  const existing = host.querySelector<HTMLButtonElement>(`[${TAG}]`);
  if (existing) {
    injectedButton = existing;
    return;
  }

  const label = getTranslationSync('conversation_move_to_folder');

  const button = document.createElement('button');
  // Clone the header's own icon-button styling so padding, rounding, hover and
  // focus rings track ChatGPT's, minus any transient disabled classes.
  button.className = buildClonedButtonClassName(styleSource.className, 'gv-folder-header-btn');
  button.type = 'button';
  button.setAttribute(TAG, '1');
  button.setAttribute('aria-label', label);
  button.title = label;
  button.replaceChildren(createFolderSvgIcon(20));

  button.addEventListener('click', (event) => {
    if (!isActiveGeneration(generation)) return;
    event.preventDefault();
    event.stopPropagation();
    folderManager?.openMoveToFolderDialogForCurrentConversation();
  });

  host.insertBefore(button, before);
  injectedButton = button;
}

function nodeTouchesHeader(node: Node, header: HTMLElement | null): boolean {
  if (!(node instanceof Element)) return false;
  if (header && (node === header || header.contains(node) || node.contains(header))) return true;
  return node.querySelector('header#page-header') !== null;
}

function mutationsMayAffectHeader(records: MutationRecord[]): boolean {
  const header = document.querySelector<HTMLElement>('header#page-header');
  if (!header || (injectedButton && !injectedButton.isConnected)) return true;

  return records.some((record) => {
    if (header.contains(record.target)) return true;
    return [...record.addedNodes, ...record.removedNodes].some((node) =>
      nodeTouchesHeader(node, header),
    );
  });
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
    if (mutationsMayAffectHeader(records)) scheduleInjection(generation);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  locationChangeHandler = () => scheduleInjection(generation);
  window.addEventListener('popstate', locationChangeHandler);
  window.addEventListener('hashchange', locationChangeHandler);

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
  if (locationChangeHandler) {
    window.removeEventListener('popstate', locationChangeHandler);
    window.removeEventListener('hashchange', locationChangeHandler);
    locationChangeHandler = null;
  }
  removeTrackedButton();
  document.querySelectorAll<HTMLElement>(`[${TAG}]`).forEach((button) => button.remove());
}
