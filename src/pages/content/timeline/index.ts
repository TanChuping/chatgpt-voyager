import { StorageKeys } from '@/core/types/common';
import { extractConversationIdFromUrl } from '@/core/utils/conversationIdentity';
import { addPageExitListener } from '@/core/utils/pageLifecycle';

import { findActiveConversationRoot } from '../chatgptDom';
import { TimelineManager } from './manager';

/** One manager per route AND active page. Retained hidden pages are not threads. */
let started = false;
let enabled = true;
let generation = 0;
let manager: TimelineManager | null = null;
let binding: { id: string; root: HTMLElement; url: string; previousUrl: string | null } | null =
  null;
let initializing = false;
let lastUrl = '';
let queued = false;
let observer: MutationObserver | null = null;
let routeInterval: number | null = null;
let removeExit: (() => void) | null = null;
let settingsListener:
  | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
  | null = null;
let settingChangedDuringLoad = false;

function teardown(): void {
  const previous = manager;
  manager = null;
  initializing = false;
  try {
    previous?.destroy();
  } catch {
    /* extension teardown must not block the next page */
  }
  document
    .querySelectorAll(
      '.gpt-timeline-bar,.timeline-left-slider,.timeline-tooltip,#gpt-timeline-tooltip',
    )
    .forEach((el) => el.remove());
}

function conversationId(): string | null {
  return /(?:^|\/)c\//.test(location.pathname) ? extractConversationIdFromUrl(location.href) : null;
}

function syncContext(refresh = false): void {
  if (!started || !enabled || !document.body) return;
  const url = location.href;
  const previousUrl = lastUrl || null;
  lastUrl = url;
  const id = conversationId();
  const root = findActiveConversationRoot();
  if (!id || !root) {
    if (manager) teardown();
    binding = null;
    return;
  }
  if (!binding || binding.id !== id || binding.root !== root) {
    teardown();
    binding = { id, root, url, previousUrl };
  }
  // The MAIN mirror verifies React's owning conversationId. Never initialize
  // B against A's briefly retained DOM just because the URL already says B.
  if (
    root.closest('[data-app-shell-active-page]') &&
    (root.getAttribute('data-gv-thread-status') !== 'ready' ||
      root.getAttribute('data-gv-thread-conversation') !== id)
  ) {
    if (manager) teardown();
    return;
  }
  if (manager) {
    if (refresh && !initializing) manager.refreshForThreadChange();
    return;
  }
  const instance = new TimelineManager({
    previousUrl: binding.previousUrl,
    conversationUrl: binding.url,
  });
  manager = instance;
  initializing = true;
  void instance
    .init()
    .catch((error) => {
      if (manager === instance) console.error('[Timeline] Initialization failed:', error);
    })
    .finally(() => {
      if (manager !== instance) return;
      initializing = false;
      instance.refreshForThreadChange();
    });
}

function scheduleContext(): void {
  if (queued) return;
  queued = true;
  const current = generation;
  queueMicrotask(() => {
    queued = false;
    if (started && generation === current) syncContext(true);
  });
}

function threadUpdated(event: MessageEvent): void {
  if (event.origin !== location.origin || event.data?.__gvType !== 'gv-thread-updated') return;
  syncContext(event.data.ready === true && event.data.conversationId === conversationId());
}

function attach(): void {
  if (observer || !started || !enabled) return;
  observer = new MutationObserver((records) => {
    if (
      location.href !== lastUrl ||
      (binding && !binding.root.isConnected) ||
      records.some((record) => record.type === 'attributes')
    ) {
      scheduleContext();
      return;
    }
    const relevant =
      'body,main,[data-app-shell-active-page],[data-gv-thread-anchor-layer],[data-turn-key],[data-message-author-role="user"],[data-testid^="conversation-turn"]';
    for (const record of records)
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (
          !(node instanceof Element) ||
          node.closest('.gpt-timeline-bar,.timeline-left-slider,.timeline-tooltip')
        )
          continue;
        if (node.matches(relevant) || node.querySelector(relevant)) {
          scheduleContext();
          return;
        }
      }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-app-shell-active-page'],
  });
  window.addEventListener('message', threadUpdated);
  window.addEventListener('popstate', scheduleContext);
  window.addEventListener('gv-location-change', scheduleContext);
  // URL-only fallback for old layouts. No self-heal restart loop or isolated
  // history patch, which cannot observe MAIN-world navigation.
  routeInterval = window.setInterval(() => {
    if (location.href !== lastUrl) scheduleContext();
  }, 800);
  syncContext();
}

function detach(): void {
  observer?.disconnect();
  observer = null;
  if (routeInterval !== null) window.clearInterval(routeInterval);
  routeInterval = null;
  window.removeEventListener('message', threadUpdated);
  window.removeEventListener('popstate', scheduleContext);
  window.removeEventListener('gv-location-change', scheduleContext);
  teardown();
  binding = null;
}

function applyEnabled(value: boolean): void {
  enabled = value;
  if (enabled) attach();
  else detach();
}

export function stopTimeline(): void {
  started = false;
  generation++;
  queued = false;
  detach();
  if (settingsListener) chrome.storage?.onChanged?.removeListener(settingsListener);
  settingsListener = null;
  removeExit?.();
  removeExit = null;
}

export function startTimeline(): () => void {
  if (started) return stopTimeline;
  started = true;
  const current = ++generation;
  lastUrl = location.href;
  settingChangedDuringLoad = false;
  settingsListener = (changes, area) => {
    if (
      !started ||
      current !== generation ||
      area !== 'sync' ||
      !changes[StorageKeys.TIMELINE_ENABLED]
    )
      return;
    settingChangedDuringLoad = true;
    applyEnabled(changes[StorageKeys.TIMELINE_ENABLED].newValue !== false);
  };
  chrome.storage?.onChanged?.addListener(settingsListener);
  void (async () => {
    let initial = true;
    try {
      initial =
        (await chrome.storage.sync.get({ [StorageKeys.TIMELINE_ENABLED]: true }))?.[
          StorageKeys.TIMELINE_ENABLED
        ] !== false;
    } catch {
      /* default on */
    }
    if (!started || generation !== current) return;
    if (!settingChangedDuringLoad) enabled = initial;
    if (enabled) attach();
  })();
  removeExit = addPageExitListener(stopTimeline);
  return stopTimeline;
}
