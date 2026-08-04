import browser from 'webextension-polyfill';

import { sanitizeFolderConversationUrl } from '@/features/folder/utils/conversationUrlSecurity';

const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
const USER_SELECTOR = '[data-message-author-role="user"]';
const COPY_ACTION_SELECTOR = 'button[data-testid="copy-turn-action-button"]';
const TURN_SELECTOR = '[data-testid^="conversation-turn-"], article';
const COMPOSER_SELECTOR = '#prompt-textarea, textarea, [contenteditable="true"][role="textbox"]';
const SEND_BUTTON_SELECTOR = 'button[data-testid="send-button"]';
const STOP_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label*="停止回答"]',
  'button[aria-label*="Stop"]',
] as const;

const PAGE_OBSERVER_SOURCE = 'gpt-voyager-chatgpt-response-observer';
const PAGE_OBSERVER_CONTROL_SOURCE = 'gpt-voyager-chatgpt-response-observer-control';
const PAGE_OBSERVER_SCRIPT_ID = 'gv-chatgpt-response-observer-script';
const PAGE_OBSERVER_SCRIPT = 'chatgpt-response-complete-observer.js';
const SCAN_DELAY_MS = 180;
const STABLE_DELAY_MS = 900;
const NETWORK_MIN_DURATION_MS = 250;
const PENDING_SUBMIT_MAX_AGE_MS = 15_000;
const DOM_OBSERVER_WAIT_MS = 8_000;
const MAX_HISTORY = 24;
const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);

interface GenerationSnapshot {
  token: string;
  conversationTitle: string;
  conversationUrl: string;
  notified: boolean;
  startedAt: number;
  userPrompt: string;
}

interface CompletionCandidate {
  completionId: string;
  responseFingerprint: string;
  snapshot: GenerationSnapshot;
}

interface PageObserverPayload {
  duration?: number;
  ok?: boolean;
  pageTitle?: string;
  pageUrl?: string;
  requestId?: string;
}

let enabled = false;
let domObserver: MutationObserver | null = null;
let pageObserverScript: HTMLScriptElement | null = null;
let scanTimer: number | null = null;
let stableTimer: number | null = null;
let domObserverWaitTimer: number | null = null;
let sawGeneration = false;
let stableCompletionId = '';
let nextGenerationSequence = 1;
let pendingSubmitSnapshot: GenerationSnapshot | null = null;
let activeGenerationSnapshot: GenerationSnapshot | null = null;
const networkRequests = new Map<string, GenerationSnapshot>();
const completionHistory = new Set<string>();

