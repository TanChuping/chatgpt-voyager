// Static imports to avoid CSP issues with dynamic imports in content scripts
import { StorageKeys } from '@/core/types/common';
import { isSafari } from '@/core/utils/browser';
import {
  buildConversationIdFromUrl,
  buildLegacyConversationIdFromUrl,
  buildRouteConversationIdFromUrl,
  extractConversationIdFromUrl as extractNativeConversationIdFromUrl,
} from '@/core/utils/conversationIdentity';
import { addPageExitListener } from '@/core/utils/pageLifecycle';
import { type AppLanguage, normalizeLanguage } from '@/utils/language';
import { extractMessageDictionary } from '@/utils/localeMessages';
import type { TranslationKey } from '@/utils/translations';

import { ConversationExportService } from '../../../features/export/services/ConversationExportService';
import {
  getSavedImageExportWidth,
  saveImageExportWidth,
} from '../../../features/export/services/ImageExportPreferenceService';
import { ImageExportService } from '../../../features/export/services/ImageExportService';
import {
  DEFAULT_IMAGE_EXPORT_WIDTH,
  type ExportFormat,
} from '../../../features/export/types/export';
import type {
  ConversationMetadata,
  ChatTurn as ExportChatTurn,
} from '../../../features/export/types/export';
import { ExportDialog } from '../../../features/export/ui/ExportDialog';
import { resolveExportErrorMessage } from '../../../features/export/ui/ExportErrorMessage';
import { showExportToast } from '../../../features/export/ui/ExportToast';
import {
  CHATGPT_MENU_SELECTOR,
  bindChatGptMenuTrigger,
  findAssistantTurnForElement,
  getChatGptConversationElements,
  getChatGptConversationId,
  getChatGptConversationLink,
  getChatGptConversationTitle,
  normalizeChatGptConversationId,
} from '../chatgptDom';
import {
  TIMELINE_STARS_PREFIX,
  getTimelinePrivateItemSync,
  hydrateTimelinePrivateItem,
} from '../timeline/timelinePrivateStorage';
import { filterOutDeepResearchImmersiveNodes, resolveConversationRoot } from './conversationDom';
import {
  getConversationMenuContext,
  getResponseMenuContext,
  injectConversationMenuExportButton,
  injectResponseMenuExportButton,
} from './conversationMenuInjection';
import { injectResponseActionCopyImageButtons } from './responseActionImageButton';
import { copyImageBlobToClipboard, downloadImageBlob } from './responseImageCopy';
import { groupSelectedMessagesByTurn, resolveInitialSelectedMessageIds } from './selectionUtils';
import { resolveSidebarConversationTarget } from './sidebarConversationTarget';
import {
  computeConversationFingerprint,
  waitForConversationFingerprintChangeOrTimeout,
} from './topNodePreload';

// Storage key to persist export state across reloads (e.g. when clicking top node triggers refresh)
const SESSION_KEY_PENDING_EXPORT = 'gv_export_pending';
const CONVERSATION_MENU_SELECTOR = `${CHATGPT_MENU_SELECTOR}, .mat-mdc-menu-panel[role="menu"]`;
const CONVERSATION_MENU_TRIGGER_TEST_ID = 'actions-menu-button';
const RESPONSE_MENU_TRIGGER_TEST_ID = 'more-menu-button';
const MENU_INJECTION_RETRY_LIMIT = 8;
const MENU_INJECTION_RETRY_DELAY_MS = 80;
const EXPORT_PRELOAD_WAIT_OPTIONS = {
  timeoutMs: 12000,
  minWaitMs: 700,
  idleMs: 320,
  pollIntervalMs: 90,
  maxSamples: 10,
} as const;
const FINAL_EXPORT_PREPARE_DELAY_MS = 120;
let conversationMenuObserver: MutationObserver | null = null;
let responseActionAddedNodeHandler: ((node: HTMLElement) => void) | null = null;
let recentExportMenuTrigger: HTMLElement | null = null;
let exportStarted = false;
let exportGeneration = 0;
let exportMenuTriggerInteractionHandler: ((event: Event) => void) | null = null;
let exportStorageChangeHandler:
  | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
  | null = null;
let removeExportPageExitListener: (() => void) | null = null;
let activeExportSelectionCleanup: (() => void) | null = null;
let exportStartupAbortController: AbortController | null = null;
const exportInjectionTimers = new Set<number>();

type ExportStartupResult<T> = { status: 'completed'; value: T } | { status: 'cancelled' };

/**
 * Extension storage can outlive the content lifecycle (and callback-style
 * implementations can fail to answer at all). Let stopExportButton release
 * callers immediately while still observing the original promise so a late
 * rejection never becomes unhandled.
 */
function waitForExportStartupTask<T>(
  task: Promise<T>,
  signal: AbortSignal,
): Promise<ExportStartupResult<T>> {
  if (signal.aborted) return Promise.resolve({ status: 'cancelled' });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: ExportStartupResult<T>) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ status: 'cancelled' });

    signal.addEventListener('abort', onAbort, { once: true });
    task.then(
      (value) => finish({ status: 'completed', value }),
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function scheduleExportInjection(callback: () => void, delay: number): number {
  const generation = exportGeneration;
  const timer = window.setTimeout(() => {
    exportInjectionTimers.delete(timer);
    if (!exportStarted || generation !== exportGeneration) return;
    callback();
  }, delay);
  exportInjectionTimers.add(timer);
  return timer;
}

interface PendingExportState {
  format: ExportFormat;
  fontSize?: number;
  imageWidth?: number;
  initialSelectedMessageId?: string;
  attempt: number;
  url: string;
  status: 'clicking';
  timestamp: number;
}

function hashString(input: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function isExportFormat(value: unknown): value is ExportFormat {
  return value === 'json' || value === 'markdown' || value === 'pdf' || value === 'image';
}

function waitForElement(selector: string, timeoutMs: number = 6000): Promise<Element | null> {
  return new Promise((resolve) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const obs = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) {
        try {
          obs.disconnect();
        } catch {}
        resolve(found);
      }
    });
    try {
      obs.observe(document.body, { childList: true, subtree: true });
    } catch {}
    if (timeoutMs > 0)
      setTimeout(() => {
        try {
          obs.disconnect();
        } catch {}
        resolve(null);
      }, timeoutMs);
  });
}

function waitForAnyElement(
  selectors: string[],
  timeoutMs: number = 10000,
): Promise<Element | null> {
  return new Promise((resolve) => {
    // Check first
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) return resolve(el);
    }

    const obs = new MutationObserver(() => {
      for (const s of selectors) {
        const found = document.querySelector(s);
        if (found) {
          try {
            obs.disconnect();
          } catch {}
          resolve(found);
          return;
        }
      }
    });

    try {
      obs.observe(document.body, { childList: true, subtree: true });
    } catch {}

    if (timeoutMs > 0)
      setTimeout(() => {
        try {
          obs.disconnect();
        } catch {}
        resolve(null);
      }, timeoutMs);
  });
}

