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
  findChatGptSidebar,
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
  findConversationOptionsButton,
  findRenameConversationMenuItem,
  getNativeConversationMenus,
  isElementOpen,
  isOwnedNativeConversationMenu,
  resolveSidebarConversationContext,
} from '../folder/nativeConversationBridge';
import { buildClonedButtonClassName } from '../shared/clonedButtonClass';
import { findActivePageHeader, findHeaderLeftSlot } from '../shared/headerActionSlot';

const FOLDER_TAG = 'data-gv-folder-header-btn';
const RENAME_TAG = 'data-gv-conversation-rename-header-btn';
const TITLE_TAG = 'data-gv-conversation-title-header';
const INJECT_DEBOUNCE_MS = 50;
const NATIVE_MENU_WAIT_MS = 2500;
const SIDEBAR_REVEAL_STABLE_MS = 550;
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
let injectedTitle: HTMLSpanElement | null = null;
let folderManager: FolderManager | null = null;
let observer: MutationObserver | null = null;
let titleObserver: MutationObserver | null = null;
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
  injectedTitle?.remove();
  injectedFolderButton = null;
  injectedRenameButton = null;
  injectedTitle = null;
  if (cancelRename) cancelActiveRenameOperation();
}

function normalizeTitle(value: string | null | undefined): string | null {
  const title = (value || '').replace(/\s+/g, ' ').trim();
  return title || null;
}

function findSidebarRenameTrigger(conversationId: string): HTMLElement | null {
  const sidebar = findChatGptSidebar();
  if (!sidebar || !isSidebarExpandedAndInteractive(sidebar)) return null;
  const matchingTriggers = getChatGptConversationElements(sidebar)
    .filter((conversation) => getChatGptConversationId(conversation) === conversationId)
    .map((conversation) => findConversationOptionsButton(conversation))
    .filter((trigger): trigger is HTMLElement => trigger !== null);

  return matchingTriggers[0] ?? null;
}

function isActuallyVisible(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (
      current.hidden ||
      current.hasAttribute('inert') ||
      current.getAttribute('aria-hidden') === 'true'
    ) {
      return false;
    }
    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
  }
  return true;
}

function isSidebarExpandedAndInteractive(sidebar: HTMLElement): boolean {
  if (!isActuallyVisible(sidebar) || sidebar.getAttribute('data-state') === 'closed') return false;

  const controlsId = sidebar.id;
  if (controlsId) {
    const visibleControls = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-controls][aria-expanded]'),
    ).filter(
      (candidate) =>
        candidate.getAttribute('aria-controls') === controlsId && isActuallyVisible(candidate),
    );
    if (
      visibleControls.some((candidate) => candidate.getAttribute('aria-expanded') === 'false') &&
      !visibleControls.some((candidate) => candidate.getAttribute('aria-expanded') === 'true')
    ) {
      return false;
    }
  }

  // Ignore zero-sized rectangles in DOM-only test environments. In a real
  // browser, a transformed force-mounted sidebar outside the viewport is not
  // an interactive source even if its descendants remain in the DOM.
  const rect = sidebar.getBoundingClientRect();
  if (
    (rect.width > 0 || rect.height > 0) &&
    (rect.right <= 0 ||
      rect.bottom <= 0 ||
      rect.left >= window.innerWidth ||
      rect.top >= window.innerHeight)
  ) {
    return false;
  }
  return true;
}

function findSidebarToggle(expanded: boolean, controlsId?: string): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[aria-controls][aria-expanded]')).find(
      (candidate) => {
        const candidateControls = candidate.getAttribute('aria-controls') || '';
        return (
          candidate.getAttribute('aria-expanded') === String(expanded) &&
          (controlsId
            ? candidateControls === controlsId
            : /(?:^|[-_])sidebar(?:$|[-_])/i.test(candidateControls)) &&
          isActuallyVisible(candidate)
        );
      },
    ) ?? null
  );
}

function waitForSidebarRenameTrigger(
  conversationId: string,
  signal: AbortSignal,
): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    let settled = false;
    let stableTrigger: HTMLElement | null = null;
    let stableSince = 0;
    const mutationObserver = new MutationObserver(check);
    const poll = window.setInterval(check, 50);
    const timer = window.setTimeout(() => finish(null), NATIVE_MENU_WAIT_MS);

    function finish(trigger: HTMLElement | null): void {
      if (settled) return;
      settled = true;
      mutationObserver.disconnect();
      window.clearInterval(poll);
      window.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(trigger);
    }
    function onAbort(): void {
      finish(null);
    }
    function check(): void {
      const trigger = findSidebarRenameTrigger(conversationId);
      if (!trigger) {
        stableTrigger = null;
        stableSince = 0;
        return;
      }
      if (stableTrigger !== trigger) {
        stableTrigger = trigger;
        stableSince = Date.now();
        return;
      }
      if (Date.now() - stableSince >= SIDEBAR_REVEAL_STABLE_MS) finish(trigger);
    }

    if (signal.aborted) {
      finish(null);
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    mutationObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['aria-hidden', 'aria-expanded', 'data-state', 'hidden', 'inert', 'style'],
      childList: true,
      subtree: true,
    });
    check();
  });
}

