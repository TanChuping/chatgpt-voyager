import { StorageKeys } from '@/core/types/common';

import {
  PLAIN_TEXT_BEFORE_SEND_EVENT,
  PLAIN_TEXT_NATIVE_SEND_ATTRIBUTE,
  type PlainTextBeforeSendDetail,
} from '../shared/plainTextInputBridge';

const STYLE_ID = 'gv-plain-text-input-style';
const TEXTAREA_ATTRIBUTE = 'data-gv-plain-text-input';
const HOST_CLASS = 'gv-plain-text-input-host';
const NATIVE_CLASS = 'gv-plain-text-input-native';
const SYNC_DELAY_MS = 0;
const SYNC_VERIFY_INTERVAL_MS = 20;
const SYNC_VERIFY_ATTEMPTS = 6;
const SEND_BUTTON_WAIT_MS = 500;
const SEND_COMPLETION_WAIT_MS = 1200;
const TRANSITION_TTL_MS = 1000;
const ROUTE_POLL_MS = 100;
const RECOVERY_STORAGE_KEY = 'gvPlainTextInputRecoveryV1';
const RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECOVERY_DRAFTS = 20;

const COMPOSER_SELECTORS = [
  '#prompt-textarea[contenteditable="true"]',
  '#prompt-textarea[contenteditable="plaintext-only"]',
  'form[data-type="unified-composer"] [contenteditable][role="textbox"]',
  '[data-testid="composer"] [contenteditable][role="textbox"]',
] as const;

const SEND_BUTTON_SELECTORS = [
  'button[data-testid="send-button"]',
  'button.update-button',
  'button[aria-label*="Send"]',
  'button[aria-label*="send"]',
  'button[aria-label*="发送"]',
  'button[aria-label*="Update"]',
  'button[aria-label*="Save"]',
  'button[aria-label*="更新"]',
  '[data-send-button]',
  '.send-button',
] as const;

const ATTACHMENT_PREVIEW_SELECTOR =
  '[data-testid*="attachment" i], [data-testid*="file" i], [aria-label*="attachment" i]';

interface PendingTransition {
  createdAt: number;
  owned: boolean;
  routeKey: string;
  slotKey: string;
  text: string;
}

interface RecoveryDraft {
  createdAt: number;
  routeKey: string;
  slotKey: string;
  text: string;
}

interface InitialComposerText {
  nativeBaseline: string | null;
  owned: boolean;
  recoveryId: string | null;
  text: string;
}

interface PlainComposer {
  editor: HTMLElement;
  host: HTMLElement;
  textarea: HTMLTextAreaElement;
  routeKey: string;
  slotKey: string;
  lastNativeText: string;
  nativeRouteBaseline: string | null;
  recoveryId: string | null;
  originalAriaHidden: string | null;
  originalTabIndex: string | null;
  syncTimer: number | null;
  hydrationTimer: number | null;
  hydrationObserver: MutationObserver | null;
  operationController: AbortController | null;
  syncingNative: boolean;
  sending: boolean;
  disposed: boolean;
  composing: boolean;
  hasUserEdited: boolean;
  onInput: () => void;
  onBlur: () => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onPaste: (event: ClipboardEvent) => void;
  onDrop: (event: DragEvent) => void;
  onNativeInput: () => void;
}

let started = false;
let stopping = false;
let observer: MutationObserver | null = null;
let routeTimer: number | null = null;
let lifecycleController: AbortController | null = null;
let storageListener:
  | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
  | null = null;
let ctrlEnterSendEnabled = false;
let ctrlEnterSettingRevision = 0;
let bypassSendInterception = 0;
let activeRouteKey = '';
let routeTransition: { createdAt: number; routeKey: string; staleNativeTexts: Set<string> } | null =
  null;
const pendingTransitions = new Map<string, PendingTransition>();
const sessionDrafts = new Map<string, string>();
const recoveryDrafts = new Map<string, RecoveryDraft>();
let recoveryWrite: Promise<void> = Promise.resolve();
const composers = new Set<PlainComposer>();