function normalizeText(text: string | null): string {
  try {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

// Note: cleaning of thinking toggles is handled at DOM level in extractAssistantText

/**
 * querySelector variant that skips elements nested inside model-thoughts / thoughts-container.
 * When the user expands a reasoning section, a second message content element
 * appears *before* the real response in DOM order.  A plain `querySelector` would match
 * the thinking panel first, causing exports to grab the wrong content.
 */
function queryOutsideThoughts<T extends Element = Element>(
  root: Element,
  selector: string,
): T | null {
  const candidates = root.querySelectorAll<T>(selector);
  for (const el of Array.from(candidates)) {
    if (!el.closest('model-thoughts, .thoughts-container, .thoughts-content')) {
      return el;
    }
  }
  return null;
}

function filterTopLevel(elements: Element[]): HTMLElement[] {
  const arr = elements.map((e) => e as HTMLElement);
  const out: HTMLElement[] = [];
  for (let i = 0; i < arr.length; i++) {
    const el = arr[i];
    let isDescendant = false;
    for (let j = 0; j < arr.length; j++) {
      if (i === j) continue;
      const other = arr[j];
      if (other.contains(el)) {
        isDescendant = true;
        break;
      }
    }
    if (!isDescendant) out.push(el);
  }
  return out;
}

function getConversationRoot(userSelectors: string[]): HTMLElement {
  return resolveConversationRoot({ userSelectors, doc: document });
}

function computeConversationId(): string {
  return buildConversationIdFromUrl(window.location.href);
}

function getUserSelectors(): string[] {
  const configured = (() => {
    try {
      return (
        localStorage.getItem('gptTimelineUserTurnSelector') ||
        localStorage.getItem('gptTimelineUserTurnSelectorAuto') ||
        ''
      );
    } catch {
      return '';
    }
  })();
  const defaults = [
    '.user-query-bubble-with-background',
    '.user-query-bubble-container',
    '.user-query-container',
    'user-query-content .user-query-bubble-with-background',
    'div[aria-label="User message"]',
    'article[data-author="user"]',
    'article[data-turn="user"]',
    '[data-message-author-role="user"]',
    'div[role="listitem"][data-user="true"]',
  ];
  return configured ? [configured, ...defaults.filter((s) => s !== configured)] : defaults;
}

function getAssistantSelectors(): string[] {
  return [
    // Attribute-based roles
    '[data-message-author-role="assistant"]',
    '[data-message-author-role="model"]',
    'article[data-author="assistant"]',
    'article[data-turn="assistant"]',
    'article[data-turn="model"]',
    // Common legacy response containers
    '.model-response, model-response',
    '.response-container',
    'div[role="listitem"]:not([data-user="true"])',
  ];
}

function dedupeByTextAndOffset(elements: HTMLElement[], firstTurnOffset: number): HTMLElement[] {
  const seen = new Set<string>();
  const out: HTMLElement[] = [];
  for (const el of elements) {
    const offsetFromStart = (el.offsetTop || 0) - firstTurnOffset;
    const key = `${normalizeText(el.textContent || '')}|${Math.round(offsetFromStart)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(el);
  }
  return out;
}

function ensureTurnId(el: Element, index: number): string {
  const asEl = el as HTMLElement & {
    dataset?: DOMStringMap & { turnId?: string };
  };
  let id = asEl.dataset?.turnId || '';
  if (!id) {
    const basis = normalizeText(asEl.textContent || '') || `user-${index}`;
    id = `u-${index}-${hashString(basis)}`;
    try {
      if (asEl.dataset) asEl.dataset.turnId = id;
    } catch {}
  }
  return id;
}

function getStarredStorageKeys(): string[] {
  const cid = computeConversationId();
  const candidateConversationIds = [
    cid,
    buildRouteConversationIdFromUrl(window.location.href),
    buildLegacyConversationIdFromUrl(window.location.href),
  ];
  return Array.from(new Set(candidateConversationIds.map((id) => `${TIMELINE_STARS_PREFIX}${id}`)));
}

function readStarredSet(): Set<string> {
  try {
    for (const key of getStarredStorageKeys()) {
      const raw = getTimelinePrivateItemSync(key);
      if (!raw) continue;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) continue;
      return new Set(arr.map((x: unknown) => String(x)));
    }

    return new Set();
  } catch {
    return new Set();
  }
}

function extractAssistantText(el: HTMLElement): string {
  // Prefer direct text from message container if available (connected to DOM)
  // Use queryOutsideThoughts to avoid matching the message-content inside
  // the expanded thinking/reasoning panel.
  try {
    const mc = queryOutsideThoughts<HTMLElement>(
      el,
      'message-content, .markdown, .markdown-main-panel',
    );
    if (mc) {
      const raw = mc.textContent || mc.innerText || '';
      const txt = normalizeText(raw);
      if (txt) return txt;
    }
  } catch {}

  // Clone and remove reasoning toggles/labels before reading text (detached fallback)
  const clone = el.cloneNode(true) as HTMLElement;
  const matchesReasonToggle = (txt: string): boolean => {
    const s = normalizeText(txt).toLowerCase();
    if (!s) return false;
    return /^(show\s*(thinking|reasoning)|hide\s*(thinking|reasoning))$/i.test(s);
  };
  const shouldDrop = (node: HTMLElement): boolean => {
    const role = (node.getAttribute('role') || '').toLowerCase();
    const aria = (node.getAttribute('aria-label') || '').toLowerCase();
    const txt = node.textContent || '';
    if (matchesReasonToggle(txt)) return true;
    if (role === 'button' && /thinking|reasoning/i.test(txt)) return true;
    if (/thinking|reasoning/i.test(aria)) return true;
    return false;
  };
  try {
    const candidates = clone.querySelectorAll(
      'button, [role="button"], [aria-label], span, div, a',
    );
    candidates.forEach((n) => {
      const eln = n as HTMLElement;
      if (shouldDrop(eln)) eln.remove();
    });
  } catch {}
  const text = normalizeText(clone.innerText || clone.textContent || '');
  return text;
}

type ChatTurn = {
  turnId: string;
  user: string;
  assistant: string;
  starred: boolean;
  userElement?: HTMLElement;
  assistantElement?: HTMLElement;
  assistantHostElement?: HTMLElement;
};

function collectChatPairs(): ChatTurn[] {
  const userSelectors = getUserSelectors();
  const root = getConversationRoot(userSelectors);
  const assistantSelectors = getAssistantSelectors();
  const userNodeList = filterOutDeepResearchImmersiveNodes(
    Array.from(root.querySelectorAll<HTMLElement>(userSelectors.join(','))),
  );
  if (!userNodeList || userNodeList.length === 0) return [];
  let users = filterTopLevel(userNodeList);
  if (users.length === 0) return [];

  const firstOffset = (users[0] as HTMLElement).offsetTop || 0;
  users = dedupeByTextAndOffset(users, firstOffset);
  const userOffsets = users.map((el) => (el as HTMLElement).offsetTop || 0);

  const assistantsAll = filterOutDeepResearchImmersiveNodes(
    Array.from(root.querySelectorAll<HTMLElement>(assistantSelectors.join(','))),
  );
  const assistants = filterTopLevel(assistantsAll);
  const assistantOffsets = assistants.map((el) => (el as HTMLElement).offsetTop || 0);

  const starredSet = readStarredSet();
  const pairs: ChatTurn[] = [];
  for (let i = 0; i < users.length; i++) {
    const uEl = users[i] as HTMLElement;
    const uText = normalizeText(uEl.innerText || uEl.textContent || '');
    const start = userOffsets[i];
    const end = i + 1 < userOffsets.length ? userOffsets[i + 1] : Number.POSITIVE_INFINITY;
    let aText = '';
    let aEl: HTMLElement | null = null;
    let bestIdx = -1;
    let bestOff = Number.POSITIVE_INFINITY;
    for (let k = 0; k < assistants.length; k++) {
      const off = assistantOffsets[k];
      if (off >= start && off < end) {
        if (off < bestOff) {
          bestOff = off;
          bestIdx = k;
        }
      }
    }
    if (bestIdx >= 0) {
      aEl = assistants[bestIdx] as HTMLElement;
      aText = extractAssistantText(aEl);
    } else {
      // Fallback: search next siblings up to a small window
      let sib: HTMLElement | null = uEl;
      for (let step = 0; step < 8 && sib; step++) {
        sib = sib.nextElementSibling as HTMLElement | null;
        if (!sib) break;
        if (sib.matches(userSelectors.join(','))) break;
        if (sib.matches(assistantSelectors.join(','))) {
          aEl = sib;
          aText = extractAssistantText(sib);
          break;
        }
      }
    }
    const turnId = ensureTurnId(uEl, i);
    const starred = !!turnId && starredSet.has(turnId);
    if (uText || aText) {
      // Prefer a richer assistant container for downstream rich extraction
      let finalAssistantEl: HTMLElement | undefined = undefined;
      if (aEl) {
        const pick =
          queryOutsideThoughts<HTMLElement>(aEl, 'message-content') ||
          queryOutsideThoughts<HTMLElement>(aEl, '.markdown, .markdown-main-panel') ||
          (aEl.closest('.presented-response-container') as HTMLElement | null) ||
          queryOutsideThoughts<HTMLElement>(
            aEl,
            '.presented-response-container, .response-content',
          ) ||
          queryOutsideThoughts<HTMLElement>(aEl, 'response-element') ||
          aEl;
        finalAssistantEl = pick || undefined;
      }
      pairs.push({
        turnId,
        user: uText,
        assistant: aText,
        starred,
        userElement: uEl,
        assistantElement: finalAssistantEl,
        assistantHostElement: aEl || undefined,
      });
    }
  }
  return pairs;
}

type ExportMessageRole = 'user' | 'assistant';

type ExportMessage = {
  messageId: string;
  role: ExportMessageRole;
  hostElement: HTMLElement;
  exportElement?: HTMLElement;
  text: string;
  starred: boolean;
};

function buildExportMessagesFromPairs(pairs: ChatTurn[]): ExportMessage[] {
  const out: ExportMessage[] = [];
  pairs.forEach((pair) => {
    if (pair.userElement) {
      out.push({
        messageId: `${pair.turnId}:u`,
        role: 'user',
        hostElement: pair.userElement,
        exportElement: pair.userElement,
        text: pair.user,
        starred: pair.starred,
      });
    }

    const assistantHost = pair.assistantHostElement;
    if (assistantHost) {
      out.push({
        messageId: `${pair.turnId}:a`,
        role: 'assistant',
        hostElement: assistantHost,
        exportElement: pair.assistantElement || assistantHost,
        text: pair.assistant,
        starred: pair.starred,
      });
    }
  });
  return out;
}

function computeSortedMessages(pairsInput: ChatTurn[]): Array<ExportMessage & { absTop: number }> {
  const msgs = buildExportMessagesFromPairs(pairsInput);
  const withPos = msgs.map((message) => {
    const rect = message.hostElement.getBoundingClientRect();
    return {
      ...message,
      absTop: rect.top + window.scrollY,
    };
  });

  withPos.sort((a, b) => a.absTop - b.absTop);
  return withPos;
}

function buildTurnsForSelectedMessages(
  selectedMessages: readonly ExportMessage[],
): ExportChatTurn[] {
  const groupedTurns = groupSelectedMessagesByTurn(selectedMessages);
  return groupedTurns
    .map((turn) => ({
      user: turn.user?.text || '',
      assistant: turn.assistant?.text || '',
      starred: turn.starred,
      omitEmptySections: true,
      userElement: turn.user?.exportElement,
      assistantElement: turn.assistant?.exportElement,
    }))
    .filter(
      (turn) =>
        turn.user.length > 0 ||
        turn.assistant.length > 0 ||
        !!turn.userElement ||
        !!turn.assistantElement,
    );
}

function buildTurnsForSelectedMessageIds(
  selectedMessageIds: ReadonlySet<string>,
  pairsInput: ChatTurn[] = collectChatPairs(),
): ExportChatTurn[] {
  if (selectedMessageIds.size === 0) return [];
  const selectedMessages = computeSortedMessages(pairsInput).filter((message) =>
    selectedMessageIds.has(message.messageId),
  );
  return buildTurnsForSelectedMessages(selectedMessages);
}

function resolveAssistantMessageIdFromMenuTrigger(trigger: HTMLElement | null): string | null {
  if (!trigger) return null;

  const assistantHost =
    findAssistantTurnForElement(trigger) ||
    (trigger.closest(
      '.response-container, response-container, .model-response, model-response',
    ) as HTMLElement | null);
  if (!assistantHost) return null;

  const messages = buildExportMessagesFromPairs(collectChatPairs());
  const target = messages.find((message) => {
    if (message.role !== 'assistant') return false;
    const host = message.hostElement;
    return (
      host === assistantHost ||
      host.contains(assistantHost) ||
      assistantHost.contains(host) ||
      host.contains(trigger)
    );
  });

  return target?.messageId || null;
}

export function buildResponseImageTurnForTrigger(trigger: HTMLElement): ExportChatTurn | null {
  const assistantHost =
    findAssistantTurnForElement(trigger) ||
    (trigger.closest(
      '.response-container, response-container, .model-response, model-response, .presented-response-container',
    ) as HTMLElement | null);
  if (!assistantHost) return null;

  const assistantElement =
    queryOutsideThoughts<HTMLElement>(
      assistantHost,
      'message-content, .markdown, .markdown-main-panel',
    ) || assistantHost;
  const assistant = extractAssistantText(assistantHost);
  if (!assistant && assistantElement === assistantHost) return null;

  return {
    user: '',
    assistant,
    starred: false,
    omitEmptySections: true,
    assistantElement,
  };
}

async function loadDictionaries(): Promise<Record<AppLanguage, Record<string, string>>> {
  try {
    const [enRaw, zhRaw] = await Promise.all([
      import(/* @vite-ignore */ '../../../locales/en/messages.json'),
      import(/* @vite-ignore */ '../../../locales/zh/messages.json'),
    ]);

    return {
      en: extractMessageDictionary(enRaw),
      zh: extractMessageDictionary(zhRaw),
    };
  } catch {
    return {
      en: {},
      zh: {},
    };
  }
}

/**
 * Extract human-readable conversation title from the current page
 * Used for JSON/Markdown metadata so all formats share the same title.
 * Mirrors the logic used by PDFPrintService.getConversationTitle.
 */
function isMeaningfulConversationTitle(title: string | null | undefined): title is string {
  const t = (title || '').trim();
  if (!t) return false;
  if (t === 'Untitled Conversation' || t === 'ChatGPT' || t === 'New chat') {
    return false;
  }
  if (t.startsWith('ChatGPT -')) return false;
  return true;
}

function extractConversationIdFromUrl(): string | null {
  return extractNativeConversationIdFromUrl(window.location.href);
}

function extractTitleFromLinkText(link?: HTMLAnchorElement | null): string | null {
  if (!link) return null;
  const text = (link.innerText || link.textContent || '').trim();
  if (!text) return null;
  const parts = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s.length >= 2);
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => (b.length > a.length ? b : a), parts[0]) || null;
}

function extractTitleFromConversationElement(conversationEl: HTMLElement): string | null {
  const semanticTitle = getChatGptConversationTitle(conversationEl)?.trim();
  if (isMeaningfulConversationTitle(semanticTitle)) return semanticTitle;

  const link = getChatGptConversationLink(conversationEl);
  const fromLinkText = extractTitleFromLinkText(link);
  if (isMeaningfulConversationTitle(fromLinkText)) {
    return fromLinkText;
  }

  const raw = conversationEl.textContent?.trim() || '';
  if (!raw) return null;
  const firstLine =
    raw
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)[0] || raw;
  if (isMeaningfulConversationTitle(firstLine)) {
    return firstLine.slice(0, 80);
  }

  return null;
}

function extractTitleFromNativeSidebarByConversationId(conversationId: string): string | null {
  const expected = normalizeChatGptConversationId(conversationId);
  for (const conversation of getChatGptConversationElements(document)) {
    if (normalizeChatGptConversationId(getChatGptConversationId(conversation)) !== expected) {
      continue;
    }
    const title = extractTitleFromConversationElement(conversation);
    if (title) return title;
  }

  return null;
}

function getConversationTitleForExport(): string {
  // Strategy 1: Get from active conversation in GPT-Voyager Folder UI (most accurate)
  try {
    const activeFolderTitle =
      document.querySelector(
        '.gv-folder-conversation.gv-folder-conversation-selected .gv-conversation-title',
      ) || document.querySelector('.gv-folder-conversation-selected .gv-conversation-title');

    if (activeFolderTitle?.textContent?.trim()) {
      return activeFolderTitle.textContent.trim();
    }
  } catch (error) {
    try {
      console.debug('[Export] Failed to get title from Folder Manager:', error);
    } catch {}
  }

  // Strategy 1b: Get from ChatGPT sidebar via current conversation ID
  try {
    const conversationId = extractConversationIdFromUrl();
    if (conversationId) {
      const title = extractTitleFromNativeSidebarByConversationId(conversationId);
      if (title) return title;
    }
  } catch (error) {
    try {
      console.debug('[Export] Failed to get title from native sidebar by conversation id:', error);
    } catch {}
  }

  // Strategy 2: Try to get from page title
  const titleElement = document.querySelector('title');
  if (titleElement) {
    const title = titleElement.textContent?.trim();
    if (isMeaningfulConversationTitle(title)) {
      return title;
    }
  }

  // Strategy 3: URL fallback
  const conversationId = extractConversationIdFromUrl();
  if (conversationId) {
    return `Conversation ${conversationId.slice(0, 8)}`;
  }

  return 'Untitled Conversation';
}

function findSidebarConversationLinkById(conversationId: string): HTMLAnchorElement | null {
  const expected = normalizeChatGptConversationId(conversationId);
  for (const conversation of getChatGptConversationElements(document)) {
    if (normalizeChatGptConversationId(getChatGptConversationId(conversation)) !== expected) {
      continue;
    }
    const link = getChatGptConversationLink(conversation);
    if (link) return link;
  }

  return null;
}

function triggerNativeClick(target: HTMLElement): void {
  const opts = { bubbles: true, cancelable: true, view: window };
  target.dispatchEvent(new MouseEvent('pointerdown', opts));
  target.dispatchEvent(new MouseEvent('mousedown', opts));
  target.dispatchEvent(new MouseEvent('mouseup', opts));
  target.dispatchEvent(new MouseEvent('click', opts));
}

async function waitForConversationUrl(
  conversationId: string,
  timeoutMs: number = 10000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (extractConversationIdFromUrl() === conversationId) return true;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

async function navigateToConversationAndWait(
  conversationId: string,
  fallbackUrl: string,
): Promise<boolean> {
  const currentConversationId = extractConversationIdFromUrl();
  if (currentConversationId === conversationId) {
    const existing = await waitForAnyElement(getUserSelectors(), 8000);
    return !!existing;
  }

  const link = findSidebarConversationLinkById(conversationId);
  if (link) {
    triggerNativeClick(link);
  } else if (fallbackUrl) {
    window.location.assign(fallbackUrl);
  } else {
    return false;
  }

  const routeReady = await waitForConversationUrl(conversationId, 12000);
  if (!routeReady) return false;
  const contentReady = await waitForAnyElement(getUserSelectors(), 15000);
  return !!contentReady;
}

async function exportFromSidebarConversationTrigger(
  trigger: HTMLElement,
  dict: Record<AppLanguage, Record<string, string>>,
  getCurrentLanguage: () => AppLanguage,
): Promise<void> {
  const target = resolveSidebarConversationTarget(trigger);
  if (!target) {
    alert('Unable to locate the selected conversation. Please open it first, then export.');
    return;
  }

  const ready = await navigateToConversationAndWait(target.conversationId, target.url);
  if (!ready) {
    alert('Failed to open the selected conversation for export. Please retry.');
    return;
  }

  await showExportDialog(dict, getCurrentLanguage());
}

function normalizeLang(lang: string | undefined): AppLanguage {
  return normalizeLanguage(lang);
}

async function getLanguage(): Promise<AppLanguage> {
  try {
    // Add timeout to prevent hanging in Firefox
    const stored = await Promise.race([
      new Promise<unknown>((resolve) => {
        try {
          const win = window as Window & {
            chrome?: {
              storage?: {
                sync?: { get: (key: string, cb: (r: unknown) => void) => void };
              };
            };
            browser?: {
              storage?: { sync?: { get: (key: string) => Promise<unknown> } };
            };
          };
          if (win.chrome?.storage?.sync?.get) {
            win.chrome.storage.sync.get(StorageKeys.LANGUAGE, resolve);
          } else if (win.browser?.storage?.sync?.get) {
            win.browser.storage.sync
              .get(StorageKeys.LANGUAGE)
              .then(resolve)
              .catch(() => resolve({}));
          } else {
            resolve({});
          }
        } catch {
          resolve({});
        }
      }),
      new Promise<unknown>((resolve) => setTimeout(() => resolve({}), 1000)),
    ]);
    const rec = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
    const v =
      typeof rec[StorageKeys.LANGUAGE] === 'string'
        ? (rec[StorageKeys.LANGUAGE] as string)
        : undefined;
    return normalizeLang(v || navigator.language || 'en');
  } catch {
    return 'en';
  }
}

/**
 * Finds the top-most user message element in the DOM.
 */
function getTopUserElement(selectors: string[]): HTMLElement | null {
  const root = getConversationRoot(selectors);
  const all = filterOutDeepResearchImmersiveNodes(
    Array.from(root.querySelectorAll<HTMLElement>(selectors.join(','))),
  );
  if (!all.length) return null;
  const topLevel = filterTopLevel(all);
  return topLevel.length > 0 ? topLevel[0] : null;
}

function isElementVisibleForAlignment(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width < 24 || rect.height < 12) return false;

  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const opacity = Number.parseFloat(style.opacity || '1');
  if (Number.isFinite(opacity) && opacity <= 0.01) return false;

  return true;
}

function isLikelySidebarElement(el: HTMLElement): boolean {
  if (
    el.closest(
      [
        '[data-test-id="side-nav"]',
        'side-navigation',
        'mat-sidenav',
        'aside',
        'nav',
        '.side-nav',
        '.sidenav',
        '.chat-history-nav',
      ].join(','),
    )
  ) {
    return true;
  }

  const rect = el.getBoundingClientRect();
  const isNarrow = rect.width > 0 && rect.width <= Math.max(380, window.innerWidth * 0.45);
  const isLeftRail = rect.left <= Math.max(40, window.innerWidth * 0.18);
  const isTall = rect.height >= window.innerHeight * 0.35;
  return isNarrow && isLeftRail && isTall;
}

function pickBestVisibleAlignmentTarget(
  selectors: string[],
  options?: {
    minWidth?: number;
    minHeight?: number;
    allowSidebar?: boolean;
  },
): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(selectors.join(',')));
  let best: { el: HTMLElement; score: number } | null = null;
  const minWidth = options?.minWidth ?? 220;
  const minHeight = options?.minHeight ?? 24;
  const viewportCenter = window.innerWidth / 2;

  for (const candidate of candidates) {
    if (!candidate.isConnected) continue;
    if (!isElementVisibleForAlignment(candidate)) continue;
    if (!options?.allowSidebar && isLikelySidebarElement(candidate)) continue;

    const rect = candidate.getBoundingClientRect();
    if (rect.width < minWidth || rect.height < minHeight) continue;
    if (rect.bottom < -16 || rect.top > window.innerHeight + 16) continue;

    const center = rect.left + rect.width / 2;
    const area = rect.width * rect.height;
    const distancePenalty = Math.abs(center - viewportCenter) * 120;
    const score = area - distancePenalty;

    if (!best || score > best.score) {
      best = { el: candidate, score };
    }
  }

  return best?.el || null;
}

function resolveConversationCanvasCenterX(): number {
  const viewportCenter = window.innerWidth / 2;

  const canvasTarget = pickBestVisibleAlignmentTarget(
    [
      '#chat-history',
      'infinite-scroller.chat-history',
      '.chat-history-scroll-container',
      'chat-window-content',
      'main chat-window-content',
    ],
    {
      minWidth: Math.min(420, Math.max(280, window.innerWidth * 0.42)),
      minHeight: 80,
    },
  );
  if (canvasTarget) {
    const rect = canvasTarget.getBoundingClientRect();
    return rect.left + rect.width / 2;
  }

  const composerTarget = pickBestVisibleAlignmentTarget(
    [
      'rich-textarea',
      '[aria-label*="Enter a prompt"]',
      '[aria-label*="prompt"]',
      '[contenteditable="true"][aria-label]',
    ],
    {
      minWidth: Math.min(460, Math.max(240, window.innerWidth * 0.28)),
      minHeight: 28,
    },
  );
  if (composerTarget) {
    const rect = composerTarget.getBoundingClientRect();
    return rect.left + rect.width / 2;
  }

  const selectors = getUserSelectors();
  const topUser = getTopUserElement(selectors);
  if (topUser && !isLikelySidebarElement(topUser)) {
    const rect = topUser.getBoundingClientRect();
    if (rect.width > 24) return rect.left + rect.width / 2;
  }

  const root = getConversationRoot(selectors);
  if (root && !isLikelySidebarElement(root)) {
    const rect = root.getBoundingClientRect();
    if (rect.width > Math.max(300, window.innerWidth * 0.42)) return rect.left + rect.width / 2;
  }

  const main = document.querySelector<HTMLElement>('main');
  if (main && !isLikelySidebarElement(main)) {
    const rect = main.getBoundingClientRect();
    if (rect.width > 24) return rect.left + rect.width / 2;
  }

  return viewportCenter;
}

function alignElementToConversationTitleCenter(element: HTMLElement): () => void {
  const apply = () => {
    if (window.innerWidth <= 640) {
      element.style.removeProperty('left');
      element.style.removeProperty('transform');
      return;
    }

    const rawCenter = resolveConversationCanvasCenterX();
    const safeMargin = 24;
    const clampedCenter = Math.round(
      Math.max(safeMargin, Math.min(window.innerWidth - safeMargin, rawCenter)),
    );
    element.style.left = `${clampedCenter}px`;
    element.style.transform = 'translateX(-50%)';
  };

  apply();
  const resizeHandler = () => apply();
  window.addEventListener('resize', resizeHandler);
  const timeoutId = window.setTimeout(apply, 220);

  return () => {
    window.removeEventListener('resize', resizeHandler);
    window.clearTimeout(timeoutId);
  };
}

/**
 * Executes the export sequence:
 * 1. Find top node and click it.
 * 2. Wait to see if refresh happens.
 * 3. If refresh -> script dies, on load we resume.
 * 4. If no refresh -> we are stable, proceed to export.
 */
async function executeExportSequence(
  format: ExportFormat,
  dict: Record<AppLanguage, Record<string, string>>,
  lang: AppLanguage,
  paramState?: PendingExportState,
  fontSize?: number,
  initialSelectedMessageId?: string,
  imageWidth?: number,
): Promise<void> {
  const state: PendingExportState = paramState || {
    format,
    fontSize,
    imageWidth,
    initialSelectedMessageId,
    attempt: 0,
    url: location.href,
    status: 'clicking',
    timestamp: Date.now(),
  };

  if (state.attempt > 25) {
    console.warn('[GPT-Voyager] Export aborted: too many attempts.');
    sessionStorage.removeItem(SESSION_KEY_PENDING_EXPORT);
    alert('Export stopped: Too many attempts detected.');
    return;
  }

  // 1. Find Top Node
  if (state.attempt > 0) {
    console.log('[GPT-Voyager] Resuming export... waiting for content load.');
    const userSelectors = getUserSelectors();
    await waitForAnyElement(userSelectors, 15000);
  }

  // Wait a bit if we just reloaded
  const userSelectors = getUserSelectors();
  let topNode = getTopUserElement(userSelectors);
  if (!topNode) {
    await waitForElement('body', 2000);
    const pairs = collectChatPairs();
    if (pairs.length > 0 && pairs[0].userElement) {
      topNode = pairs[0].userElement;
    }
  }

  if (!topNode) {
    console.log('[GPT-Voyager] No top node found, proceeding to export directly.');
    sessionStorage.removeItem(SESSION_KEY_PENDING_EXPORT);
    await performFinalExport(
      format,
      dict,
      lang,
      state.fontSize,
      state.initialSelectedMessageId,
      state.imageWidth,
    );
    return;
  }

  const fingerprintSelectors = [...getUserSelectors(), ...getAssistantSelectors()];
  const beforeFingerprint = computeConversationFingerprint(document.body, fingerprintSelectors, 10);

  console.log(`[GPT-Voyager] Simulating click on top node (Attempt ${state.attempt + 1})...`);

  // Update state before action to persist across potential reload
  sessionStorage.setItem(
    SESSION_KEY_PENDING_EXPORT,
    JSON.stringify({
      ...state,
      attempt: state.attempt + 1,
      timestamp: Date.now(),
    }),
  );

  // Dispatch click logic
  try {
    topNode.scrollIntoView({ behavior: 'auto', block: 'center' });
    const opts = { bubbles: true, cancelable: true, view: window };
    topNode.dispatchEvent(new MouseEvent('mousedown', opts));
    topNode.dispatchEvent(new MouseEvent('mouseup', opts));
    topNode.click();
  } catch (e) {
    console.error('[GPT-Voyager] Failed to click top node:', e);
  }

  // 2. Wait for either hard refresh (page unload) OR a "soft refresh" that loads more history.
  // If the page unloads, the script stops and `checkPendingExport()` resumes on next load via sessionStorage.
  const { changed } = await waitForConversationFingerprintChangeOrTimeout(
    document.body,
    fingerprintSelectors,
    beforeFingerprint,
    EXPORT_PRELOAD_WAIT_OPTIONS,
  );

  if (changed) {
    console.log('[GPT-Voyager] History expanded (soft refresh). Clicking top node again...');
    await executeExportSequence(format, dict, lang, {
      ...state,
      attempt: state.attempt + 1,
      timestamp: Date.now(),
    });
    return;
  }

  console.log('[GPT-Voyager] No refresh or update detected. Exporting...');
  sessionStorage.removeItem(SESSION_KEY_PENDING_EXPORT);
  await performFinalExport(
    format,
    dict,
    lang,
    state.fontSize,
    state.initialSelectedMessageId,
    state.imageWidth,
  );
}

async function executeExportSequenceWithProgress(
  format: ExportFormat,
  dict: Record<AppLanguage, Record<string, string>>,
  lang: AppLanguage,
  paramState?: PendingExportState,
  fontSize?: number,
  initialSelectedMessageId?: string,
  imageWidth?: number,
): Promise<void> {
  const t = (key: TranslationKey) => dict[lang]?.[key] ?? dict.en?.[key] ?? key;
  const hideProgress = showExportProgressOverlay(t);
  try {
    await executeExportSequence(
      format,
      dict,
      lang,
      paramState,
      fontSize,
      initialSelectedMessageId,
      imageWidth,
    );
  } finally {
    hideProgress();
  }
}

/**
 * Performs the actual file generation and download.
 */
async function performFinalExport(
  format: ExportFormat,
  dict: Record<AppLanguage, Record<string, string>>,
  lang: AppLanguage,
  fontSize?: number,
  initialSelectedMessageId?: string,
  imageWidth?: number,
) {
  const t = (key: TranslationKey) => dict[lang]?.[key] ?? dict.en?.[key] ?? key;

  await new Promise((r) => setTimeout(r, FINAL_EXPORT_PREPARE_DELAY_MS));

  const pairs = collectChatPairs();
  const messages = buildExportMessagesFromPairs(pairs);
  if (messages.length === 0) {
    alert(t('export_dialog_warning'));
    return;
  }

  const selectedIds = new Set<string>();
  let allMessageIds: string[] = [];
  const cleanupTasks: Array<() => void> = [];
  const idToHost = new Map<string, HTMLElement>();
  const idToCheckbox = new Map<string, HTMLButtonElement>();
  const knownIds = new Set<string>();
  let pendingInitialSelectionId: string | null = initialSelectedMessageId || null;

  let autoSelectAll = false;

  const cleanup = () => {
    cleanupTasks.forEach((fn) => {
      try {
        fn();
      } catch {}
    });
    cleanupTasks.length = 0;
    if (activeExportSelectionCleanup === cleanup) activeExportSelectionCleanup = null;
  };
  activeExportSelectionCleanup?.();
  activeExportSelectionCleanup = cleanup;

  const setSelected = (id: string, next: boolean) => {
    if (next) selectedIds.add(id);
    else selectedIds.delete(id);

    const btn = idToCheckbox.get(id);
    if (btn) {
      btn.setAttribute('aria-pressed', next ? 'true' : 'false');
      btn.dataset.selected = next ? 'true' : 'false';
    }
    const host = idToHost.get(id);
    if (host) {
      if (next) host.classList.add('gv-export-msg-selected');
      else host.classList.remove('gv-export-msg-selected');
    }
  };

  const updateBottomBar = (bar: HTMLElement) => {
    const countEl = bar.querySelector(
      '[data-gv-export-selection-count="true"]',
    ) as HTMLElement | null;
    if (countEl) {
      countEl.textContent = t('export_select_mode_count').replace(
        '{count}',
        String(selectedIds.size),
      );
    }

    const exportBtn = bar.querySelector(
      '[data-gv-export-action="export"]',
    ) as HTMLButtonElement | null;
    if (exportBtn) {
      exportBtn.disabled = selectedIds.size === 0;
    }

    const selectAllBtn = bar.querySelector(
      '[data-gv-export-action="selectAll"]',
    ) as HTMLButtonElement | null;
    if (selectAllBtn) {
      const isAllSelected = allMessageIds.length > 0 && selectedIds.size === allMessageIds.length;
      selectAllBtn.dataset.checked = isAllSelected ? 'true' : 'false';
    }

    const selectUserBtn = bar.querySelector(
      '[data-gv-export-action="selectUser"]',
    ) as HTMLButtonElement | null;
    if (selectUserBtn) {
      const userMessageIds = allMessageIds.filter((id) => id.endsWith(':u'));
      const isOnlyUserSelected =
        userMessageIds.length > 0 &&
        selectedIds.size === userMessageIds.length &&
        userMessageIds.every((id) => selectedIds.has(id));
      selectUserBtn.dataset.checked = isOnlyUserSelected ? 'true' : 'false';
    }

    const selectAIBtn = bar.querySelector(
      '[data-gv-export-action="selectAI"]',
    ) as HTMLButtonElement | null;
    if (selectAIBtn) {
      const aiMessageIds = allMessageIds.filter((id) => id.endsWith(':a'));
      const isOnlyAISelected =
        aiMessageIds.length > 0 &&
        selectedIds.size === aiMessageIds.length &&
        aiMessageIds.every((id) => selectedIds.has(id));
      selectAIBtn.dataset.checked = isOnlyAISelected ? 'true' : 'false';
    }
  };

  const attachSelectorIfNeeded = (msg: ExportMessage) => {
    if (knownIds.has(msg.messageId)) return;
    knownIds.add(msg.messageId);

    const host = msg.hostElement;
    idToHost.set(msg.messageId, host);
    host.classList.add('gv-export-msg-host');
    cleanupTasks.push(() => host.classList.remove('gv-export-msg-host'));

    const selector = document.createElement('div');
    selector.className = 'gv-export-msg-selector';
    selector.dataset.gvExportMessageId = msg.messageId;

    const checkbox = document.createElement('button');
    checkbox.type = 'button';
    checkbox.className = 'gv-export-msg-checkbox';
    checkbox.setAttribute('aria-pressed', 'false');
    checkbox.title = t('export_select_mode_toggle');

    const mark = document.createElement('span');
    mark.className = 'gv-export-msg-checkbox-mark';
    checkbox.appendChild(mark);

    const swallow = (ev: Event) => {
      try {
        ev.preventDefault();
      } catch {}
      try {
        ev.stopPropagation();
      } catch {}
    };

    const toggleSelection = () => {
      autoSelectAll = false;
      const next = !selectedIds.has(msg.messageId);
      setSelected(msg.messageId, next);
      const bar = document.querySelector(
        '[data-gv-export-select-bar="true"]',
      ) as HTMLElement | null;
      if (bar) updateBottomBar(bar);
    };

    checkbox.addEventListener('click', (ev) => {
      swallow(ev);
      toggleSelection();
    });

    host.addEventListener('click', toggleSelection);
    cleanupTasks.push(() => host.removeEventListener('click', toggleSelection));

    selector.appendChild(checkbox);
    host.appendChild(selector);
    cleanupTasks.push(() => selector.remove());

    idToCheckbox.set(msg.messageId, checkbox);
  };

  const syncMessages = (pairsInput: ChatTurn[]) => {
    const sorted = computeSortedMessages(pairsInput);
    allMessageIds = sorted.map((m) => m.messageId);

    sorted.forEach((m) => attachSelectorIfNeeded(m));

    // Auto-select new messages when a policy is active.
    if (autoSelectAll) {
      for (const id of allMessageIds) setSelected(id, true);
    }

    const initialSelected = resolveInitialSelectedMessageIds(
      allMessageIds,
      pendingInitialSelectionId,
    );
    if (initialSelected.size > 0) {
      initialSelected.forEach((id) => setSelected(id, true));
      pendingInitialSelectionId = null;
    }
  };

  // Selection mode body class
  document.body.classList.add('gv-export-select-mode');
  cleanupTasks.push(() => document.body.classList.remove('gv-export-select-mode'));

  // Bottom action bar
  const bar = document.createElement('div');
  bar.className = 'gv-export-select-bar';
  bar.dataset.gvExportSelectBar = 'true';

  const selectAllBtn = document.createElement('button');
  selectAllBtn.type = 'button';
  selectAllBtn.className = 'gv-export-select-all-toggle';
  selectAllBtn.dataset.gvExportAction = 'selectAll';
  selectAllBtn.textContent = t('export_select_mode_select_all');

  const selectUserBtn = document.createElement('button');
  selectUserBtn.type = 'button';
  selectUserBtn.className = 'gv-export-select-role-btn';
  selectUserBtn.dataset.gvExportAction = 'selectUser';
  selectUserBtn.textContent = t('export_select_mode_only_user');

  const selectAIBtn = document.createElement('button');
  selectAIBtn.type = 'button';
  selectAIBtn.className = 'gv-export-select-role-btn';
  selectAIBtn.dataset.gvExportAction = 'selectAI';
  selectAIBtn.textContent = t('export_select_mode_only_ai');

  const count = document.createElement('div');
  count.className = 'gv-export-select-count';
  count.dataset.gvExportSelectionCount = 'true';
  count.textContent = t('export_select_mode_count').replace('{count}', '0');

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'gv-export-select-export-btn';
  exportBtn.dataset.gvExportAction = 'export';
  exportBtn.textContent = t('pm_export');
  exportBtn.disabled = true;

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'gv-export-select-cancel-btn';
  cancelBtn.title = t('pm_cancel');
  cancelBtn.textContent = 'x';

  bar.appendChild(selectAllBtn);
  bar.appendChild(selectUserBtn);
  bar.appendChild(selectAIBtn);
  bar.appendChild(count);
  bar.appendChild(exportBtn);
  bar.appendChild(cancelBtn);

  document.body.appendChild(bar);

  const swallow = (ev: Event) => {
    try {
      ev.preventDefault();
    } catch {}
    try {
      ev.stopPropagation();
    } catch {}
  };

  selectUserBtn.addEventListener('click', (ev) => {
    swallow(ev);
    autoSelectAll = false;

    const userMessageIds = allMessageIds.filter((id) => id.endsWith(':u'));
    const isOnlyUserSelected =
      userMessageIds.length > 0 &&
      selectedIds.size === userMessageIds.length &&
      userMessageIds.every((id) => selectedIds.has(id));

    if (isOnlyUserSelected) {
      for (const id of allMessageIds) {
        setSelected(id, false);
      }
    } else {
      for (const id of allMessageIds) {
        setSelected(id, id.endsWith(':u'));
      }
    }
    updateBottomBar(bar);
  });

  selectAIBtn.addEventListener('click', (ev) => {
    swallow(ev);
    autoSelectAll = false;

    const aiMessageIds = allMessageIds.filter((id) => id.endsWith(':a'));
    const isOnlyAISelected =
      aiMessageIds.length > 0 &&
      selectedIds.size === aiMessageIds.length &&
      aiMessageIds.every((id) => selectedIds.has(id));

    if (isOnlyAISelected) {
      for (const id of allMessageIds) {
        setSelected(id, false);
      }
    } else {
      for (const id of allMessageIds) {
        setSelected(id, id.endsWith(':a'));
      }
    }
    updateBottomBar(bar);
  });
  cleanupTasks.push(() => bar.remove());
  cleanupTasks.push(alignElementToConversationTitleCenter(bar));

  selectAllBtn.addEventListener('click', (ev) => {
    swallow(ev);
    const isAllSelected = allMessageIds.length > 0 && selectedIds.size === allMessageIds.length;
    if (isAllSelected) {
      selectedIds.clear();
      autoSelectAll = false;
      allMessageIds.forEach((id) => setSelected(id, false));
    } else {
      selectedIds.clear();
      autoSelectAll = true;
      allMessageIds.forEach((id) => setSelected(id, true));
    }
    updateBottomBar(bar);
  });

  const finish = () => {
    allMessageIds.forEach((id) => setSelected(id, false));
    selectedIds.clear();
    autoSelectAll = false;
    cleanup();
  };

  cancelBtn.addEventListener('click', (ev) => {
    swallow(ev);
    finish();
  });

  exportBtn.addEventListener('click', async (ev) => {
    swallow(ev);
    if (selectedIds.size === 0) {
      alert(t('export_select_mode_empty'));
      return;
    }

    const turnsForExport = buildTurnsForSelectedMessageIds(selectedIds, collectChatPairs());
    if (turnsForExport.length === 0) {
      alert(t('export_select_mode_empty'));
      return;
    }

    // Cleanup before export so selection UI isn't captured.
    finish();

    const metadata: ConversationMetadata = {
      url: location.href,
      exportedAt: new Date().toISOString(),
      count: turnsForExport.length,
      title: getConversationTitleForExport(),
    };

    let includeImageSource = true;
    if (format === 'markdown') {
      const hasSearchImages = turnsForExport.some(
        (turn) =>
          turn.assistantElement?.querySelector('.attachment-container.search-images') != null,
      );
      if (hasSearchImages) {
        includeImageSource = confirm(t('export_md_include_source_confirm'));
      }
    }

    const hideProgress = showExportProgressOverlay(t);
    try {
      const resultPromise = ConversationExportService.export(turnsForExport, metadata, {
        format,
        fontSize,
        includeImageSource,
        imageWidth,
      });
      const minVisiblePromise = new Promise((resolve) => setTimeout(resolve, 420));
      const [result] = await Promise.all([resultPromise, minVisiblePromise]);

      if (!result.success) {
        alert(resolveExportErrorMessage(result.error, t));
      } else if (format === 'pdf' && isSafari()) {
        showExportToast(t('export_toast_safari_pdf_ready'), {
          autoDismissMs: 5000,
        });
      }
    } catch (err) {
      console.error('[GPT-Voyager] Export error:', err);
      alert('Export error occurred.');
    } finally {
      hideProgress();
    }
  });

  // Observe new lazy-loaded messages while selection mode is active.
  const root = getConversationRoot(getUserSelectors());
  let refreshTimer: number | null = null;
  cleanupTasks.push(() => {
    if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    refreshTimer = null;
  });
  const scheduleRefresh = () => {
    if (refreshTimer) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      try {
        syncMessages(collectChatPairs());
        updateBottomBar(bar);
      } catch {}
    }, 250);
  };

  const obs = new MutationObserver(() => scheduleRefresh());
  try {
    obs.observe(root, { childList: true, subtree: true });
    cleanupTasks.push(() => obs.disconnect());
  } catch {}

  // Escape to cancel
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      finish();
      document.removeEventListener('keydown', onKeyDown);
    }
  };
  document.addEventListener('keydown', onKeyDown);
  cleanupTasks.push(() => document.removeEventListener('keydown', onKeyDown));

  // Initial sync
  syncMessages(pairs);
  updateBottomBar(bar);
}

function showExportProgressOverlay(t: (key: TranslationKey) => string): () => void {
  const overlay = document.createElement('div');
  overlay.className = 'gv-export-progress-overlay';

  const card = document.createElement('div');
  card.className = 'gv-export-progress-card';

  const spinner = document.createElement('div');
  spinner.className = 'gv-export-progress-spinner';

  const title = document.createElement('div');
  title.className = 'gv-export-progress-title';
  title.textContent = `${t('pm_export')}...`;

  const desc = document.createElement('div');
  desc.className = 'gv-export-progress-desc';
  desc.textContent = t('loading');

  card.appendChild(spinner);
  card.appendChild(title);
  card.appendChild(desc);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  const unbindAlignment = alignElementToConversationTitleCenter(overlay);

  return () => {
    unbindAlignment();
    try {
      overlay.remove();
    } catch {}
  };
}

/**
 * Check if there is a pending export operation from a previous page load.
 */
async function checkPendingExport() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY_PENDING_EXPORT);
    if (!raw) return;

    const parsed = JSON.parse(raw) as Partial<PendingExportState>;
    if (
      !isExportFormat(parsed.format) ||
      typeof parsed.attempt !== 'number' ||
      typeof parsed.url !== 'string' ||
      parsed.status !== 'clicking' ||
      typeof parsed.timestamp !== 'number'
    ) {
      sessionStorage.removeItem(SESSION_KEY_PENDING_EXPORT);
      return;
    }
    const state: PendingExportState = {
      format: parsed.format,
      fontSize: typeof parsed.fontSize === 'number' ? parsed.fontSize : undefined,
      imageWidth: typeof parsed.imageWidth === 'number' ? parsed.imageWidth : undefined,
      initialSelectedMessageId:
        typeof parsed.initialSelectedMessageId === 'string'
          ? parsed.initialSelectedMessageId
          : undefined,
      attempt: parsed.attempt,
      url: parsed.url,
      status: parsed.status,
      timestamp: parsed.timestamp,
    };

    // Validate context
    if (state.url !== location.href) {
      // User navigated away? Abort.
      sessionStorage.removeItem(SESSION_KEY_PENDING_EXPORT);
      return;
    }

    // If state exists, it means we clicked and page refreshed.
    // So we resume the sequence.
    console.log('[GPT-Voyager] Resuming pending export sequence...');

    // We need i18n for final export/alert
    const dict = await loadDictionaries();
    const lang = await getLanguage();

    await executeExportSequenceWithProgress(
      state.format,
      dict,
      lang,
      state,
      state.fontSize,
      state.initialSelectedMessageId,
      state.imageWidth,
    );
  } catch (e) {
    console.error('[GPT-Voyager] Failed to resume pending export:', e);
    sessionStorage.removeItem(SESSION_KEY_PENDING_EXPORT);
  }
}

function getConversationMenuPanelsFromNode(node: HTMLElement): HTMLElement[] {
  const panels: HTMLElement[] = [];
  if (node.matches(CONVERSATION_MENU_SELECTOR)) {
    panels.push(node);
  }
  panels.push(...Array.from(node.querySelectorAll<HTMLElement>(CONVERSATION_MENU_SELECTOR)));
  return panels;
}

function parseMenuTriggerPanelIds(trigger: HTMLElement): string[] {
  const raw = `${trigger.getAttribute('aria-controls') || ''} ${
    trigger.getAttribute('aria-owns') || ''
  }`;
  return raw
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

type ResponseCopyImageTexts = {
  label: string;
  copied: string;
  downloaded: string;
  failed: string;
  unsupported: string;
  targetMissing: string;
};

function getResponseCopyImageTexts(lang: AppLanguage): ResponseCopyImageTexts {
  if (lang === 'zh') {
    return {
      label: '\u590d\u5236\u56de\u590d\u4e3a\u56fe\u7247',
      copied: '\u56de\u590d\u56fe\u7247\u5df2\u590d\u5236',
      downloaded:
        '\u5df2\u4e0b\u8f7d\u56de\u590d\u56fe\u7247\uff08Safari \u526a\u8d34\u677f\u9650\u5236\uff09',
      failed: '\u590d\u5236\u56de\u590d\u56fe\u7247\u5931\u8d25',
      unsupported:
        '\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u590d\u5236\u56fe\u7247\u5230\u526a\u8d34\u677f',
      targetMissing: '\u65e0\u6cd5\u5b9a\u4f4d\u56de\u590d\u5185\u5bb9',
    };
  }

  return {
    label: 'Copy response as image',
    copied: 'Response image copied',
    downloaded: 'Downloaded response image (Safari clipboard limitation)',
    failed: 'Failed to copy response image',
    unsupported: 'Clipboard image copy is not supported in this browser',
    targetMissing: 'Unable to locate response content',
  };
}

function buildResponseImageFilename(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `gpt-response-${stamp}.png`;
}

function isUnsupportedClipboardError(error: unknown): boolean {
  if (error instanceof DOMException) {
    const name = error.name.toLowerCase();
    if (name === 'notallowederror' || name === 'notsupportederror' || name === 'securityerror') {
      return true;
    }
  }

  if (!(error instanceof Error)) return false;

  if (/clipboard image copy is not supported/i.test(error.message)) {
    return true;
  }

  const lowerMessage = error.message.toLowerCase();
  return (
    lowerMessage.includes('clipboard') &&
    (lowerMessage.includes('not allowed') ||
      lowerMessage.includes('permission') ||
      lowerMessage.includes('gesture') ||
      lowerMessage.includes('unsupported'))
  );
}

async function handleResponseCopyImageClick(
  trigger: HTMLElement,
  getCurrentLanguage: () => AppLanguage,
): Promise<void> {
  if (trigger.dataset.gvCopyImageBusy === '1') {
    return;
  }
  trigger.dataset.gvCopyImageBusy = '1';

  const texts = getResponseCopyImageTexts(getCurrentLanguage());
  let blobForFallback: Blob | null = null;
  try {
    const turn = buildResponseImageTurnForTrigger(trigger);
    if (!turn) {
      showExportToast(texts.targetMissing);
      return;
    }
    const turnsForExport = [turn];

    const metadata: ConversationMetadata = {
      url: location.href,
      exportedAt: new Date().toISOString(),
      count: turnsForExport.length,
      title: getConversationTitleForExport(),
    };

    const blob = await ImageExportService.renderConversationBlob(turnsForExport, metadata, {
      imageWidth: DEFAULT_IMAGE_EXPORT_WIDTH,
    });
    blobForFallback = blob;
    await copyImageBlobToClipboard(blob);
    showExportToast(texts.copied);
  } catch (error) {
    if (isSafari() && blobForFallback) {
      downloadImageBlob(blobForFallback, buildResponseImageFilename());
      showExportToast(texts.downloaded, { autoDismissMs: 3200 });
      return;
    }
    if (isUnsupportedClipboardError(error)) {
      showExportToast(texts.unsupported, { autoDismissMs: 3200 });
      return;
    }
    console.error('[GPT-Voyager] Failed to copy response image:', error);
    showExportToast(texts.failed, { autoDismissMs: 3200 });
  } finally {
    delete trigger.dataset.gvCopyImageBusy;
  }
}

function applyResponseActionCopyImageButtons(getCurrentLanguage: () => AppLanguage): void {
  const texts = getResponseCopyImageTexts(getCurrentLanguage());
  injectResponseActionCopyImageButtons(document, {
    label: texts.label,
    tooltip: texts.label,
    onClick: (button) => {
      void handleResponseCopyImageClick(button, getCurrentLanguage);
    },
  });
}

function setupResponseActionCopyImageObserver({
  getCurrentLanguage,
}: {
  getCurrentLanguage: () => AppLanguage;
}): void {
  applyResponseActionCopyImageButtons(getCurrentLanguage);
  responseActionAddedNodeHandler = (node) => {
    const texts = getResponseCopyImageTexts(getCurrentLanguage());
    injectResponseActionCopyImageButtons(node, {
      label: texts.label,
      tooltip: texts.label,
      onClick: (button) => {
        void handleResponseCopyImageClick(button, getCurrentLanguage);
      },
    });
  };
}

function setupConversationMenuExportObserver({
  dict,
  getCurrentLanguage,
  onExport,
}: {
  dict: Record<AppLanguage, Record<string, string>>;
  getCurrentLanguage: () => AppLanguage;
  onExport: (context: {
    menuType: 'top' | 'sidebar' | 'message';
    trigger: HTMLElement | null;
  }) => void;
}): void {
  if (conversationMenuObserver) return;

  const tryInjectOnPanel = (
    menuPanel: HTMLElement,
    retriesLeft: number = MENU_INJECTION_RETRY_LIMIT,
  ) => {
    if (!menuPanel.isConnected) return;
    if (recentExportMenuTrigger?.isConnected) {
      bindChatGptMenuTrigger(menuPanel, recentExportMenuTrigger);
    }
    const currentLang = getCurrentLanguage();
    const label =
      dict[currentLang]?.['exportChatJson'] ??
      dict.en?.['exportChatJson'] ??
      'Export conversation history';
    const tooltip =
      dict[currentLang]?.['exportChatJson'] ??
      dict.en?.['exportChatJson'] ??
      'Export conversation history';

    const menuContext = getConversationMenuContext(menuPanel);
    if (menuContext) {
      const injected = injectConversationMenuExportButton(menuPanel, {
        label,
        tooltip,
        onClick: () => onExport(menuContext),
      });
      if (!injected && retriesLeft > 0) {
        scheduleExportInjection(
          () => tryInjectOnPanel(menuPanel, retriesLeft - 1),
          MENU_INJECTION_RETRY_DELAY_MS,
        );
      }
      return;
    }

    const responseMenuContext = getResponseMenuContext(menuPanel);
    if (responseMenuContext) {
      const injected = injectResponseMenuExportButton(menuPanel, {
        label,
        tooltip,
        onClick: () =>
          onExport({
            menuType: 'message',
            trigger: responseMenuContext.trigger,
          }),
      });
      if (!injected && retriesLeft > 0) {
        scheduleExportInjection(
          () => tryInjectOnPanel(menuPanel, retriesLeft - 1),
          MENU_INJECTION_RETRY_DELAY_MS,
        );
      }
      return;
    }

    if (retriesLeft > 0) {
      scheduleExportInjection(
        () => tryInjectOnPanel(menuPanel, retriesLeft - 1),
        MENU_INJECTION_RETRY_DELAY_MS,
      );
    }
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        responseActionAddedNodeHandler?.(node);
        const panelSet = new Set<HTMLElement>();
        const panels = getConversationMenuPanelsFromNode(node);
        panels.forEach((panel) => panelSet.add(panel));
        const closestPanel = node.closest(CONVERSATION_MENU_SELECTOR) as HTMLElement | null;
        if (closestPanel) panelSet.add(closestPanel);
        panelSet.forEach((panel) => {
          scheduleExportInjection(() => tryInjectOnPanel(panel), 30);
        });
      });
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  conversationMenuObserver = observer;

  const existingPanels = document.querySelectorAll<HTMLElement>(CONVERSATION_MENU_SELECTOR);
  existingPanels.forEach((panel) => scheduleExportInjection(() => tryInjectOnPanel(panel), 30));

  const onMenuTriggerInteraction = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const trigger = target.closest(
      `[data-testid="conversation-options-button"], [data-testid^="history-item-"][data-testid$="-options"], [data-conversation-options-trigger], [data-test-id="${CONVERSATION_MENU_TRIGGER_TEST_ID}"], [data-test-id="${RESPONSE_MENU_TRIGGER_TEST_ID}"]`,
    ) as HTMLElement | null;
    if (!trigger) return;
    recentExportMenuTrigger = trigger;

    const panelIds = parseMenuTriggerPanelIds(trigger);
    if (panelIds.length === 0) return;

    for (let attempt = 0; attempt <= MENU_INJECTION_RETRY_LIMIT; attempt++) {
      scheduleExportInjection(() => {
        panelIds.forEach((id) => {
          const panel = document.getElementById(id);
          if (!(panel instanceof HTMLElement)) return;
          if (!panel.matches(CONVERSATION_MENU_SELECTOR)) return;
          tryInjectOnPanel(panel);
        });
      }, attempt * MENU_INJECTION_RETRY_DELAY_MS);
    }
  };

  document.addEventListener('click', onMenuTriggerInteraction, true);
  document.addEventListener('pointerdown', onMenuTriggerInteraction, true);
  exportMenuTriggerInteractionHandler = onMenuTriggerInteraction;
}

export async function startExportButton(): Promise<void> {
  if (exportStarted) return;
  exportStarted = true;
  const generation = ++exportGeneration;
  const startupAbortController = new AbortController();
  exportStartupAbortController = startupAbortController;

  const hydrationResult = await waitForExportStartupTask(
    Promise.all(getStarredStorageKeys().map((key) => hydrateTimelinePrivateItem(key))),
    startupAbortController.signal,
  );
  if (hydrationResult.status === 'cancelled' || !exportStarted || generation !== exportGeneration) {
    return;
  }

  // Check for pending export immediately
  checkPendingExport();

  // i18n setup for tooltip and label
  const dict = await loadDictionaries();
  let lang = await getLanguage();
  if (!exportStarted || generation !== exportGeneration) return;

  setupConversationMenuExportObserver({
    dict,
    getCurrentLanguage: () => lang,
    onExport: (context) => {
      if (context.menuType === 'sidebar' && context.trigger) {
        void exportFromSidebarConversationTrigger(context.trigger, dict, () => lang);
        return;
      }
      if (context.menuType === 'message') {
        const initialSelectedMessageId = resolveAssistantMessageIdFromMenuTrigger(context.trigger);
        void showExportDialog(dict, lang, { initialSelectedMessageId });
        return;
      }
      void showExportDialog(dict, lang);
    },
  });
  setupResponseActionCopyImageObserver({
    getCurrentLanguage: () => lang,
  });

  exportStorageChangeHandler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (!exportStarted || area !== 'sync') return;
    const nextRaw = changes[StorageKeys.LANGUAGE]?.newValue;
    if (typeof nextRaw !== 'string') return;
    lang = normalizeLang(nextRaw);
    const legacyButton = document.querySelector<HTMLElement>('.gv-export-dropdown-btn');
    if (legacyButton) {
      const title =
        dict[lang]?.['exportChatJson'] ?? dict.en?.['exportChatJson'] ?? 'Export chat history';
      legacyButton.title = title;
      legacyButton.setAttribute('aria-label', title);
      const label = legacyButton.querySelector<HTMLElement>('.gv-export-dropdown-label');
      if (label)
        label.textContent = dict[lang]?.['pm_export'] ?? dict.en?.['pm_export'] ?? 'Export';
    }
    applyResponseActionCopyImageButtons(() => lang);
  };
  try {
    chrome.storage?.onChanged?.addListener(exportStorageChangeHandler);
  } catch {}

  removeExportPageExitListener = addPageExitListener(stopExportButton);
}

async function showExportDialog(
  dict: Record<AppLanguage, Record<string, string>>,
  lang: AppLanguage,
  options?: {
    initialSelectedMessageId?: string | null;
  },
): Promise<void> {
  const t = (key: TranslationKey) => dict[lang]?.[key] ?? dict.en?.[key] ?? key;
  const initialImageWidth = await getSavedImageExportWidth();

  // We defer collection until after the export sequence (scrolling/refresh checks)

  const dialog = new ExportDialog();

  dialog.show({
    onExport: async (format, fontSize, imageWidth) => {
      try {
        if (format === 'image') {
          await saveImageExportWidth(imageWidth);
        }
        await executeExportSequenceWithProgress(
          format,
          dict,
          lang,
          undefined,
          fontSize,
          options?.initialSelectedMessageId || undefined,
          imageWidth,
        );
      } catch (err) {
        console.error('[GPT-Voyager] Export error:', err);
      }
    },

    onCancel: () => {
      // Dialog closed
    },
    initialImageWidth,
    translations: {
      title: t('export_dialog_title'),
      selectFormat: t('export_dialog_select'),
      warning: t('export_dialog_warning'),
      safariCmdpHint: t('export_dialog_safari_cmdp_hint'),
      safariMarkdownHint: t('export_dialog_safari_markdown_hint'),
      cancel: t('pm_cancel'),
      export: t('pm_export'),
      fontSizeLabel: t('export_fontsize_label'),
      fontSizePreview: t('export_fontsize_preview'),
      imageWidthLabel: t('export_image_width_label'),
      imageWidthNarrow: t('export_image_width_narrow'),
      imageWidthMedium: t('export_image_width_medium'),
      imageWidthWide: t('export_image_width_wide'),
      formatDescriptions: {
        json: t('export_format_json_description'),
        markdown: t('export_format_markdown_description'),
        pdf: t('export_format_pdf_description'),
        image: t('export_format_image_description'),
      },
    },
  });
}

export function stopExportButton(): void {
  exportStarted = false;
  exportGeneration += 1;
  exportStartupAbortController?.abort();
  exportStartupAbortController = null;

  conversationMenuObserver?.disconnect();
  conversationMenuObserver = null;
  responseActionAddedNodeHandler = null;

  if (exportMenuTriggerInteractionHandler) {
    document.removeEventListener('click', exportMenuTriggerInteractionHandler, true);
    document.removeEventListener('pointerdown', exportMenuTriggerInteractionHandler, true);
  }
  exportMenuTriggerInteractionHandler = null;
  recentExportMenuTrigger = null;

  if (exportStorageChangeHandler) {
    try {
      chrome.storage?.onChanged?.removeListener(exportStorageChangeHandler);
    } catch {}
  }
  exportStorageChangeHandler = null;

  if (removeExportPageExitListener) {
    removeExportPageExitListener();
  }
  removeExportPageExitListener = null;

  exportInjectionTimers.forEach((timer) => window.clearTimeout(timer));
  exportInjectionTimers.clear();
  activeExportSelectionCleanup?.();
  activeExportSelectionCleanup = null;

  document
    .querySelectorAll<HTMLElement>(
      '.gv-export-conversation-menu-btn, .gv-export-response-menu-btn, [data-gv-copy-image-button], [data-testid="gv-copy-image-button"], [data-test-id="gv-copy-image-button"], .gv-export-dialog-overlay, .gv-export-progress-overlay',
    )
    .forEach((node) => node.remove());
  document.body.classList.remove('gv-export-select-mode');
}

export default { startExportButton, stopExportButton };
