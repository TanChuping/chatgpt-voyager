/**
 * Partial conversation export — "select & export" mode.
 *
 * Lets the user tick individual on-screen messages and download only the
 * selected subset, reusing the modern single-conversation export pipeline
 * (captured `/backend-api/conversation` payload → existing exporters). The
 * on-screen `data-message-id` UUIDs match `LinearMessage.messageId` 1:1, so
 * selection is just a `Set<string>` of those ids that we hand to
 * `exportConversationSubset`.
 *
 * The selectable universe starts with the captured API payload and is extended
 * by messages mounted while the user scrolls. This keeps virtualised selections
 * stable while allowing a cold or stale capture to catch up without auto-scroll.
 */
import { StorageKeys } from '@/core/types/common';
import { getConversationCaptureService } from '@/features/conversationApi/ConversationCaptureService';
import {
  DEFAULT_SINGLE_CONV_EXPORT_FORMAT,
  type SingleConvExportFormat,
  exportConversationSubset,
  isSingleConvExportFormat,
} from '@/features/singleConvExport';
import {
  collectLiveConversationMessages,
  mergeLiveConversationMessages,
  rebuildConversationFromLive,
} from '@/features/singleConvExport/liveSnapshot';
import { isSimpleVisibleMessage } from '@/features/singleConvExport/simpleFilter';
import { getTranslationSync } from '@/utils/i18n';

import { isChatGptResponseGenerating } from './generationState';

const HOST_CLASS = 'gv-export-pick-host';
const HOST_SELECTED_CLASS = 'gv-export-pick-host--selected';
const CHECKBOX_CLASS = 'gv-export-pick-checkbox';
const BAR_CLASS = 'gv-export-pick-bar';

interface SelectionUniverse {
  all: Set<string>;
  user: Set<string>;
  assistant: Set<string>;
}

let active = false;
let universe: SelectionUniverse = { all: new Set(), user: new Set(), assistant: new Set() };
const selectedIds = new Set<string>();
const idToCheckbox = new Map<string, HTMLButtonElement>();
const idToHost = new Map<string, HTMLElement>();
let bar: HTMLElement | null = null;
let countEl: HTMLElement | null = null;
let exportButton: HTMLButtonElement | null = null;
let observer: MutationObserver | null = null;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;
let selectionPolicy: 'all' | 'user' | 'assistant' | null = null;
let observerSyncTimer: number | null = null;
const observerRoots = new Set<HTMLElement>();

function t(key: Parameters<typeof getTranslationSync>[0]): string {
  return getTranslationSync(key);
}

async function resolveExportFormat(): Promise<SingleConvExportFormat> {
  try {
    const result = await chrome.storage?.sync?.get({
      [StorageKeys.SINGLE_CONV_EXPORT_FORMAT]: DEFAULT_SINGLE_CONV_EXPORT_FORMAT,
    });
    const value = result?.[StorageKeys.SINGLE_CONV_EXPORT_FORMAT];
    if (isSingleConvExportFormat(value)) return value;
    return DEFAULT_SINGLE_CONV_EXPORT_FORMAT;
  } catch {
    return DEFAULT_SINGLE_CONV_EXPORT_FORMAT;
  }
}

/**
 * Build the set of selectable message ids from the captured conversation,
 * narrowed to the user-facing messages (same predicate the simplified
 * exporters use). Returns null when the conversation hasn't been captured yet
 * or has no exportable messages.
 */
function buildUniverse(convId: string): SelectionUniverse | null {
  const capture = getConversationCaptureService();
  const live = collectLiveConversationMessages();
  const cached = capture.getLatest(convId);
  const linear = cached
    ? capture.updateLatest(convId, mergeLiveConversationMessages(cached, live))
    : live.length > 0
      ? capture.updateLatest(
          convId,
          rebuildConversationFromLive(
            null,
            convId,
            document.title.replace(/\s*[-|]\s*ChatGPT\s*$/i, '').trim(),
            live,
          ),
          { force: true },
        )
      : null;
  if (!linear) return null;
  const all = new Set<string>();
  const user = new Set<string>();
  const assistant = new Set<string>();
  for (const m of linear.messages) {
    if (!isSimpleVisibleMessage(m)) continue;
    all.add(m.messageId);
    if (m.role === 'user') user.add(m.messageId);
    else if (m.role === 'assistant') assistant.add(m.messageId);
  }
  if (all.size === 0) return null;
  return { all, user, assistant };
}

