/**
 * Conversation shortcuts mounted at the top-left of ChatGPT's header.
 *
 * The folder shortcut is the Issue #8 compatibility entry point. Issue #9
 * adds a neighbouring rename shortcut. Rename deliberately drives ChatGPT's
 * own menu/dialog rather than calling an undocumented backend endpoint, so
 * authentication, validation and server persistence remain native.
 */
import { getTranslationSync } from '@/utils/i18n';

import {
  extractChatGptConversationIdFromUrl,
  getChatGptConversationElements,
  getChatGptConversationId,
  getChatGptConversationTitle,
} from '../chatgptDom';
import { createFolderSvgIcon } from '../folder/folderIcon';
import type { FolderManager } from '../folder/manager';
import {
  type NativeMenuOwnershipSnapshot,
  clearNativeMenuOwnership,
  closeNativeConversationMenu,
  createNativeMenuOwnershipSnapshot,
  findRenameConversationMenuItem,
  getNativeConversationMenus,
  isElementOpen,
  isOwnedNativeConversationMenu,
} from '../folder/nativeConversationBridge';
import { buildClonedButtonClassName } from '../shared/clonedButtonClass';
import { findActivePageHeader, findHeaderLeftSlot } from '../shared/headerActionSlot';

const FOLDER_TAG = 'data-gv-folder-header-btn';
const RENAME_TAG = 'data-gv-conversation-rename-header-btn';
const INJECT_DEBOUNCE_MS = 50;
const NATIVE_MENU_WAIT_MS = 2500;
const NATIVE_EDITOR_WAIT_MS = 2500;
const NATIVE_RENAME_LIFECYCLE_MS = 120_000;
const NATIVE_COMMIT_CONFIRM_MS = 15_000;
const NATIVE_COMMIT_STABLE_MS = 2000;
const RENAME_EDITOR_SELECTOR =
  'input:not([type]), input[type="text"], textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]:not([role])';

let lifecycleGeneration = 0;
let activeGeneration: number | null = null;
let injectedFolderButton: HTMLButtonElement | null = null;
let injectedRenameButton: HTMLButtonElement | null = null;
let folderManager: FolderManager | null = null;
let observer: MutationObserver | null = null;
let injectTimer: number | null = null;
let locationChangeHandler: (() => void) | null = null;
let activeRenameController: AbortController | null = null;
let postCommitVerificationCleanup: (() => void) | null = null;

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

function createRenameIcon(size = 20): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 20h9');
  const pencil = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pencil.setAttribute('d', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z');
  svg.append(path, pencil);
  return svg;
}

function cancelActiveRenameOperation(): void {
  activeRenameController?.abort();
  activeRenameController = null;
  postCommitVerificationCleanup?.();
  postCommitVerificationCleanup = null;
  if (injectedRenameButton?.isConnected) injectedRenameButton.disabled = false;
}

function removeTrackedButtons(cancelRename = true): void {
  injectedFolderButton?.remove();
  injectedRenameButton?.remove();
  injectedFolderButton = null;
  injectedRenameButton = null;
  if (cancelRename) cancelActiveRenameOperation();
}

function normalizeTitle(value: string | null | undefined): string | null {
  const title = (value || '').replace(/\s+/g, ' ').trim();
  return title || null;
}

type NativeTitleSource = 'sidebar-title' | 'header-title' | 'document-title';
type NativeTitleSnapshot = ReadonlyMap<NativeTitleSource, string | null>;

function readNativeConversationTitleSources(
  conversationId: string,
): Map<NativeTitleSource, string | null> {
  const titles = new Map<NativeTitleSource, string | null>();
  const sidebarTitles = new Set<string>();
  for (const conversation of getChatGptConversationElements(document)) {
    if (getChatGptConversationId(conversation) !== conversationId) continue;
    const sidebarTitle = normalizeTitle(getChatGptConversationTitle(conversation));
    if (sidebarTitle) sidebarTitles.add(sidebarTitle);
  }
  // Duplicate virtualized rows can temporarily disagree. Such a source is
  // ambiguous and must not prove either success or rollback.
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

function readNativeConversationTitles(conversationId: string): string[] {
  if (getCurrentConversationId() !== conversationId) return [];
  return [
    ...new Set(
      [...readNativeConversationTitleSources(conversationId).values()].filter(
        (title): title is string => typeof title === 'string',
      ),
    ),
  ];
}

function waitForOwnedNativeMenu(
  snapshot: NativeMenuOwnershipSnapshot,
  signal: AbortSignal,
): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    let settled = false;
    const mutationObserver = new MutationObserver(() => check());
    const timer = window.setTimeout(() => finish(null), NATIVE_MENU_WAIT_MS);

    const finish = (menu: HTMLElement | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      mutationObserver.disconnect();
      signal.removeEventListener('abort', onAbort);
      resolve(menu);
    };
    const onAbort = () => finish(null);
    const check = () => {
      const menu = getNativeConversationMenus(document).find((candidate) =>
        isOwnedNativeConversationMenu(candidate, snapshot),
      );
      if (menu) finish(menu);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    mutationObserver.observe(document.body, {
      attributes: true,
      attributeFilter: [
        'aria-controls',
        'aria-expanded',
        'aria-hidden',
        'aria-labelledby',
        'data-state',
        'hidden',
        'style',
      ],
      childList: true,
      subtree: true,
    });
    check();
  });
}