interface SidebarRevealLease {
  trigger: HTMLElement | null;
  keepOpen: () => boolean;
  preserveOpen: () => void;
  release: () => void;
}

async function revealSidebarForRename(
  conversationId: string,
  signal: AbortSignal,
): Promise<SidebarRevealLease> {
  const existingTrigger = findSidebarRenameTrigger(conversationId);
  if (existingTrigger) {
    return {
      trigger: existingTrigger,
      keepOpen: () => false,
      preserveOpen: () => undefined,
      release: () => undefined,
    };
  }

  const revealToggle = findSidebarToggle(false);
  if (!revealToggle) {
    return {
      trigger: null,
      keepOpen: () => false,
      preserveOpen: () => undefined,
      release: () => undefined,
    };
  }

  const controlsId = revealToggle.getAttribute('aria-controls') || '';
  let released = false;
  let restoreOnRelease = true;
  let userChangedSidebarState = false;
  const recordUserToggle = (event: Event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const control = event.target.closest<HTMLElement>('[aria-controls][aria-expanded]');
    if (control?.getAttribute('aria-controls') === controlsId) userChangedSidebarState = true;
  };
  document.addEventListener('click', recordUserToggle, true);
  revealToggle.click();

  const keepOpen = () => {
    if (released || userChangedSidebarState) return false;
    const collapsedToggle = findSidebarToggle(false, controlsId);
    if (!collapsedToggle) return false;
    collapsedToggle.click();
    return true;
  };
  const preserveOpen = () => {
    restoreOnRelease = false;
  };
  const release = () => {
    if (released) return;
    released = true;
    document.removeEventListener('click', recordUserToggle, true);
    if (userChangedSidebarState || !restoreOnRelease) return;
    findSidebarToggle(true, controlsId)?.click();
  };
  const trigger = await waitForSidebarRenameTrigger(conversationId, signal);
  return { trigger, keepOpen, preserveOpen, release };
}

function isCurrentConversationSidebarTrigger(
  trigger: HTMLElement,
  conversationId: string,
): boolean {
  return resolveSidebarConversationContext(trigger)?.id === conversationId;
}

type NativeTitleSource = 'sidebar-title' | 'header-title' | 'document-title';
type NativeTitleSnapshot = ReadonlyMap<NativeTitleSource, string | null>;

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

    if (signal.aborted) {
      finish(null);
      return;
    }
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
  // ChatGPT's sidebar Radix trigger opens reliably from its native click.
  // Sending pointerdown followed by click can toggle that same menu twice and
  // leave it closed. The header wrapper still needs the pointerdown bridge.
  if (resolveSidebarConversationContext(trigger)) {
    trigger.click();
    return;
  }
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

    if (signal.aborted) {
      finish(null);
      return;
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
    refreshInjectedTitle();
    finish();
  }, 250);
  postCommitVerificationCleanup = finish;
}

type NativeRenameLifecycleOutcome =
  | 'aborted'
  | 'cancelled'
  | 'committed'
  | 'editor-closed'
  | 'hidden-abnormal'
  | 'idle-timeout'
  | 'submitted-timeout';