function updateCount(): void {
  const countText = `${t('singleConvExportSelectSelected')}: ${selectedIds.size}`;
  if (countEl && countEl.textContent !== countText) countEl.textContent = countText;
  if (!exportButton) return;
  const selectedResponseIsStreaming =
    isChatGptResponseGenerating() &&
    [...selectedIds].some((messageId) => universe.assistant.has(messageId));
  exportButton.disabled = selectedIds.size === 0 || selectedResponseIsStreaming;
  exportButton.title = selectedResponseIsStreaming ? t('singleConvExportGenerating') : '';
}

function setSelected(id: string, next: boolean): void {
  if (next) selectedIds.add(id);
  else selectedIds.delete(id);

  const checkbox = idToCheckbox.get(id);
  if (checkbox) {
    checkbox.setAttribute('aria-pressed', next ? 'true' : 'false');
    checkbox.dataset.selected = next ? 'true' : 'false';
  }
  const host = idToHost.get(id);
  if (host) host.classList.toggle(HOST_SELECTED_CLASS, next);
  updateCount();
}

function clearSelection(): void {
  [...selectedIds].forEach((id) => setSelected(id, false));
}

/** Select exactly the given set, replacing the current selection. */
function selectExactly(target: Set<string>): void {
  clearSelection();
  target.forEach((id) => setSelected(id, true));
}

function applySelectionPolicy(policy: 'all' | 'user' | 'assistant' | null): void {
  selectionPolicy = policy;
  if (policy === null) return;
  if (policy === 'all') selectExactly(universe.all);
  else if (policy === 'user') selectExactly(universe.user);
  else selectExactly(universe.assistant);
}

function extendUniverse(messageId: string, role: 'user' | 'assistant'): void {
  if (universe.all.has(messageId)) return;
  universe.all.add(messageId);
  if (role === 'user') universe.user.add(messageId);
  else universe.assistant.add(messageId);

  if (selectionPolicy === 'all' || selectionPolicy === role) {
    setSelected(messageId, true);
  }
}

function attachCheckbox(host: HTMLElement): void {
  const id = host.getAttribute('data-message-id');
  if (!id || !universe.all.has(id)) return;

  const existing = idToCheckbox.get(id);
  if (existing && existing.isConnected && host.contains(existing)) {
    idToHost.set(id, host);
    return;
  }
  if (existing?.isConnected) existing.remove();
  const previousHost = idToHost.get(id);
  if (previousHost && previousHost !== host) {
    previousHost.classList.remove(HOST_CLASS, HOST_SELECTED_CLASS);
  }
  // No live checkbox for this id (first time, or ChatGPT virtualised/replaced
  // the message node). (Re)create it on the current host, reflecting the
  // selection state we already track in `selectedIds`.
  const selected = selectedIds.has(id);

  host.classList.add(HOST_CLASS);
  host.classList.toggle(HOST_SELECTED_CLASS, selected);

  const checkbox = document.createElement('button');
  checkbox.type = 'button';
  checkbox.className = CHECKBOX_CLASS;
  checkbox.setAttribute('aria-pressed', selected ? 'true' : 'false');
  checkbox.dataset.selected = selected ? 'true' : 'false';
  checkbox.setAttribute('aria-label', t('singleConvExportSelectTitle'));
  checkbox.title = t('singleConvExportSelectTitle');

  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((type) =>
    checkbox.addEventListener(type, swallow, true),
  );
  checkbox.addEventListener('click', (e) => {
    swallow(e);
    selectionPolicy = null;
    setSelected(id, !selectedIds.has(id));
  });

  host.appendChild(checkbox);
  idToCheckbox.set(id, checkbox);
  idToHost.set(id, host);
}

function syncLiveSelectionMessages(convId: string, roots?: Iterable<HTMLElement>): void {
  const live = roots
    ? Array.from(roots).flatMap((root) => collectLiveConversationMessages(root))
    : collectLiveConversationMessages();
  const uniqueLive = Array.from(
    new Map(live.map((item) => [item.message.messageId, item])).values(),
  );
  const capture = getConversationCaptureService();
  const cached = capture.getLatest(convId);
  if (cached && uniqueLive.length > 0) {
    capture.updateLatest(convId, mergeLiveConversationMessages(cached, uniqueLive));
  }

  for (const item of uniqueLive) {
    if (!isSimpleVisibleMessage(item.message)) continue;
    extendUniverse(item.message.messageId, item.message.role as 'user' | 'assistant');
    attachCheckbox(item.host);
  }
}

function makeBarButton(label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'gv-export-pick-bar__btn';
  b.textContent = label;
  return b;
}

