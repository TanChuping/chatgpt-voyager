import { StorageKeys } from '@/core/types/common';

import { TimelineManager } from './manager';

function isChatGPTConversationRoute(pathname = location.pathname): boolean {
  return /(?:^|\/)c(\/|$)/.test(pathname);
}

/**
 * Master on/off for the whole timeline feature (popup setting
 * `gptTimelineEnabled`, default true). The TimelineManager only exists while
 * enabled, so this gate lives at the lifecycle level rather than inside the
 * manager. Toggled live via storage.onChanged below.
 */
let timelineEnabled = true;

type HistoryStateArgs = Parameters<History['pushState']>;

let timelineManagerInstance: TimelineManager | null = null;
// True while a TimelineManager.init() is in flight, so the self-heal watchdog
// (ensureTimelineHealthy) doesn't double-initialize during a legitimate boot.
let initInProgress = false;
// Self-heal attempt budget. Reset per conversation route and whenever a healthy
// bar exists, so a permanently-broken route (deleted/errored thread whose DOM
// never yields the timeline's anchor) can't spin re-init forever.
const MAX_HEAL_ATTEMPTS = 8;
let healAttemptKey = '';
let healAttempts = 0;
let currentUrl = location.href;
let currentPathAndSearch = location.pathname + location.search;
let routeCheckIntervalId: number | null = null;
let routeListenersAttached = false;
let activeObservers: MutationObserver[] = [];
let cleanupHandlers: (() => void)[] = [];
let historyPatched = false;
let originalPushState: History['pushState'] | null = null;
let originalReplaceState: History['replaceState'] | null = null;
let timelineStarted = false;
let timelineGeneration = 0;
let timelineStorageChangeHandler:
  | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
  | null = null;
let timelineBeforeUnloadHandler: (() => void) | null = null;
let timelineSuspendHandler: (() => void) | null = null;

function isActiveTimelineGeneration(generation: number): boolean {
  return timelineStarted && generation === timelineGeneration;
}

function removeTimelineDom(): void {
  // Remove ALL matches, not just the first: an init()-after-destroy race (fast
  // conversation switching) can briefly leave orphaned bars/sliders/tooltips,
  // and the tooltip id stops being unique once duplicated. Sweep them all.
  try {
    document.querySelectorAll('.gpt-timeline-bar').forEach((el) => el.remove());
  } catch {}
  try {
    document.querySelectorAll('.timeline-left-slider').forEach((el) => el.remove());
  } catch {}
  try {
    document
      .querySelectorAll('.timeline-tooltip, #gpt-timeline-tooltip')
      .forEach((el) => el.remove());
  } catch {}
}

function teardownTimelineInstance(): void {
  if (timelineManagerInstance) {
    try {
      timelineManagerInstance.destroy();
    } catch {}
    timelineManagerInstance = null;
  }
  removeTimelineDom();
  // The `gv-timeline-active` body marker (which gates hiding ChatGPT's native
  // prompt-TOC) is owned by the TimelineManager — added when it injects the bar,
  // removed in its destroy() — so it tracks the bar's real presence and survives
  // the async-init/teardown races at this lifecycle layer.
}

function initializeTimeline(previousUrl: string | null = null): void {
  if (!timelineStarted) return;
  teardownTimelineInstance();
  if (!timelineEnabled) return; // master switch off — stay torn down
  const instance = new TimelineManager({ previousUrl });
  timelineManagerInstance = instance;
  initInProgress = true;
  instance
    .init()
    .catch((err) => console.error('Timeline initialization failed:', err))
    .finally(() => {
      // Only clear the flag if this instance is still the current one — a newer
      // initializeTimeline()/teardown may have superseded us mid-init.
      if (timelineManagerInstance === instance) initInProgress = false;
    });
}

let urlChangeTimer: number | null = null;

function handleUrlChange(): void {
  if (!timelineStarted) return;
  if (location.href === currentUrl) return;

  const previousUrl = currentUrl;
  const newPathAndSearch = location.pathname + location.search;
  const pathChanged = newPathAndSearch !== currentPathAndSearch;

  // Update current URL
  currentUrl = location.href;

  // Only reinitialize if pathname or search changed, not just hash
  if (!pathChanged) {
    console.log('[Timeline] Only hash changed, keeping existing timeline');
    return;
  }

  currentPathAndSearch = newPathAndSearch;

  // Clear any pending initialization
  if (urlChangeTimer) {
    clearTimeout(urlChangeTimer);
    urlChangeTimer = null;
  }

  if (isChatGPTConversationRoute()) {
    // Add delay to allow DOM to update after SPA navigation
    console.log('[Timeline] URL changed to conversation route, scheduling initialization');
    urlChangeTimer = window.setTimeout(() => {
      urlChangeTimer = null;
      if (!timelineStarted) return;
      console.log('[Timeline] Initializing timeline after URL change');
      initializeTimeline(previousUrl);
    }, 500); // Wait for DOM to settle
  } else {
    console.log('[Timeline] URL changed to non-conversation route, cleaning up');
    teardownTimelineInstance();
  }
}