function monitorNativeRenameLifecycle(
  conversationId: string,
  editor: HTMLElement,
  controller: AbortController,
  keepEditorVisible: () => boolean = () => false,
): Promise<NativeRenameLifecycleOutcome> {
  return new Promise((resolve) => {
    const { signal } = controller;
    const scope =
      editor.closest<HTMLElement>('[role="dialog"]') ||
      editor.closest<HTMLElement>('form') ||
      editor.parentElement ||
      editor;
    const form = editor.closest<HTMLFormElement>('form');
    const initialEditorTitle = readRenameEditorTitle(editor);
    const initialNativeTitleSources: NativeTitleSnapshot =
      readNativeConversationTitleSources(conversationId);
    let settled = false;
    let submittedTitle: string | null = null;
    let submissionAttempted = false;
    let confirmationDeadline = 0;
    let matchingTitleSince = 0;
    const interval = window.setInterval(check, 250);
    const timeout = window.setTimeout(
      () => finish(submissionAttempted ? 'submitted-timeout' : 'idle-timeout'),
      NATIVE_RENAME_LIFECYCLE_MS,
    );

    function finish(outcome: NativeRenameLifecycleOutcome): void {
      if (settled) return;
      settled = true;
      window.clearInterval(interval);
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      form?.removeEventListener('submit', onSubmit, true);
      scope.removeEventListener('click', onClick, true);
      scope.removeEventListener('keydown', onKeyDown, true);
      if (activeRenameController === controller) {
        activeRenameController = null;
        if (injectedRenameButton?.isConnected) injectedRenameButton.disabled = false;
      }
      resolve(outcome);
    }

    function onAbort(): void {
      finish('aborted');
    }

    function beginConfirmation(): void {
      if (settled || getCurrentConversationId() !== conversationId) {
        finish('aborted');
        return;
      }
      submissionAttempted = true;
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
        queueMicrotask(() => finish('cancelled'));
      } else if (isCommitRenameControl(button)) {
        queueMicrotask(beginConfirmation);
      }
    }

    function onKeyDown(event: Event): void {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key === 'Escape') {
        queueMicrotask(() => finish('cancelled'));
      } else if (event.key === 'Enter' && !event.shiftKey) {
        queueMicrotask(beginConfirmation);
      }
    }

    function check(): void {
      if (settled) return;
      if (signal.aborted || getCurrentConversationId() !== conversationId) {
        finish('aborted');
        return;
      }
      if (!submittedTitle) {
        if (!editor.isConnected) {
          finish('editor-closed');
        } else if (!isElementOpen(editor) || !isElementOpen(scope)) {
          // ChatGPT can auto-collapse a temporarily revealed sidebar in the
          // same turn that it mounts the inline title editor. Keep the editor
          // reachable unless the user explicitly changed sidebar state.
          if (!keepEditorVisible()) finish('hidden-abnormal');
        }
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
        refreshInjectedTitle();
        startPostCommitVerification(conversationId, submittedTitle, confirmedSources);
        finish('committed');
      } else if (Date.now() >= confirmationDeadline) {
        finish('submitted-timeout');
      }
    }

    signal.addEventListener('abort', onAbort, { once: true });
    form?.addEventListener('submit', onSubmit, true);
    scope.addEventListener('click', onClick, true);
    scope.addEventListener('keydown', onKeyDown, true);
    check();
  });
}

function isCurrentRenameOperation(
  generation: number,
  conversationId: string,
  operationButton: HTMLButtonElement,
  operationHeader: HTMLElement,
  controller: AbortController,
): boolean {
  return (
    activeRenameController === controller &&
    !controller.signal.aborted &&
    isActiveGeneration(generation) &&
    getCurrentConversationId() === conversationId &&
    operationButton.isConnected &&
    operationHeader.contains(operationButton) &&
    findActivePageHeader() === operationHeader
  );
}