function buildBar(convId: string): void {
  bar = document.createElement('div');
  bar.className = BAR_CLASS;

  const title = document.createElement('span');
  title.className = 'gv-export-pick-bar__title';
  title.textContent = t('singleConvExportSelectTitle');

  const allBtn = makeBarButton(t('singleConvExportSelectAll'));
  allBtn.addEventListener('click', () => applySelectionPolicy('all'));

  const noneBtn = makeBarButton(t('singleConvExportSelectNone'));
  noneBtn.addEventListener('click', () => {
    selectionPolicy = null;
    clearSelection();
  });

  const userBtn = makeBarButton(t('singleConvExportSelectUser'));
  userBtn.addEventListener('click', () => applySelectionPolicy('user'));

  const aiBtn = makeBarButton(t('singleConvExportSelectAI'));
  aiBtn.addEventListener('click', () => applySelectionPolicy('assistant'));

  countEl = document.createElement('span');
  countEl.className = 'gv-export-pick-bar__count';

  const exportBtn = makeBarButton(t('singleConvExportSelectDo'));
  exportButton = exportBtn;
  exportBtn.classList.add('gv-export-pick-bar__btn--primary');
  exportBtn.addEventListener('click', () => {
    if (selectedIds.size === 0) {
      alert(t('singleConvExportSelectEmpty'));
      return;
    }
    if (
      isChatGptResponseGenerating() &&
      [...selectedIds].some((messageId) => universe.assistant.has(messageId))
    ) {
      alert(t('singleConvExportGenerating'));
      return;
    }
    void resolveExportFormat().then((fmt) => {
      if (!active) return;
      if (
        isChatGptResponseGenerating() &&
        [...selectedIds].some((messageId) => universe.assistant.has(messageId))
      ) {
        alert(t('singleConvExportGenerating'));
        updateCount();
        return;
      }
      const result = exportConversationSubset(convId, fmt, new Set(selectedIds));
      if (result === 'not-captured') {
        alert(t('singleConvExportSelectNotReady'));
        return;
      }
      if (result === 'empty') {
        alert(t('singleConvExportSelectEmpty'));
        return;
      }
      exitSelectionMode();
    });
  });

  const cancelBtn = makeBarButton(t('singleConvExportSelectCancel'));
  cancelBtn.classList.add('gv-export-pick-bar__btn--ghost');
  cancelBtn.addEventListener('click', () => exitSelectionMode());

  bar.append(title, allBtn, noneBtn, userBtn, aiBtn, countEl, exportBtn, cancelBtn);
  document.body.appendChild(bar);
  updateCount();
}

export function isSelectionModeActive(): boolean {
  return active;
}

export function enterSelectionMode(convId: string): void {
  if (active) return;
  if (isChatGptResponseGenerating()) {
    alert(t('singleConvExportGenerating'));
    return;
  }
  const built = buildUniverse(convId);
  if (!built) {
    alert(t('singleConvExportSelectNotReady'));
    return;
  }
  active = true;
  universe = built;
  selectedIds.clear();
  idToCheckbox.clear();
  idToHost.clear();
  selectionPolicy = null;

  document.body.classList.add('gv-export-pick-active');
  buildBar(convId);
  syncLiveSelectionMessages(convId);

  observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const added of record.addedNodes) {
        if (!(added instanceof HTMLElement)) continue;
        if (
          added.matches('[data-message-id][data-message-author-role]') ||
          added.querySelector('[data-message-id][data-message-author-role]')
        ) {
          observerRoots.add(added);
        }
      }
    }
    if (observerRoots.size === 0 || observerSyncTimer !== null) return;
    observerSyncTimer = window.setTimeout(() => {
      observerSyncTimer = null;
      const roots = Array.from(observerRoots);
      observerRoots.clear();
      if (!active) return;
      syncLiveSelectionMessages(convId, roots);
      updateCount();
    }, 30);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  keydownHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      exitSelectionMode();
    }
  };
  window.addEventListener('keydown', keydownHandler, true);
}

export function exitSelectionMode(): void {
  if (!active) return;
  active = false;

  observer?.disconnect();
  observer = null;
  if (observerSyncTimer !== null) {
    window.clearTimeout(observerSyncTimer);
    observerSyncTimer = null;
  }
  observerRoots.clear();

  if (keydownHandler) {
    window.removeEventListener('keydown', keydownHandler, true);
    keydownHandler = null;
  }

  idToCheckbox.forEach((checkbox) => checkbox.remove());
  idToHost.forEach((host) => host.classList.remove(HOST_CLASS, HOST_SELECTED_CLASS));
  idToCheckbox.clear();
  idToHost.clear();
  selectedIds.clear();
  selectionPolicy = null;

  bar?.remove();
  bar = null;
  countEl = null;
  exportButton = null;
  document.body.classList.remove('gv-export-pick-active');
}