function patchHistoryOnce(): void {
  if (historyPatched) return;
  try {
    originalPushState = history.pushState;
    originalReplaceState = history.replaceState;

    history.pushState = (...args: HistoryStateArgs): void => {
      originalPushState?.apply(history, args);
      handleUrlChange();
    };
    history.replaceState = (...args: HistoryStateArgs): void => {
      originalReplaceState?.apply(history, args);
      handleUrlChange();
    };

    historyPatched = true;
    cleanupHandlers.push(() => {
      if (!historyPatched) return;
      if (originalPushState) history.pushState = originalPushState;
      if (originalReplaceState) history.replaceState = originalReplaceState;
      historyPatched = false;
      originalPushState = null;
      originalReplaceState = null;
    });
  } catch (e) {
    console.warn('[Timeline] Failed to patch history API:', e);
  }
}

function attachRouteListenersOnce(): void {
  if (!timelineStarted || routeListenersAttached) return;
  routeListenersAttached = true;
  patchHistoryOnce();
  window.addEventListener('popstate', handleUrlChange);
  window.addEventListener('hashchange', handleUrlChange);
  routeCheckIntervalId = window.setInterval(() => {
    if (location.href !== currentUrl) {
      handleUrlChange();
      return;
    }
    // No URL change pending and no scheduled (re)init — make sure the timeline
    // actually exists on this conversation route, recovering from slow ChatGPT
    // hydration or a spurious mid-boot teardown.
    if (urlChangeTimer) return;
    ensureTimelineHealthy();
  }, 800);

  // Register cleanup handlers for proper resource management
  cleanupHandlers.push(() => {
    window.removeEventListener('popstate', handleUrlChange);
    window.removeEventListener('hashchange', handleUrlChange);
  });
}

/**
 * Cleanup function to prevent memory leaks
 * Disconnects all observers, clears intervals, and removes event listeners
 */
function cleanup(): void {
  // Cancel any pending delayed initialization
  if (urlChangeTimer) {
    clearTimeout(urlChangeTimer);
    urlChangeTimer = null;
  }

  // Disconnect all active MutationObservers
  activeObservers.forEach((observer) => {
    try {
      observer.disconnect();
    } catch (e) {
      console.error('[GPT-Voyager] Failed to disconnect observer during cleanup:', e);
    }
  });
  activeObservers = [];

  // Clear the route check interval
  if (routeCheckIntervalId !== null) {
    clearInterval(routeCheckIntervalId);
    routeCheckIntervalId = null;
  }

  // Execute all registered cleanup handlers
  cleanupHandlers.forEach((handler) => {
    try {
      handler();
    } catch (e) {
      console.error('[GPT-Voyager] Failed to run cleanup handler:', e);
    }
  });
  cleanupHandlers = [];

  // Reset flag
  routeListenersAttached = false;
}

/** Init the timeline for the current page if the master switch allows it. */
function maybeInitTimeline(): void {
  if (!timelineStarted || !timelineEnabled) return;
  if (isChatGPTConversationRoute() && !timelineManagerInstance) {
    initializeTimeline();
  }
}

function timelineBarPresent(): boolean {
  try {
    return !!document.querySelector('.gpt-timeline-bar');
  } catch {
    return false;
  }
}

const LIVE_USER_TURN_SELECTOR = [
  '[data-gv-user-turn="true"]',
  '[data-testid^="conversation-turn"][data-turn="user"]',
  '[data-message-author-role="user"]',
  'article[data-author="user"]',
].join(',');

function timelineHasExpectedMarkers(): boolean {
  try {
    if (document.querySelector('.timeline-dot')) return true;
    // An empty bar is valid only while the new conversation has no user turn.
    // Once a live user turn exists, zero dots means the manager is bound to a
    // stale hydration tree and must be allowed to self-heal.
    return !document.querySelector(LIVE_USER_TURN_SELECTOR);
  } catch {
    return true;
  }
}

/**
 * Self-heal watchdog, run from the route-check interval.
 *
 * ChatGPT can hydrate a heavy conversation slowly — the message turns sometimes
 * only mount many seconds after our content script boots — and can transiently
 * rewrite the URL during that hydration. Either can leave the timeline torn
 * down or bailed-out (init ran before any turns existed, then a spurious
 * re-init hit a half-replaced DOM, `findCriticalElements` failed, and the dead
 * instance never retried). Users saw this as "the timeline flashed once then
 * vanished; toggling the switch in settings brings it back".
 *
 * The fix: if we're on a conversation route, enabled, and not mid-init, yet
 * there's no timeline bar in the DOM, (re)initialize. Idempotent and
 * self-limiting — once init finally succeeds (turns are present) the bar stays
 * and this is a no-op.
 */