function activateNativeMenuTrigger(trigger: HTMLElement): void {
  const eventInit: PointerEventInit & MouseEventInit = {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: 1,
  };
  if (typeof window.PointerEvent === 'function') {
    trigger.dispatchEvent(
      new PointerEvent('pointerdown', { ...eventInit, pointerId: 1, pointerType: 'mouse' }),
    );
  } else {
    trigger.dispatchEvent(new MouseEvent('pointerdown', eventInit));
  }
  trigger.click();
}

type RenameEditorSnapshot = ReadonlyMap<HTMLElement, boolean>;

function captureRenameEditorSnapshot(): RenameEditorSnapshot {
  return new Map(
    Array.from(document.querySelectorAll<HTMLElement>(RENAME_EDITOR_SELECTOR)).map((editor) => [
      editor,
      isElementOpen(editor),
    ]),
  );
}

function readRenameEditorTitle(editor: HTMLElement): string | null {
  if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
    return normalizeTitle(editor.value);
  }
  return normalizeTitle(editor.textContent);
}

function findNativeRenameEditor(
  snapshot: RenameEditorSnapshot,
  previousTitles: ReadonlySet<string>,
): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(RENAME_EDITOR_SELECTOR),
  ).filter((editor) => isElementOpen(editor) && (!snapshot.has(editor) || !snapshot.get(editor)));

  const ranked = candidates
    .map((editor, index) => {
      const scope = editor.closest<HTMLElement>('[role="dialog"], form, [data-state="open"]');
      const metadata = [
        editor.getAttribute('data-testid'),
        editor.getAttribute('name'),
        editor.getAttribute('aria-label'),
        scope?.getAttribute('aria-label'),
        scope?.textContent,
      ]
        .filter(Boolean)
        .join(' ');
      const score =
        (scope?.matches('[role="dialog"]') ? 20 : 0) +
        (previousTitles.has(readRenameEditorTitle(editor) || '') ? 5 : 0) +
        (/rename|title|重命名|名前|이름|renomm|umbenenn|renombr|renomear|переимен/iu.test(metadata)
          ? 10
          : 0);
      return { editor, index, score };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return ranked[0]?.score > 0 ? ranked[0].editor : null;
}

function waitForNativeRenameEditor(
  snapshot: RenameEditorSnapshot,
  previousTitles: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    let settled = false;
    const observer = new MutationObserver(check);
    const timeout = window.setTimeout(() => finish(null), NATIVE_EDITOR_WAIT_MS);

    const finish = (editor: HTMLElement | null) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve(editor);
    };
    const onAbort = () => finish(null);
    function check(): void {
      const editor = findNativeRenameEditor(snapshot, previousTitles);
      if (editor) finish(editor);
    }

    signal.addEventListener('abort', onAbort, { once: true });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['aria-hidden', 'class', 'data-state', 'hidden', 'inert', 'style'],
      childList: true,
      subtree: true,
    });
    check();
  });
}