async function openNativeRenameDialog(
  generation: number,
  operationButton: HTMLButtonElement,
): Promise<boolean> {
  const conversationId = getCurrentConversationId();
  const manager = folderManager;
  const operationHeader = operationButton.closest<HTMLElement>('header#page-header');
  if (!conversationId || !manager || !operationHeader || !isActiveGeneration(generation)) {
    return false;
  }

  cancelActiveRenameOperation();
  operationButton.disabled = true;
  const controller = new AbortController();
  activeRenameController = controller;
  let sidebarLease: SidebarRevealLease = {
    trigger: null,
    keepOpen: () => false,
    preserveOpen: () => undefined,
    release: () => undefined,
  };

  try {
    sidebarLease = await revealSidebarForRename(conversationId, controller.signal);
    if (
      !isCurrentRenameOperation(
        generation,
        conversationId,
        operationButton,
        operationHeader,
        controller,
      )
    ) {
      return false;
    }

    const headerTrigger = operationHeader.querySelector<HTMLElement>(
      '[data-testid="conversation-options-button"]',
    );
    const triggers = [sidebarLease.trigger, headerTrigger].filter(
      (trigger, index, candidates): trigger is HTMLElement =>
        trigger !== null && trigger !== undefined && candidates.indexOf(trigger) === index,
    );
    if (triggers.length === 0) return false;

    const previousTitles = new Set(readNativeConversationTitles(conversationId));
    let editorSnapshot: RenameEditorSnapshot | null = null;
    for (const trigger of triggers) {
      if (
        !isCurrentRenameOperation(
          generation,
          conversationId,
          operationButton,
          operationHeader,
          controller,
        )
      ) {
        return false;
      }
      const triggerStillOwnsConversation =
        trigger === headerTrigger
          ? operationHeader.contains(trigger)
          : findSidebarRenameTrigger(conversationId) === trigger &&
            isCurrentConversationSidebarTrigger(trigger, conversationId);
      if (!triggerStillOwnsConversation) continue;

      const snapshot = createNativeMenuOwnershipSnapshot(
        trigger,
        conversationId,
        `header-rename-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      if (!snapshot) continue;

      let menu: HTMLElement | null = null;
      try {
        manager.runWithNativeConversationMenuTrackingSuppressed(trigger, () =>
          activateNativeMenuTrigger(trigger),
        );
        menu = await waitForOwnedNativeMenu(snapshot, controller.signal);
        if (
          !isCurrentRenameOperation(
            generation,
            conversationId,
            operationButton,
            operationHeader,
            controller,
          )
        ) {
          return false;
        }
        if (!menu) continue;
        const stillOwned =
          trigger === headerTrigger
            ? operationHeader.contains(trigger)
            : findSidebarRenameTrigger(conversationId) === trigger &&
              isCurrentConversationSidebarTrigger(trigger, conversationId);
        if (!stillOwned) {
          closeNativeConversationMenu(menu);
          continue;
        }

        const renameItem = findRenameConversationMenuItem(menu);
        if (
          !renameItem ||
          renameItem.getAttribute('aria-disabled') === 'true' ||
          (renameItem instanceof HTMLButtonElement && renameItem.disabled)
        ) {
          closeNativeConversationMenu(menu);
          continue;
        }

        editorSnapshot = captureRenameEditorSnapshot();
        renameItem.click();
        break;
      } finally {
        clearNativeMenuOwnership(snapshot);
      }
    }

    if (!editorSnapshot) return false;
    if (
      !isCurrentRenameOperation(
        generation,
        conversationId,
        operationButton,
        operationHeader,
        controller,
      )
    ) {
      return false;
    }
    const editor = await waitForNativeRenameEditor(
      editorSnapshot,
      previousTitles,
      controller.signal,
    );
    if (
      !editor ||
      !isCurrentRenameOperation(
        generation,
        conversationId,
        operationButton,
        operationHeader,
        controller,
      )
    ) {
      return false;
    }

    const lifecycleOutcome = await monitorNativeRenameLifecycle(
      conversationId,
      editor,
      controller,
      sidebarLease.keepOpen,
    );
    // Preserve the temporarily revealed sidebar only for an idle editor that
    // ChatGPT unexpectedly hid or left open until our safety timeout. Normal
    // cancel, submit and navigation/abort paths must restore its prior state,
    // even when Radix keeps the editor mounted.
    const operationStillCurrent =
      !controller.signal.aborted &&
      isActiveGeneration(generation) &&
      getCurrentConversationId() === conversationId &&
      operationButton.isConnected &&
      operationHeader.contains(operationButton) &&
      findActivePageHeader() === operationHeader;
    if (
      operationStillCurrent &&
      editor.isConnected &&
      (lifecycleOutcome === 'hidden-abnormal' || lifecycleOutcome === 'idle-timeout')
    ) {
      sidebarLease.keepOpen();
      sidebarLease.preserveOpen();
    }
    return true;
  } finally {
    sidebarLease.release();
    if (activeRenameController === controller) {
      cancelActiveRenameOperation();
    }
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
  if (injectedRenameButton && !injectedRenameButton.isConnected) injectedRenameButton = null;
  if (injectedTitle && !injectedTitle.isConnected) injectedTitle = null;

  const slot = findHeaderLeftSlot();
  if (!slot) return;
  const { parent: host, before, styleSource } = slot;
  if (
    (injectedFolderButton && injectedFolderButton.parentElement !== host) ||
    (injectedRenameButton && injectedRenameButton.parentElement !== host) ||
    (injectedTitle && injectedTitle.parentElement !== host)
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
    host.insertBefore(injectedFolderButton, injectedRenameButton ?? injectedTitle ?? before);
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
          if (
            operationButton.isConnected &&
            isActiveGeneration(generation) &&
            activeRenameController === null
          ) {
            operationButton.disabled = false;
          }
        });
    });
    host.insertBefore(injectedRenameButton, injectedTitle ?? before);
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
    (injectedRenameButton && !injectedRenameButton.isConnected) ||
    (injectedTitle && !injectedTitle.isConnected);
  const knownHeader =
    injectedFolderButton?.closest<HTMLElement>('header#page-header') ||
    injectedRenameButton?.closest<HTMLElement>('header#page-header') ||
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
    (injectedRenameButton && injectedRenameButton.closest('header#page-header') !== header) ||
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
    .querySelectorAll<HTMLElement>(`[${FOLDER_TAG}], [${RENAME_TAG}], [${TITLE_TAG}]`)
    .forEach((button) => button.remove());
}