function ensureTimelineHealthy(): void {
  if (!timelineStarted || !timelineEnabled) return;
  if (initInProgress) return;
  // Only ever (re)inject on a real conversation route — never on the new-chat
  // landing (`/`), search, or any non-`/c/` page.
  if (!isChatGPTConversationRoute()) return;
  if (timelineManagerInstance && timelineBarPresent() && timelineHasExpectedMarkers()) {
    healAttempts = 0; // healthy — restore the full budget for any later teardown
    return;
  }
  const key = location.pathname + location.search;
  if (key !== healAttemptKey) {
    healAttemptKey = key;
    healAttempts = 0;
  }
  if (healAttempts >= MAX_HEAL_ATTEMPTS) return; // gave up — avoid infinite churn
  healAttempts += 1;
  initializeTimeline();
}

/** React to the popup's enable/disable toggle without a page reload. */
function applyTimelineEnabled(enabled: boolean): void {
  if (enabled === timelineEnabled) return;
  timelineEnabled = enabled;
  if (enabled) {
    currentUrl = location.href;
    currentPathAndSearch = location.pathname + location.search;
    setupTimelineWhenBodyReady(timelineGeneration);
  } else {
    cleanup();
    teardownTimelineInstance();
    initInProgress = false;
  }
}

function setupTimelineWhenBodyReady(generation: number): void {
  if (!isActiveTimelineGeneration(generation) || !timelineEnabled) return;
  if (document.body) {
    attachRouteListenersOnce();
    maybeInitTimeline();
    return;
  }

  const bodyObserver = new MutationObserver(() => {
    if (!isActiveTimelineGeneration(generation) || !timelineEnabled) {
      bodyObserver.disconnect();
      activeObservers = activeObservers.filter((obs) => obs !== bodyObserver);
      return;
    }
    if (!document.body) return;
    bodyObserver.disconnect();
    activeObservers = activeObservers.filter((obs) => obs !== bodyObserver);
    attachRouteListenersOnce();
    maybeInitTimeline();
  });
  activeObservers.push(bodyObserver);
  bodyObserver.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
  });
}

function watchTimelineEnabledSetting(generation: number): void {
  if (!isActiveTimelineGeneration(generation) || timelineStorageChangeHandler) return;
  try {
    timelineStorageChangeHandler = (changes, area) => {
      if (!isActiveTimelineGeneration(generation) || area !== 'sync') return;
      const change = changes[StorageKeys.TIMELINE_ENABLED];
      if (change) applyTimelineEnabled(change.newValue !== false);
    };
    chrome.storage.onChanged.addListener(timelineStorageChangeHandler);
  } catch {
    timelineStorageChangeHandler = null;
    /* storage unavailable — keep default-enabled behaviour */
  }
}

async function loadTimelineEnabled(): Promise<boolean> {
  try {
    const result = await chrome.storage.sync.get({ [StorageKeys.TIMELINE_ENABLED]: true });
    return result?.[StorageKeys.TIMELINE_ENABLED] !== false;
  } catch {
    return true;
  }
}

export function stopTimeline(): void {
  timelineStarted = false;
  timelineGeneration += 1;

  if (timelineStorageChangeHandler) {
    try {
      chrome.storage?.onChanged?.removeListener(timelineStorageChangeHandler);
    } catch {}
    timelineStorageChangeHandler = null;
  }

  if (timelineBeforeUnloadHandler) {
    window.removeEventListener('beforeunload', timelineBeforeUnloadHandler);
    timelineBeforeUnloadHandler = null;
  }
  if (timelineSuspendHandler) {
    try {
      chrome.runtime?.onSuspend?.removeListener?.(timelineSuspendHandler);
    } catch {}
    timelineSuspendHandler = null;
  }

  cleanup();
  teardownTimelineInstance();
  initInProgress = false;
}

export function startTimeline(): () => void {
  if (timelineStarted) return stopTimeline;
  timelineStarted = true;
  const generation = ++timelineGeneration;
  currentUrl = location.href;
  currentPathAndSearch = location.pathname + location.search;

  // Resolve the enable setting first so a disabled timeline never mounts even
  // momentarily. While disabled, only the storage bridge stays installed;
  // re-enabling attaches route infrastructure against the current URL.
  void loadTimelineEnabled().then((enabled) => {
    if (!isActiveTimelineGeneration(generation)) return;
    timelineEnabled = enabled;
    watchTimelineEnabledSetting(generation);
    if (timelineEnabled) setupTimelineWhenBodyReady(generation);
  });

  // Setup cleanup on page unload
  timelineBeforeUnloadHandler = () => stopTimeline();
  window.addEventListener('beforeunload', timelineBeforeUnloadHandler, { once: true });

  // Also cleanup on extension unload (if content script is removed)
  if (typeof chrome !== 'undefined' && chrome.runtime) {
    timelineSuspendHandler = () => stopTimeline();
    chrome.runtime.onSuspend?.addListener?.(timelineSuspendHandler);
  }

  return stopTimeline;
}