function getControlLabel(control: HTMLElement): string {
  return [
    control.getAttribute('data-testid'),
    control.getAttribute('aria-label'),
    control.getAttribute('title'),
    control.textContent,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCancelRenameControl(control: HTMLElement): boolean {
  return /cancel|close|取消|关闭|キャンセル|취소|annuler|abbrechen|cancelar|取消|отмена/iu.test(
    getControlLabel(control),
  );
}

function isCommitRenameControl(control: HTMLButtonElement): boolean {
  if (control.type === 'submit') return true;
  return /save|rename|confirm|done|保存|重命名|确定|変更|저장|renomm|umbenenn|renombr|renomear|переимен/iu.test(
    getControlLabel(control),
  );
}

function startPostCommitVerification(
  conversationId: string,
  submittedTitle: string,
  confirmedSources: ReadonlyMap<NativeTitleSource, string | null>,
): void {
  postCommitVerificationCleanup?.();
  let candidateTitle: string | null = null;
  let candidateSince = 0;
  const startedAt = Date.now();

  const finish = () => {
    window.clearInterval(interval);
    if (postCommitVerificationCleanup === finish) postCommitVerificationCleanup = null;
  };
  const interval = window.setInterval(() => {
    if (
      activeGeneration === null ||
      getCurrentConversationId() !== conversationId ||
      Date.now() - startedAt >= NATIVE_COMMIT_CONFIRM_MS
    ) {
      finish();
      return;
    }

    const currentSources = readNativeConversationTitleSources(conversationId);
    const currentConfirmedTitles = [...confirmedSources.keys()]
      .map((source) => currentSources.get(source) ?? null)
      .filter((title): title is string => Boolean(title));
    const nextCandidate =
      currentConfirmedTitles.length > 0 &&
      currentConfirmedTitles[0] !== submittedTitle &&
      currentConfirmedTitles.every((title) => title === currentConfirmedTitles[0])
        ? currentConfirmedTitles[0]
        : null;
    if (!nextCandidate) {
      candidateTitle = null;
      candidateSince = 0;
      return;
    }
    if (candidateTitle !== nextCandidate) {
      candidateTitle = nextCandidate;
      candidateSince = Date.now();
      return;
    }
    if (Date.now() - candidateSince < NATIVE_COMMIT_STABLE_MS) return;
    folderManager?.applyNativeConversationRename(conversationId, nextCandidate);
    finish();
  }, 250);
  postCommitVerificationCleanup = finish;
}

function monitorNativeRenameLifecycle(
  conversationId: string,
  editor: HTMLElement,
  controller: AbortController,
): Promise<void> {
  return new Promise((resolve) => {
    const { signal } = controller;
    const scope =
      editor.closest<HTMLElement>('[role="dialog"]') ||
      editor.closest<HTMLElement>('form') ||
      editor;
    const form = editor.closest<HTMLFormElement>('form');
    const initialEditorTitle = readRenameEditorTitle(editor);
    const initialNativeTitleSources: NativeTitleSnapshot =
      readNativeConversationTitleSources(conversationId);
    let settled = false;
    let submittedTitle: string | null = null;
    let confirmationDeadline = 0;
    let matchingTitleSince = 0;
    const interval = window.setInterval(check, 250);
    const timeout = window.setTimeout(finish, NATIVE_RENAME_LIFECYCLE_MS);

    function finish(): void {
      if (settled) return;
      settled = true;
      window.clearInterval(interval);
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      form?.removeEventListener('submit', onSubmit, true);
      scope.removeEventListener('click', onClick, true);
      scope.removeEventListener('keydown', onKeyDown, true);
      if (activeRenameController === controller) {
        activeRenameController = null;
        if (injectedRenameButton?.isConnected) injectedRenameButton.disabled = false;
      }
      resolve();
    }

    function beginConfirmation(): void {
      if (settled || getCurrentConversationId() !== conversationId) {
        finish();
        return;
      }
      const title = readRenameEditorTitle(editor);
      if (!title || title === initialEditorTitle) {
        submittedTitle = null;
        confirmationDeadline = 0;
        matchingTitleSince = 0;
        return;
      }
      submittedTitle = title;
      confirmationDeadline = Date.now() + NATIVE_COMMIT_CONFIRM_MS;
      check();
    }

    function onSubmit(): void {
      queueMicrotask(beginConfirmation);
    }

    function onClick(event: Event): void {
      const button =
        event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
      if (!button) return;
      if (isCancelRenameControl(button)) {
        queueMicrotask(finish);
      } else if (isCommitRenameControl(button)) {
        queueMicrotask(beginConfirmation);
      }
    }

    function onKeyDown(event: Event): void {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key === 'Escape') {
        queueMicrotask(finish);
      } else if (event.key === 'Enter' && !event.shiftKey) {
        queueMicrotask(beginConfirmation);
      }
    }

    function check(): void {
      if (settled || signal.aborted || getCurrentConversationId() !== conversationId) {
        finish();
        return;
      }
      if (!submittedTitle) {
        if (!editor.isConnected || !isElementOpen(editor) || !isElementOpen(scope)) finish();
        return;
      }
      const editorClosed = !editor.isConnected || !isElementOpen(editor) || !isElementOpen(scope);
      if (!editorClosed) {
        matchingTitleSince = 0;
        return;
      }
      const observedSources = readNativeConversationTitleSources(conversationId);
      // A pre-existing hidden/virtualized duplicate that already had the
      // submitted text is not proof of success. At least one identity-bound
      // native source must transition to the submitted title after opening the
      // dialog, and that transition must remain stable.
      const hasPostSubmitTransition = [...observedSources.entries()].some(
        ([source, observedTitle]) => {
          const initialTitle = initialNativeTitleSources.get(source);
          return (
            observedTitle === submittedTitle &&
            typeof initialTitle === 'string' &&
            initialTitle !== submittedTitle
          );
        },
      );
      if (hasPostSubmitTransition) {
        if (matchingTitleSince === 0) matchingTitleSince = Date.now();
      } else {
        matchingTitleSince = 0;
      }
      if (matchingTitleSince > 0 && Date.now() - matchingTitleSince >= NATIVE_COMMIT_STABLE_MS) {
        const confirmedSources = new Map<NativeTitleSource, string | null>();
        for (const [source, observedTitle] of observedSources) {
          if (
            observedTitle === submittedTitle &&
            typeof initialNativeTitleSources.get(source) === 'string' &&
            initialNativeTitleSources.get(source) !== submittedTitle
          ) {
            confirmedSources.set(source, initialNativeTitleSources.get(source) ?? null);
          }
        }
        folderManager?.applyNativeConversationRename(conversationId, submittedTitle);
        startPostCommitVerification(conversationId, submittedTitle, confirmedSources);
        finish();
      } else if (Date.now() >= confirmationDeadline) {
        finish();
      }
    }

    signal.addEventListener('abort', finish, { once: true });
    form?.addEventListener('submit', onSubmit, true);
    scope.addEventListener('click', onClick, true);
    scope.addEventListener('keydown', onKeyDown, true);
    check();
  });
}

async function openNativeRenameDialog(
  generation: number,
  operationButton: HTMLButtonElement,
): Promise<boolean> {
  const conversationId = getCurrentConversationId();
  const manager = folderManager;
  const operationHeader = operationButton.closest<HTMLElement>('header#page-header');
  const trigger = operationHeader?.querySelector<HTMLElement>(
    '[data-testid="conversation-options-button"]',
  );
  if (!conversationId || !manager || !trigger || !isActiveGeneration(generation)) return false;

  cancelActiveRenameOperation();
  const controller = new AbortController();
  activeRenameController = controller;
  const snapshot = createNativeMenuOwnershipSnapshot(
    trigger,
    conversationId,
    `header-rename-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  if (!snapshot) {
    cancelActiveRenameOperation();
    return false;
  }

  const previousTitles = new Set(readNativeConversationTitles(conversationId));
  let renameActivated = false;
  let editorSnapshot: RenameEditorSnapshot | null = null;
  try {
    manager.runWithNativeConversationMenuTrackingSuppressed(trigger, () =>
      activateNativeMenuTrigger(trigger),
    );
    const menu = await waitForOwnedNativeMenu(snapshot, controller.signal);
    if (
      !menu ||
      controller.signal.aborted ||
      !isActiveGeneration(generation) ||
      getCurrentConversationId() !== conversationId ||
      !operationHeader?.contains(trigger) ||
      findActivePageHeader() !== operationHeader
    ) {
      return false;
    }

    const renameItem = findRenameConversationMenuItem(menu);
    if (
      !renameItem ||
      renameItem.getAttribute('aria-disabled') === 'true' ||
      (renameItem instanceof HTMLButtonElement && renameItem.disabled)
    ) {
      closeNativeConversationMenu(menu);
      return false;
    }

    editorSnapshot = captureRenameEditorSnapshot();
    renameItem.click();
    renameActivated = true;
  } finally {
    clearNativeMenuOwnership(snapshot);
    if (!renameActivated && activeRenameController === controller) {
      cancelActiveRenameOperation();
    }
  }

  if (!editorSnapshot || getCurrentConversationId() !== conversationId) {
    cancelActiveRenameOperation();
    return false;
  }
  const editor = await waitForNativeRenameEditor(editorSnapshot, previousTitles, controller.signal);
  if (
    !editor ||
    controller.signal.aborted ||
    !isActiveGeneration(generation) ||
    getCurrentConversationId() !== conversationId
  ) {
    if (activeRenameController === controller) cancelActiveRenameOperation();
    return false;
  }

  await monitorNativeRenameLifecycle(conversationId, editor, controller);
  return true;
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

function injectIfNeeded(generation: number): void {
  if (!isActiveGeneration(generation)) return;
  if (!isConversationPage()) {
    removeTrackedButtons();
    return;
  }

  if (injectedFolderButton && !injectedFolderButton.isConnected) injectedFolderButton = null;
  if (injectedRenameButton && !injectedRenameButton.isConnected) injectedRenameButton = null;

  const slot = findHeaderLeftSlot();
  if (!slot) return;
  const { parent: host, before, styleSource } = slot;
  if (
    (injectedFolderButton && injectedFolderButton.parentElement !== host) ||
    (injectedRenameButton && injectedRenameButton.parentElement !== host)
  ) {
    removeTrackedButtons(false);
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
    host.insertBefore(injectedFolderButton, before);
  }

  injectedRenameButton =
    host.querySelector<HTMLButtonElement>(`[${RENAME_TAG}]`) || injectedRenameButton;
  if (!injectedRenameButton) {
    const label = getTranslationSync('conversation_rename_current');
    injectedRenameButton = createHeaderButton(
      styleSource,
      'gv-conversation-rename-header-btn',
      RENAME_TAG,
      label,
      createRenameIcon(),
    );
    injectedRenameButton.disabled = activeRenameController !== null;
    injectedRenameButton.addEventListener('click', (event) => {
      if (!isActiveGeneration(generation)) return;
      event.preventDefault();
      event.stopPropagation();
      const operationButton = event.currentTarget as HTMLButtonElement;
      operationButton.disabled = true;
      void openNativeRenameDialog(generation, operationButton)
        .then((opened) => {
          if (!opened && operationButton.isConnected && isActiveGeneration(generation)) {
            const unavailable = getTranslationSync('conversation_rename_unavailable');
            operationButton.title = unavailable;
            operationButton.setAttribute('aria-label', unavailable);
            window.setTimeout(() => {
              if (!operationButton.isConnected || !isActiveGeneration(generation)) return;
              operationButton.title = label;
              operationButton.setAttribute('aria-label', label);
            }, 2000);
          }
        })
        .finally(() => {
          if (operationButton.isConnected && isActiveGeneration(generation)) {
            operationButton.disabled = false;
          }
        });
    });
    host.insertBefore(injectedRenameButton, before);
  }
}

function nodeTouchesHeader(node: Node, header: HTMLElement | null): boolean {
  if (!(node instanceof Element)) return false;
  if (header && (node === header || header.contains(node) || node.contains(header))) return true;
  return node.querySelector('header#page-header') !== null;
}

function mutationsMayAffectHeader(records: MutationRecord[]): boolean {
  const header = findActivePageHeader();
  if (
    !header ||
    (injectedFolderButton && !injectedFolderButton.isConnected) ||
    (injectedRenameButton && !injectedRenameButton.isConnected) ||
    (injectedFolderButton && injectedFolderButton.closest('header#page-header') !== header) ||
    (injectedRenameButton && injectedRenameButton.closest('header#page-header') !== header)
  ) {
    return true;
  }

  return records.some((record) => {
    if (record.target instanceof Element && record.target.matches('header#page-header'))
      return true;
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
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['aria-hidden', 'class', 'hidden', 'inert', 'style'],
    childList: true,
    subtree: true,
  });

  locationChangeHandler = () => {
    cancelActiveRenameOperation();
    scheduleInjection(generation);
  };
  window.addEventListener('popstate', locationChangeHandler);
  window.addEventListener('hashchange', locationChangeHandler);
  window.addEventListener('gv-location-change', locationChangeHandler);
  return stopFolderHeaderButton;
}

export function stopFolderHeaderButton(): void {
  activeGeneration = null;
  lifecycleGeneration++;
  folderManager = null;
  cancelActiveRenameOperation();
  if (injectTimer !== null) {
    window.clearTimeout(injectTimer);
    injectTimer = null;
  }
  observer?.disconnect();
  observer = null;
  if (locationChangeHandler) {
    window.removeEventListener('popstate', locationChangeHandler);
    window.removeEventListener('hashchange', locationChangeHandler);
    window.removeEventListener('gv-location-change', locationChangeHandler);
    locationChangeHandler = null;
  }
  removeTrackedButtons();
  document
    .querySelectorAll<HTMLElement>(`[${FOLDER_TAG}], [${RENAME_TAG}]`)
    .forEach((button) => button.remove());
}