function installStyle(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .${HOST_CLASS} {
      position: relative !important;
    }

    .${NATIVE_CLASS} {
      position: absolute !important;
      inset: 0 !important;
      width: 1px !important;
      height: 1px !important;
      min-height: 0 !important;
      opacity: 0 !important;
      overflow: hidden !important;
      pointer-events: none !important;
    }

    textarea[${TEXTAREA_ATTRIBUTE}] {
      display: block;
      box-sizing: border-box;
      width: 100%;
      min-height: 1.5em;
      max-height: 13rem;
      margin: 0;
      padding: 0;
      resize: none;
      overflow-x: hidden;
      overflow-y: auto;
      border: 0;
      outline: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      line-height: inherit;
      letter-spacing: inherit;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      caret-color: currentColor;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function readEditorText(editor: HTMLElement): string {
  if (editor instanceof HTMLTextAreaElement) return editor.value;
  return editor.innerText ?? editor.textContent ?? '';
}

function resizeTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.max(24, Math.min(textarea.scrollHeight || 24, 208))}px`;
}

function composerBoundary(editor: HTMLElement): HTMLElement {
  return (
    editor.closest<HTMLElement>('[data-testid="composer"]') ||
    editor.closest<HTMLElement>('form[data-type="unified-composer"]') ||
    editor.parentElement ||
    editor
  );
}

function currentRouteKey(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function composerSlotKey(editor: HTMLElement): string {
  const boundary = composerBoundary(editor);
  const form = editor.closest<HTMLElement>('form');
  const isEdit = !!boundary.querySelector(
    'button.update-button, button[aria-label*="Update"], button[aria-label*="Save"], button[aria-label*="更新"]',
  );
  const surface = editor.closest('[role="dialog"]') ? 'dialog' : 'page';
  const identity =
    boundary.getAttribute('data-testid') ||
    form?.getAttribute('data-type') ||
    editor.getAttribute('data-testid') ||
    editor.id ||
    'composer';
  return `${surface}:${isEdit ? 'edit' : 'send'}:${identity}`;
}

function draftId(routeKey: string, slotKey: string): string {
  return `${routeKey}\n${slotKey}`;
}

function validRecoveryDraft(value: unknown): value is RecoveryDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<RecoveryDraft>;
  return (
    typeof draft.createdAt === 'number' &&
    Date.now() - draft.createdAt <= RECOVERY_TTL_MS &&
    typeof draft.routeKey === 'string' &&
    typeof draft.slotKey === 'string' &&
    typeof draft.text === 'string'
  );
}

async function loadRecoveryDrafts(): Promise<void> {
  recoveryDrafts.clear();
  try {
    await recoveryWrite.catch(() => undefined);
    const result = await chrome.storage.local.get(RECOVERY_STORAGE_KEY);
    const stored = result?.[RECOVERY_STORAGE_KEY];
    if (!stored || typeof stored !== 'object') return;
    for (const [id, value] of Object.entries(stored as Record<string, unknown>)) {
      if (validRecoveryDraft(value)) recoveryDrafts.set(id, value);
    }
  } catch (error) {
    console.warn('[GPT-Voyager] Could not load plain-text draft recovery:', error);
  }
}

function recoverySnapshot(): Record<string, RecoveryDraft> {
  const entries = Array.from(recoveryDrafts.entries())
    .filter(([, draft]) => Date.now() - draft.createdAt <= RECOVERY_TTL_MS)
    .sort((a, b) => b[1].createdAt - a[1].createdAt)
    .slice(0, MAX_RECOVERY_DRAFTS);
  recoveryDrafts.clear();
  for (const [id, draft] of entries) recoveryDrafts.set(id, draft);
  return Object.fromEntries(entries);
}

function persistRecoverySnapshot(): Promise<void> {
  const snapshot = recoverySnapshot();
  const nextWrite = recoveryWrite
    .catch(() => undefined)
    .then(() => chrome.storage.local.set({ [RECOVERY_STORAGE_KEY]: snapshot }));
  recoveryWrite = nextWrite;
  return nextWrite;
}

async function saveRecoveryDraft(record: PlainComposer): Promise<boolean> {
  const id = draftId(record.routeKey, record.slotKey);
  recoveryDrafts.set(id, {
    createdAt: Date.now(),
    routeKey: record.routeKey,
    slotKey: record.slotKey,
    text: record.textarea.value,
  });
  record.recoveryId = id;
  try {
    await persistRecoverySnapshot();
    return true;
  } catch (error) {
    console.error('[GPT-Voyager] Could not preserve an unsynced plain-text draft:', error);
    return false;
  }
}

function clearRecoveredDraft(record: PlainComposer, synchronizedText: string): void {
  const id = record.recoveryId;
  if (!id) return;
  const recovered = recoveryDrafts.get(id);
  if (!recovered || recovered.text !== synchronizedText) return;
  recoveryDrafts.delete(id);
  void persistRecoverySnapshot()
    .then(() => {
      if (record.recoveryId === id) record.recoveryId = null;
    })
    .catch((error) => {
      recoveryDrafts.set(id, recovered);
      console.warn('[GPT-Voyager] Could not clear restored plain-text draft recovery:', error);
    });
}

function findSendButton(record: PlainComposer): HTMLButtonElement | null {
  const container = composerBoundary(record.editor);
  for (const selector of SEND_BUTTON_SELECTORS) {
    const candidate = container.querySelector(selector);
    const button = candidate?.closest('button');
    if (button instanceof HTMLButtonElement && container.contains(button)) return button;
  }
  return null;
}

function recordForSendButton(button: HTMLButtonElement): PlainComposer | null {
  for (const record of composers) {
    if (findSendButton(record) === button) return record;
  }
  return null;
}

function isClickableButton(button: HTMLButtonElement | null): button is HTMLButtonElement {
  return !!button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
}

function selectEditorContents(editor: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function dispatchPlainTextPaste(editor: HTMLElement, text: string): boolean {
  try {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', text);
    const event = new ClipboardEvent('paste', {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    });
    if (!event.clipboardData || event.clipboardData.getData('text/plain') !== text) return false;
    editor.dispatchEvent(event);
    return true;
  } catch {
    return false;
  }
}

function waitForDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForNativeText(
  record: PlainComposer,
  expectedText: string,
  signal: AbortSignal,
): Promise<boolean> {
  let consecutiveMatches = 0;
  for (let attempt = 0; attempt < SYNC_VERIFY_ATTEMPTS; attempt += 1) {
    if (signal.aborted || record.disposed || !record.editor.isConnected) return false;
    if (readEditorText(record.editor) === expectedText) {
      consecutiveMatches += 1;
      if (consecutiveMatches >= 2) return true;
    } else {
      consecutiveMatches = 0;
    }
    if (!(await waitForDelay(SYNC_VERIFY_INTERVAL_MS, signal))) return false;
  }
  return false;
}

async function synchronizeNativeText(
  record: PlainComposer,
  text: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (
    signal.aborted ||
    record.disposed ||
    !record.editor.isConnected ||
    record.routeKey !== currentRouteKey()
  ) {
    return false;
  }

  const { editor, textarea } = record;
  const restoreFocus = document.activeElement === textarea;
  const selectionStart = textarea.selectionStart;
  const selectionEnd = textarea.selectionEnd;
  const selectionDirection = textarea.selectionDirection;

  if (readEditorText(editor) !== text) {
    record.syncingNative = true;
    try {
      editor.focus({ preventScroll: true });
      if (!selectEditorContents(editor)) return false;

      const pasteDispatched = dispatchPlainTextPaste(editor, text);
      if (text.length > 0 && !pasteDispatched) return false;

      if (text.length === 0 && readEditorText(editor).length > 0) {
        selectEditorContents(editor);
        document.execCommand('delete', false);
      }
    } catch (error) {
      console.warn('[GPT-Voyager] Plain text input sync failed:', error);
      return false;
    } finally {
      record.syncingNative = false;
      if (restoreFocus && textarea.isConnected) {
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
      }
    }
  }

  const synchronized = await waitForNativeText(record, text, signal);
  if (synchronized) {
    record.lastNativeText = text;
    record.nativeRouteBaseline = null;
    clearRecoveredDraft(record, text);
  }
  return synchronized;
}

function cancelScheduledSync(record: PlainComposer): void {
  if (record.syncTimer === null) return;
  window.clearTimeout(record.syncTimer);
  record.syncTimer = null;
}

function scheduleNativeSync(record: PlainComposer): void {
  cancelScheduledSync(record);
  record.syncTimer = window.setTimeout(() => {
    record.syncTimer = null;
    const controller = lifecycleController;
    if (!started || stopping || !controller || controller.signal.aborted || record.disposed) return;
    const expectedText = record.textarea.value;
    void synchronizeNativeText(record, expectedText, controller.signal).then((synced) => {
      if (!synced && !record.disposed && record.textarea.value === expectedText) {
        console.warn('[GPT-Voyager] Plain text input did not reach the native editor.');
      }
    });
  }, SYNC_DELAY_MS);
}

async function waitForSendButton(
  record: PlainComposer,
  expectedText: string,
  signal: AbortSignal,
): Promise<HTMLButtonElement | null> {
  const deadline = performance.now() + SEND_BUTTON_WAIT_MS;
  while (!signal.aborted && performance.now() <= deadline) {
    if (record.disposed || record.textarea.value !== expectedText) return null;
    const button = findSendButton(record);
    if (isClickableButton(button)) return button;
    if (!(await waitForDelay(25, signal))) return null;
  }
  return null;
}

async function waitForSendCompletion(
  record: PlainComposer,
  expectedText: string,
  clickedButton: HTMLButtonElement,
  attachmentCountBefore: number,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = performance.now() + SEND_COMPLETION_WAIT_MS;
  while (!signal.aborted && performance.now() <= deadline) {
    if (record.disposed || !record.editor.isConnected) return true;
    if (expectedText.trim() && readEditorText(record.editor).trim().length === 0) return true;
    if (!expectedText.trim()) {
      const attachmentCountNow = composerBoundary(record.editor).querySelectorAll(
        ATTACHMENT_PREVIEW_SELECTOR,
      ).length;
      if (
        !clickedButton.isConnected ||
        clickedButton.disabled ||
        clickedButton.getAttribute('aria-disabled') === 'true' ||
        findSendButton(record) !== clickedButton ||
        attachmentCountNow < attachmentCountBefore ||
        !!composerBoundary(record.editor).querySelector('button[data-testid="stop-button"]')
      ) {
        return true;
      }
    }
    if (!(await waitForDelay(25, signal))) return false;
  }
  return false;
}

async function performSend(record: PlainComposer): Promise<void> {
  if (!started || stopping || record.disposed) {
    record.sending = false;
    return;
  }

  const controller = new AbortController();
  const lifecycleSignal = lifecycleController?.signal;
  const abortFromLifecycle = () => controller.abort();
  lifecycleSignal?.addEventListener('abort', abortFromLifecycle, { once: true });
  record.operationController?.abort();
  record.operationController = controller;

  try {
    // Mouse sends are intercepted on document capture. Yield once so later
    // capture listeners (notably folderProject) can prepend their instructions.
    await Promise.resolve();
    if (controller.signal.aborted || record.disposed) return;

    cancelScheduledSync(record);
    const expectedText = record.textarea.value;
    const synced = await synchronizeNativeText(record, expectedText, controller.signal);
    if (
      !synced ||
      controller.signal.aborted ||
      record.disposed ||
      record.textarea.value !== expectedText ||
      readEditorText(record.editor) !== expectedText
    ) {
      return;
    }

    const button = await waitForSendButton(record, expectedText, controller.signal);
    if (!button || readEditorText(record.editor) !== expectedText) return;
    const attachmentCountBefore = composerBoundary(record.editor).querySelectorAll(
      ATTACHMENT_PREVIEW_SELECTOR,
    ).length;

    bypassSendInterception += 1;
    button.setAttribute(PLAIN_TEXT_NATIVE_SEND_ATTRIBUTE, 'true');
    try {
      button.click();
    } finally {
      button.removeAttribute(PLAIN_TEXT_NATIVE_SEND_ATTRIBUTE);
      bypassSendInterception -= 1;
    }

    const sent = await waitForSendCompletion(
      record,
      expectedText,
      button,
      attachmentCountBefore,
      controller.signal,
    );
    if (sent && !record.disposed && record.textarea.value === expectedText) {
      record.textarea.value = '';
      record.hasUserEdited = false;
      resizeTextarea(record.textarea);
    }
  } finally {
    lifecycleSignal?.removeEventListener('abort', abortFromLifecycle);
    if (record.operationController === controller) record.operationController = null;
    if (!record.disposed) record.sending = false;
  }
}

function requestSend(record: PlainComposer): void {
  if (!started || stopping || record.disposed || record.sending) return;
  reconcileRoute();
  if (record.routeKey !== currentRouteKey()) return;
  record.sending = true;
  queueMicrotask(() => void performSend(record));
}

function consumeTransitionText(routeKey: string, slotKey: string): PendingTransition | null {
  const id = draftId(routeKey, slotKey);
  const transition = pendingTransitions.get(id) ?? null;
  pendingTransitions.delete(id);
  if (!transition || Date.now() - transition.createdAt > TRANSITION_TTL_MS) return null;
  return transition;
}

function initialComposerText(editor: HTMLElement, slotKey: string): InitialComposerText {
  const routeKey = currentRouteKey();
  const id = draftId(routeKey, slotKey);
  const transition = consumeTransitionText(routeKey, slotKey);
  if (transition) {
    return {
      nativeBaseline: null,
      owned: transition.owned,
      recoveryId: null,
      text: transition.text,
    };
  }

  if (sessionDrafts.has(id)) {
    return {
      nativeBaseline: null,
      owned: true,
      recoveryId: null,
      text: sessionDrafts.get(id) ?? '',
    };
  }

  const recovery = recoveryDrafts.get(id);
  if (recovery) {
    return {
      nativeBaseline: null,
      owned: true,
      recoveryId: id,
      text: recovery.text,
    };
  }

  const nativeText = readEditorText(editor);
  const routeChange = routeTransition;
  const transitionIsCurrent =
    routeChange?.routeKey === routeKey && Date.now() - routeChange.createdAt <= TRANSITION_TTL_MS;
  const nativeCouldBelongToPreviousRoute =
    !!nativeText && transitionIsCurrent && routeChange.staleNativeTexts.has(nativeText);
  return {
    nativeBaseline: nativeCouldBelongToPreviousRoute ? nativeText : null,
    owned: false,
    recoveryId: null,
    text: nativeCouldBelongToPreviousRoute ? '' : nativeText,
  };
}

function createTextarea(editor: HTMLElement, initial: InitialComposerText): HTMLTextAreaElement {
  const textarea = document.createElement('textarea');
  textarea.setAttribute(TEXTAREA_ATTRIBUTE, 'true');
  textarea.setAttribute('aria-label', editor.getAttribute('aria-label') || 'Message ChatGPT');
  textarea.placeholder =
    editor.getAttribute('data-placeholder') ||
    editor.getAttribute('aria-placeholder') ||
    editor.parentElement?.getAttribute('data-placeholder') ||
    '';
  textarea.autocomplete = 'off';
  textarea.autocapitalize = editor.getAttribute('autocapitalize') || 'sentences';
  textarea.spellcheck = editor.spellcheck;
  textarea.value = initial.text;
  return textarea;
}

function refreshPristineComposer(record: PlainComposer): void {
  if (record.disposed || record.hasUserEdited || record.sending || !record.editor.isConnected)
    return;
  const nativeText = readEditorText(record.editor);
  if (record.nativeRouteBaseline !== null) {
    if (nativeText === record.nativeRouteBaseline) return;
    record.nativeRouteBaseline = null;
  }
  record.lastNativeText = nativeText;
  if (record.textarea.value === nativeText) return;
  record.textarea.value = nativeText;
  resizeTextarea(record.textarea);
}

function stopHydrationWatch(record: PlainComposer): void {
  record.hydrationObserver?.disconnect();
  record.hydrationObserver = null;
  if (record.hydrationTimer !== null) {
    window.clearTimeout(record.hydrationTimer);
    record.hydrationTimer = null;
  }
}

function startHydrationWatch(record: PlainComposer): void {
  record.hydrationObserver = new MutationObserver(() => {
    if (record.disposed) return;
    if (record.hasUserEdited) return;
    if (record.hydrationTimer !== null) return;
    record.hydrationTimer = window.setTimeout(() => {
      record.hydrationTimer = null;
      refreshPristineComposer(record);
    }, 0);
  });
  record.hydrationObserver.observe(record.editor, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

function clipboardFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return [];
  const files = Array.from(dataTransfer.files || []);
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

function forwardFilesToNative(record: PlainComposer, source: DataTransfer | null): boolean {
  const files = clipboardFiles(source);
  if (files.length === 0) return false;
  try {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    for (const type of Array.from(source?.types || [])) {
      if (type === 'Files') continue;
      const value = source?.getData(type);
      if (value) transfer.setData(type, value);
    }
    const event = new ClipboardEvent('paste', {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    });
    if (!event.clipboardData || event.clipboardData.files.length !== files.length) return false;
    record.editor.focus({ preventScroll: true });
    record.editor.dispatchEvent(event);
    queueMicrotask(
      () => record.textarea.isConnected && record.textarea.focus({ preventScroll: true }),
    );
    return true;
  } catch {
    return false;
  }
}

function storeSessionDraft(record: PlainComposer): void {
  const id = draftId(record.routeKey, record.slotKey);
  const text = record.hasUserEdited
    ? record.textarea.value
    : readEditorText(record.editor) || record.textarea.value;
  if (record.hasUserEdited || text.length > 0) sessionDrafts.set(id, text);
  else sessionDrafts.delete(id);
}

function transitionComposerRoute(
  record: PlainComposer,
  nextRouteKey: string,
  staleNativeTexts: Set<string>,
): void {
  storeSessionDraft(record);
  record.operationController?.abort();
  record.operationController = null;
  record.sending = false;
  record.composing = false;
  cancelScheduledSync(record);

  const nextId = draftId(nextRouteKey, record.slotKey);
  const nativeText = readEditorText(record.editor);
  const nativeIsStale = nativeText.length > 0 && staleNativeTexts.has(nativeText);
  let text = nativeIsStale ? '' : nativeText;
  let owned = false;
  let recoveryId: string | null = null;

  if (sessionDrafts.has(nextId)) {
    text = sessionDrafts.get(nextId) ?? '';
    sessionDrafts.delete(nextId);
    owned = true;
  } else {
    const recovery = recoveryDrafts.get(nextId);
    if (recovery) {
      text = recovery.text;
      owned = true;
      recoveryId = nextId;
    }
  }

  record.routeKey = nextRouteKey;
  record.lastNativeText = nativeText;
  record.nativeRouteBaseline = nativeIsStale ? nativeText : null;
  record.recoveryId = recoveryId;
  record.hasUserEdited = owned;
  record.textarea.value = text;
  resizeTextarea(record.textarea);
  if (owned) scheduleNativeSync(record);
}

function reconcileRoute(): void {
  const nextRouteKey = currentRouteKey();
  if (!started || stopping || nextRouteKey === activeRouteKey) return;

  const staleNativeTexts = new Set<string>();
  for (const record of composers) {
    staleNativeTexts.add(record.textarea.value);
    staleNativeTexts.add(record.lastNativeText);
    const nativeText = readEditorText(record.editor);
    if (nativeText === record.textarea.value || nativeText === record.lastNativeText) {
      staleNativeTexts.add(nativeText);
    }
  }
  staleNativeTexts.delete('');

  activeRouteKey = nextRouteKey;
  routeTransition = { createdAt: Date.now(), routeKey: nextRouteKey, staleNativeTexts };
  for (const record of composers) {
    transitionComposerRoute(record, nextRouteKey, staleNativeTexts);
  }
}

function attachComposer(editor: HTMLElement): void {
  if (!started || stopping || Array.from(composers).some((record) => record.editor === editor)) {
    return;
  }
  const host = editor.parentElement;
  if (!host) return;

  const slotKey = composerSlotKey(editor);
  const initial = initialComposerText(editor, slotKey);
  const textarea = createTextarea(editor, initial);
  const record: PlainComposer = {
    editor,
    host,
    textarea,
    routeKey: currentRouteKey(),
    slotKey,
    lastNativeText: readEditorText(editor),
    nativeRouteBaseline: initial.nativeBaseline,
    recoveryId: initial.recoveryId,
    originalAriaHidden: editor.getAttribute('aria-hidden'),
    originalTabIndex: editor.getAttribute('tabindex'),
    syncTimer: null,
    hydrationTimer: null,
    hydrationObserver: null,
    operationController: null,
    syncingNative: false,
    sending: false,
    disposed: false,
    composing: false,
    hasUserEdited: false,
    onInput: () => undefined,
    onBlur: () => undefined,
    onCompositionStart: () => undefined,
    onCompositionEnd: () => undefined,
    onKeyDown: () => undefined,
    onPaste: () => undefined,
    onDrop: () => undefined,
    onNativeInput: () => undefined,
  };

  record.onInput = () => {
    reconcileRoute();
    if (record.routeKey !== currentRouteKey()) return;
    record.hasUserEdited = true;
    cancelScheduledSync(record);
    resizeTextarea(textarea);
  };
  record.onCompositionStart = () => {
    record.composing = true;
    record.hasUserEdited = true;
  };
  record.onCompositionEnd = () => {
    record.composing = false;
    resizeTextarea(textarea);
  };
  record.onBlur = () => {
    if (!record.composing) scheduleNativeSync(record);
  };
  record.onKeyDown = (event: KeyboardEvent) => {
    reconcileRoute();
    if (record.routeKey !== currentRouteKey()) return;
    if (event.key !== 'Enter' || event.isComposing || record.composing || event.keyCode === 229) {
      return;
    }

    const modifierPressed = event.ctrlKey || event.metaKey;
    const shouldSend = ctrlEnterSendEnabled
      ? modifierPressed && !event.shiftKey && !event.altKey
      : !modifierPressed && !event.shiftKey && !event.altKey;

    // The plain layer is the sole owner of Enter. This also prevents the
    // separately enabled sendBehavior feature from starting a second send.
    event.stopImmediatePropagation();
    if (!shouldSend) return;
    event.preventDefault();
    requestSend(record);
  };
  record.onPaste = (event: ClipboardEvent) => {
    reconcileRoute();
    if (record.routeKey !== currentRouteKey()) return;
    if (!forwardFilesToNative(record, event.clipboardData)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  record.onDrop = (event: DragEvent) => {
    reconcileRoute();
    if (record.routeKey !== currentRouteKey()) return;
    if (!forwardFilesToNative(record, event.dataTransfer)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  record.onNativeInput = () => {
    if (record.syncingNative) return;
    queueMicrotask(() => {
      if (record.disposed || record.syncingNative) return;
      reconcileRoute();
      if (record.routeKey !== currentRouteKey()) return;
      const nativeText = readEditorText(editor);
      if (record.nativeRouteBaseline !== null) {
        if (nativeText === record.nativeRouteBaseline) return;
        record.nativeRouteBaseline = null;
      }
      record.lastNativeText = nativeText;
      if (record.sending && nativeText.trim().length === 0) {
        textarea.value = '';
        record.hasUserEdited = false;
        resizeTextarea(textarea);
        return;
      }
      if (!record.hasUserEdited || document.activeElement === editor) {
        textarea.value = nativeText;
        resizeTextarea(textarea);
        if (document.activeElement === editor) {
          textarea.focus({ preventScroll: true });
          textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        }
      }
    });
  };

  host.classList.add(HOST_CLASS);
  editor.classList.add(NATIVE_CLASS);
  editor.setAttribute('aria-hidden', 'true');
  editor.setAttribute('tabindex', '-1');
  host.appendChild(textarea);
  resizeTextarea(textarea);

  textarea.addEventListener('input', record.onInput);
  textarea.addEventListener('blur', record.onBlur);
  textarea.addEventListener('compositionstart', record.onCompositionStart);
  textarea.addEventListener('compositionend', record.onCompositionEnd);
  textarea.addEventListener('keydown', record.onKeyDown, { capture: true });
  textarea.addEventListener('paste', record.onPaste, { capture: true });
  textarea.addEventListener('drop', record.onDrop, { capture: true });
  editor.addEventListener('input', record.onNativeInput, { capture: true });
  composers.add(record);
  startHydrationWatch(record);

  record.hasUserEdited = initial.owned;
  if (initial.owned) scheduleNativeSync(record);
}

function detachComposer(record: PlainComposer, preserveText: boolean): void {
  if (record.disposed) return;

  if (preserveText && !record.sending && record.routeKey === currentRouteKey()) {
    const text =
      record.hasUserEdited || record.nativeRouteBaseline !== null
        ? record.textarea.value
        : readEditorText(record.editor) || record.textarea.value;
    pendingTransitions.set(draftId(record.routeKey, record.slotKey), {
      createdAt: Date.now(),
      owned: record.hasUserEdited,
      routeKey: record.routeKey,
      slotKey: record.slotKey,
      text,
    });
  }

  record.disposed = true;
  record.operationController?.abort();
  record.operationController = null;
  cancelScheduledSync(record);
  stopHydrationWatch(record);

  record.textarea.removeEventListener('input', record.onInput);
  record.textarea.removeEventListener('blur', record.onBlur);
  record.textarea.removeEventListener('compositionstart', record.onCompositionStart);
  record.textarea.removeEventListener('compositionend', record.onCompositionEnd);
  record.textarea.removeEventListener('keydown', record.onKeyDown, { capture: true });
  record.textarea.removeEventListener('paste', record.onPaste, { capture: true });
  record.textarea.removeEventListener('drop', record.onDrop, { capture: true });
  record.editor.removeEventListener('input', record.onNativeInput, { capture: true });
  record.textarea.remove();
  record.editor.classList.remove(NATIVE_CLASS);
  if (record.originalAriaHidden === null) record.editor.removeAttribute('aria-hidden');
  else record.editor.setAttribute('aria-hidden', record.originalAriaHidden);
  if (record.originalTabIndex === null) record.editor.removeAttribute('tabindex');
  else record.editor.setAttribute('tabindex', record.originalTabIndex);
  if (!record.host.querySelector(`[${TEXTAREA_ATTRIBUTE}]`)) {
    record.host.classList.remove(HOST_CLASS);
  }
  composers.delete(record);
}

function scanForComposers(root: ParentNode = document): void {
  for (const selector of COMPOSER_SELECTORS) {
    root.querySelectorAll<HTMLElement>(selector).forEach(attachComposer);
  }
}

function pruneDetachedComposers(): void {
  for (const record of Array.from(composers)) {
    if (!record.editor.isConnected) detachComposer(record, true);
  }
}

function installComposerObserver(): void {
  if (observer || !started || stopping) return;
  observer = new MutationObserver((mutations) => {
    if (!started || stopping) return;
    reconcileRoute();
    pruneDetachedComposers();
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        for (const selector of COMPOSER_SELECTORS) {
          if (node.matches(selector)) attachComposer(node);
        }
        scanForComposers(node);
      }
    }
  });
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function startRouteMonitor(): void {
  if (routeTimer !== null || !started || stopping) return;
  routeTimer = window.setInterval(reconcileRoute, ROUTE_POLL_MS);
}

function stopDomMonitoring(): void {
  observer?.disconnect();
  observer = null;
  if (routeTimer !== null) {
    window.clearInterval(routeTimer);
    routeTimer = null;
  }
}

function onClick(event: MouseEvent): void {
  if (bypassSendInterception > 0) return;
  reconcileRoute();
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest('button');
  if (!(button instanceof HTMLButtonElement)) return;
  const record = recordForSendButton(button);
  if (!record) return;

  button.dispatchEvent(
    new CustomEvent<PlainTextBeforeSendDetail>(PLAIN_TEXT_BEFORE_SEND_EVENT, {
      bubbles: true,
      detail: { input: record.textarea },
    }),
  );

  // Stop the original click before it can send stale ProseMirror state. Other
  // document-capture listeners still run and may update the visible textarea.
  event.preventDefault();
  event.stopPropagation();
  requestSend(record);
}

function loadCtrlEnterSetting(): Promise<void> {
  const requestedAtRevision = ctrlEnterSettingRevision;
  return new Promise((resolve) => {
    try {
      chrome.storage?.sync?.get({ [StorageKeys.CTRL_ENTER_SEND]: false }, (result) => {
        if (started && requestedAtRevision === ctrlEnterSettingRevision) {
          ctrlEnterSendEnabled = result?.[StorageKeys.CTRL_ENTER_SEND] === true;
        }
        resolve();
      });
    } catch {
      ctrlEnterSendEnabled = false;
      resolve();
    }
  });
}

function installStorageListener(): void {
  storageListener = (changes, areaName) => {
    if (!started || areaName !== 'sync' || !changes[StorageKeys.CTRL_ENTER_SEND]) return;
    ctrlEnterSettingRevision += 1;
    ctrlEnterSendEnabled = changes[StorageKeys.CTRL_ENTER_SEND].newValue === true;
  };
  try {
    chrome.storage?.onChanged?.addListener(storageListener);
  } catch {
    storageListener = null;
  }
}

async function syncLatestBeforeStop(record: PlainComposer, signal: AbortSignal): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const expectedText = record.textarea.value;
    if (await synchronizeNativeText(record, expectedText, signal)) {
      if (record.textarea.value === expectedText) return true;
    }
  }
  return false;
}

export async function stopPlainTextInput(): Promise<void> {
  if (!started || stopping) return;
  reconcileRoute();
  stopping = true;
  stopDomMonitoring();

  const records = Array.from(composers);
  for (const record of records) {
    cancelScheduledSync(record);
    record.operationController?.abort();
  }

  const stopSyncController = new AbortController();
  const unsafeToDetach = (
    await Promise.all(
      records.map(async (record) => {
        if (
          record.sending &&
          (!record.editor.isConnected || readEditorText(record.editor).trim().length === 0)
        ) {
          record.textarea.value = '';
          return false;
        }
        if (await syncLatestBeforeStop(record, stopSyncController.signal)) return false;
        return !(await saveRecoveryDraft(record));
      }),
    )
  ).some(Boolean);

  if (unsafeToDetach) {
    stopping = false;
    installComposerObserver();
    startRouteMonitor();
    pruneDetachedComposers();
    scanForComposers();
    throw new Error('Plain text input could not safely restore the native composer.');
  }

  started = false;
  lifecycleController?.abort();
  lifecycleController = null;
  document.removeEventListener('click', onClick, true);

  for (const record of Array.from(composers)) detachComposer(record, false);
  pendingTransitions.clear();
  sessionDrafts.clear();
  routeTransition = null;
  activeRouteKey = '';
  ctrlEnterSendEnabled = false;
  ctrlEnterSettingRevision = 0;
  bypassSendInterception = 0;

  if (storageListener) {
    try {
      chrome.storage?.onChanged?.removeListener(storageListener);
    } catch {
      // Ignore extension teardown races.
    }
    storageListener = null;
  }
  document.getElementById(STYLE_ID)?.remove();
  stopping = false;
}

export async function startPlainTextInput(): Promise<() => Promise<void>> {
  if (started) return stopPlainTextInput;
  started = true;
  stopping = false;
  activeRouteKey = currentRouteKey();
  routeTransition = null;
  ctrlEnterSendEnabled = false;
  ctrlEnterSettingRevision = 0;
  lifecycleController = new AbortController();
  installStyle();
  installStorageListener();
  await Promise.all([loadCtrlEnterSetting(), loadRecoveryDrafts()]);
  if (!started || stopping) return stopPlainTextInput;
  scanForComposers();
  installComposerObserver();
  startRouteMonitor();
  document.addEventListener('click', onClick, true);
  return stopPlainTextInput;
}

export const plainTextInputTestApi = {
  beforeSendEvent: PLAIN_TEXT_BEFORE_SEND_EVENT,
  nativeSendAttribute: PLAIN_TEXT_NATIVE_SEND_ATTRIBUTE,
  textareaAttribute: TEXTAREA_ATTRIBUTE,
};