function isVisible(element: Element): boolean {
  if (!element.isConnected || element.getClientRects().length === 0) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

function isGenerating(): boolean {
  return STOP_SELECTORS.some((selector) =>
    Array.from(document.querySelectorAll(selector)).some(isVisible),
  );
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

function trimText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function normalizeChatGptPageUrl(value: string): string | null {
  try {
    const url = new URL(value, location.href);
    if (url.protocol !== 'https:' || !CHATGPT_HOSTS.has(url.hostname.toLowerCase())) return null;
    const conversation = sanitizeFolderConversationUrl(url.toString(), url.origin);
    if (conversation) return conversation.url;
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

function getConversationTitle(title = document.title): string {
  return trimText(title.replace(/^🟢\s*/, '').replace(/\s*[|·-]\s*ChatGPT\s*$/i, ''), 80);
}

function getLatestUserPrompt(): string {
  const userMessages = document.querySelectorAll<HTMLElement>(USER_SELECTOR);
  return trimText(userMessages[userMessages.length - 1]?.innerText || '', 180);
}

function getComposerPrompt(): string {
  const composer = document.querySelector<HTMLElement>(COMPOSER_SELECTOR);
  if (!composer) return '';
  const value = composer instanceof HTMLTextAreaElement ? composer.value : composer.innerText;
  return trimText(value || '', 180);
}

function createSnapshot(pageUrl = location.href, pageTitle = document.title): GenerationSnapshot {
  return {
    token: `${Date.now().toString(36)}-${nextGenerationSequence++}`,
    conversationTitle: getConversationTitle(pageTitle),
    conversationUrl:
      normalizeChatGptPageUrl(pageUrl) || normalizeChatGptPageUrl(location.href) || '',
    notified: false,
    startedAt: Date.now(),
    userPrompt: getComposerPrompt() || getLatestUserPrompt(),
  };
}

function capturePendingSubmit(): void {
  pendingSubmitSnapshot = createSnapshot();
  armDomObserver(true);
}

function getSnapshotForRequest(pageUrl?: string, pageTitle?: string): GenerationSnapshot {
  const now = Date.now();
  let snapshot = activeGenerationSnapshot;
  if (!snapshot || snapshot.notified) {
    snapshot =
      pendingSubmitSnapshot && now - pendingSubmitSnapshot.startedAt <= PENDING_SUBMIT_MAX_AGE_MS
        ? pendingSubmitSnapshot
        : createSnapshot(pageUrl, pageTitle);
  }
  pendingSubmitSnapshot = null;

  const originalUrl = pageUrl ? normalizeChatGptPageUrl(pageUrl) : null;
  if (originalUrl) snapshot.conversationUrl = originalUrl;
  if (!snapshot.conversationTitle && pageTitle) {
    snapshot.conversationTitle = getConversationTitle(pageTitle);
  }
  if (!snapshot.userPrompt) snapshot.userPrompt = getLatestUserPrompt();
  activeGenerationSnapshot = snapshot;
  return snapshot;
}

function maybeAdoptCreatedConversation(snapshot: GenerationSnapshot): void {
  if (sanitizeFolderConversationUrl(snapshot.conversationUrl, location.origin)) return;
  const createdConversation = sanitizeFolderConversationUrl(location.href, location.origin);
  if (!createdConversation) return;
  snapshot.conversationUrl = createdConversation.url;
  snapshot.conversationTitle = getConversationTitle() || snapshot.conversationTitle;
  snapshot.userPrompt ||= getLatestUserPrompt();
}

function isSnapshotOnCurrentConversation(snapshot: GenerationSnapshot): boolean {
  const expected = sanitizeFolderConversationUrl(snapshot.conversationUrl, location.origin);
  const current = sanitizeFolderConversationUrl(location.href, location.origin);
  if (!expected) return true;
  return !!current && expected.url === current.url;
}

function rememberCompletion(token: string): void {
  completionHistory.add(token);
  if (completionHistory.size <= MAX_HISTORY) return;
  const oldest = completionHistory.values().next().value as string | undefined;
  if (oldest) completionHistory.delete(oldest);
}

function clearStableTimer(): void {
  if (stableTimer !== null) window.clearTimeout(stableTimer);
  stableTimer = null;
}

function resetCandidate(): void {
  clearStableTimer();
  stableCompletionId = '';
}

function clearDomObserverWaitTimer(): void {
  if (domObserverWaitTimer !== null) window.clearTimeout(domObserverWaitTimer);
  domObserverWaitTimer = null;
}

function disarmDomObserver(): void {
  domObserver?.disconnect();
  domObserver = null;
  clearDomObserverWaitTimer();
  if (scanTimer !== null) window.clearTimeout(scanTimer);
  scanTimer = null;
  resetCandidate();
}

function armDomObserver(waitForGeneration: boolean): void {
  if (!enabled || !document.documentElement) return;
  if (!domObserver) {
    domObserver = new MutationObserver(scheduleScan);
    domObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  clearDomObserverWaitTimer();
  if (waitForGeneration) {
    domObserverWaitTimer = window.setTimeout(() => {
      domObserverWaitTimer = null;
      if (!sawGeneration && networkRequests.size === 0) {
        activeGenerationSnapshot = null;
        disarmDomObserver();
      }
    }, DOM_OBSERVER_WAIT_MS);
  }
  scheduleScan();
}

async function sendNotification(snapshot: GenerationSnapshot): Promise<void> {
  try {
    await browser.runtime.sendMessage({
      type: 'gv.responseComplete.notify',
      payload: {
        completionId: snapshot.token,
        conversationTitle: snapshot.conversationTitle,
        conversationUrl: snapshot.conversationUrl,
        userPrompt: snapshot.userPrompt,
      },
    });
  } catch (error) {
    console.warn('[GPT-Voyager] Reply-complete notification failed:', error);
  }
}

function completeSnapshot(snapshot: GenerationSnapshot): void {
  if (snapshot.notified || completionHistory.has(snapshot.token)) return;
  maybeAdoptCreatedConversation(snapshot);
  if (!snapshot.conversationUrl) return;

  snapshot.notified = true;
  rememberCompletion(snapshot.token);
  if (activeGenerationSnapshot?.token === snapshot.token) {
    activeGenerationSnapshot = null;
    sawGeneration = false;
    disarmDomObserver();
  }
  void sendNotification(snapshot);
}

function readCompletionCandidate(): CompletionCandidate | null {
  const snapshot = activeGenerationSnapshot;
  if (snapshot && !isSnapshotOnCurrentConversation(snapshot)) return null;

  const assistantMessages = document.querySelectorAll<HTMLElement>(ASSISTANT_SELECTOR);
  const latestAssistant = assistantMessages[assistantMessages.length - 1];
  const responseText = latestAssistant?.innerText.trim() || '';
  if (!latestAssistant || !responseText) return null;

  const turn = latestAssistant.closest<HTMLElement>(TURN_SELECTOR);
  if (!turn?.querySelector(COPY_ACTION_SELECTOR)) return null;

  const candidateSnapshot = snapshot || createSnapshot();
  const responseFingerprint = hashText(responseText);
  return {
    completionId: `${candidateSnapshot.token}|${responseFingerprint}`,
    responseFingerprint,
    snapshot: candidateSnapshot,
  };
}

function confirmStableCompletion(): void {
  stableTimer = null;
  if (!enabled || !domObserver || isGenerating()) {
    scheduleScan();
    return;
  }

  const candidate = readCompletionCandidate();
  if (!candidate || candidate.completionId !== stableCompletionId) {
    resetCandidate();
    scheduleScan();
    return;
  }

  completeSnapshot(candidate.snapshot);
}

function scan(): void {
  scanTimer = null;
  if (!enabled || !domObserver) return;
  if (activeGenerationSnapshot) maybeAdoptCreatedConversation(activeGenerationSnapshot);

  if (isGenerating()) {
    clearDomObserverWaitTimer();
    if (!sawGeneration) {
      activeGenerationSnapshot = getSnapshotForRequest();
      sawGeneration = true;
    }
    resetCandidate();
    return;
  }

  if (!sawGeneration) return;
  const candidate = readCompletionCandidate();
  if (!candidate) {
    resetCandidate();
    return;
  }

  if (candidate.snapshot.notified || completionHistory.has(candidate.snapshot.token)) {
    sawGeneration = false;
    resetCandidate();
    return;
  }

  if (candidate.completionId === stableCompletionId && stableTimer !== null) return;
  resetCandidate();
  stableCompletionId = candidate.completionId;
  stableTimer = window.setTimeout(confirmStableCompletion, STABLE_DELAY_MS);
}

function scheduleScan(): void {
  if (!enabled || !domObserver || scanTimer !== null) return;
  scanTimer = window.setTimeout(scan, SCAN_DELAY_MS);
}

function handleSubmitSignal(event: Event): void {
  const target = event.target instanceof Element ? event.target : null;
  if (event.type === 'click') {
    if (target?.closest(SEND_BUTTON_SELECTOR)) capturePendingSubmit();
    return;
  }

  if (event.type === 'submit') {
    const form = target instanceof HTMLFormElement ? target : target?.closest('form');
    if (form?.querySelector(COMPOSER_SELECTOR)) capturePendingSubmit();
    return;
  }

  if (!(event instanceof KeyboardEvent) || event.key !== 'Enter' || event.shiftKey) return;
  if (event.isComposing || !target?.closest(COMPOSER_SELECTOR)) return;
  capturePendingSubmit();
}

function handlePageObserverMessage(event: MessageEvent): void {
  if (!enabled || event.source !== window) return;
  const data = event.data as {
    source?: string;
    type?: string;
    payload?: PageObserverPayload;
  } | null;
  if (!data || data.source !== PAGE_OBSERVER_SOURCE) return;

  const requestId = data.payload?.requestId;
  if (!requestId) return;
  if (data.type === 'request-start') {
    const snapshot = getSnapshotForRequest(data.payload?.pageUrl, data.payload?.pageTitle);
    networkRequests.set(requestId, snapshot);
    sawGeneration = true;
    armDomObserver(false);
    return;
  }

  const snapshot = networkRequests.get(requestId);
  if (!snapshot) return;
  networkRequests.delete(requestId);

  if (data.type === 'request-complete') {
    const duration = data.payload?.duration ?? 0;
    if (data.payload?.ok === true && duration >= NETWORK_MIN_DURATION_MS) {
      completeSnapshot(snapshot);
      return;
    }
  }

  if (data.type === 'request-untracked') return;

  const stillPending = Array.from(networkRequests.values()).some(
    (candidate) => candidate.token === snapshot.token,
  );
  if (!stillPending && activeGenerationSnapshot?.token === snapshot.token) {
    activeGenerationSnapshot = null;
    sawGeneration = false;
    disarmDomObserver();
  }
}

function postPageObserverControl(type: 'uninstall'): void {
  window.postMessage({ source: PAGE_OBSERVER_CONTROL_SOURCE, type }, location.origin);
}

function injectPageObserver(): void {
  if (document.getElementById(PAGE_OBSERVER_SCRIPT_ID) || pageObserverScript) return;
  const script = document.createElement('script');
  pageObserverScript = script;
  script.id = PAGE_OBSERVER_SCRIPT_ID;
  script.src = browser.runtime.getURL(PAGE_OBSERVER_SCRIPT);
  script.async = false;
  script.addEventListener(
    'load',
    () => {
      script.remove();
      pageObserverScript = null;
      if (!enabled) postPageObserverControl('uninstall');
    },
    { once: true },
  );
  script.addEventListener(
    'error',
    () => {
      script.remove();
      pageObserverScript = null;
    },
    { once: true },
  );
  (document.documentElement || document.head || document.body).appendChild(script);
}

export function startResponseNotification(): void {
  if (enabled || !document.documentElement) return;
  enabled = true;
  window.addEventListener('message', handlePageObserverMessage);
  document.addEventListener('click', handleSubmitSignal, true);
  document.addEventListener('submit', handleSubmitSignal, true);
  document.addEventListener('keydown', handleSubmitSignal, true);
  injectPageObserver();
  if (isGenerating()) {
    activeGenerationSnapshot = getSnapshotForRequest();
    sawGeneration = true;
    armDomObserver(false);
  }
}

export function stopResponseNotification(): void {
  if (!enabled) return;
  enabled = false;
  disarmDomObserver();
  window.removeEventListener('message', handlePageObserverMessage);
  document.removeEventListener('click', handleSubmitSignal, true);
  document.removeEventListener('submit', handleSubmitSignal, true);
  document.removeEventListener('keydown', handleSubmitSignal, true);
  postPageObserverControl('uninstall');
  pageObserverScript?.remove();
  pageObserverScript = null;
  sawGeneration = false;
  pendingSubmitSnapshot = null;
  activeGenerationSnapshot = null;
  networkRequests.clear();
  completionHistory.clear();
}
