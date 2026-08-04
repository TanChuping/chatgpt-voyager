import { findChatGptSidebar } from '../chatgptDom';

const STYLE_ID = 'gv-sidebar-auto-hide-style';
const EDGE_TRIGGER_ID = 'gv-sidebar-edge-trigger';
const AUTO_HIDE_KEY = 'gvSidebarAutoHide';
const FULL_HIDE_KEY = 'gvSidebarFullHide';
const FULL_HIDE_CLASS = 'gv-sidebar-full-hide-collapsed';

const SIDEBAR_SELECTOR = '#stage-slideover-sidebar';
const CLOSE_BUTTON_SELECTOR = `${SIDEBAR_SELECTOR} [data-testid="close-sidebar-button"]`;
const OPEN_BUTTON_SELECTOR = [
  `${SIDEBAR_SELECTOR} button[aria-label*="Open sidebar" i]`,
  `${SIDEBAR_SELECTOR} button[aria-label*="打开边栏"]`,
  `${SIDEBAR_SELECTOR} button[class*="group/open-sidebar"]`,
].join(',');

const COLLAPSED_WIDTH_THRESHOLD = 80;
const INITIAL_COLLAPSE_DELAY_MS = 500;
const ENTER_DELAY_MS = 150;
const LEAVE_DELAY_MS = 400;
const EDGE_TRIGGER_WIDTH = 8;
const EDGE_SAFETY_COLLAPSE_MS = 1200;
const EXPANSION_GRACE_MS = 450;
const STATE_SYNC_DELAYS_MS = [0, 180, 360] as const;
const BLOCKING_POPUP_SELECTORS = [
  '.gv-folder-dialog',
  '.gv-folder-dialog-overlay',
  '.gv-folder-confirm-dialog',
  '.gv-folder-import-dialog',
  '.gv-folder-menu',
  '.gv-color-picker-dialog',
];

let enabled = false;
let fullHideEnabled = false;
let autoCollapsed = false;
let sidebarElement: HTMLElement | null = null;
let edgeTriggerElement: HTMLElement | null = null;
let observer: MutationObserver | null = null;
let enterTimer: number | null = null;
let leaveTimer: number | null = null;
let initialTimer: number | null = null;
let safetyTimer: number | null = null;
let expansionTimer: number | null = null;
let syncTimers: number[] = [];
let internalToggleClickDepth = 0;
let expansionInProgress = false;
let started = false;
let lifecycleGeneration = 0;
let storageChangeHandler:
  | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
  | null = null;
let beforeUnloadHandler: (() => void) | null = null;

function isActiveGeneration(generation: number): boolean {
  return started && generation === lifecycleGeneration;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    ${SIDEBAR_SELECTOR} {
      transition: width 180ms ease, min-width 180ms ease, opacity 180ms ease !important;
    }

    html.${FULL_HIDE_CLASS} ${SIDEBAR_SELECTOR} {
      width: 0 !important;
      min-width: 0 !important;
      border-width: 0 !important;
      overflow: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }
  `;
  document.documentElement.appendChild(style);
}

function removeStyle(): void {
  document.getElementById(STYLE_ID)?.remove();
}

function getSidebar(): HTMLElement | null {
  return document.querySelector<HTMLElement>(SIDEBAR_SELECTOR) || findChatGptSidebar();
}

function isSidebarCollapsed(): boolean {
  const sidebar = getSidebar();
  if (!sidebar) return false;
  return sidebar.getBoundingClientRect().width <= COLLAPSED_WIDTH_THRESHOLD;
}

function setFullHideCollapsed(collapsed: boolean): void {
  document.documentElement.classList.toggle(FULL_HIDE_CLASS, collapsed);
}

function syncVisualState(): void {
  // ChatGPT updates the native sidebar width asynchronously after its open
  // button is clicked. Keep full-hide released during that transition so a
  // stale 0/52px measurement cannot immediately hide the sidebar again.
  if (expansionInProgress) {
    setFullHideCollapsed(false);
    if (edgeTriggerElement) edgeTriggerElement.style.display = 'none';
    return;
  }

  const fullyHidden = enabled && fullHideEnabled && isSidebarCollapsed();
  setFullHideCollapsed(fullyHidden);
  if (edgeTriggerElement) {
    edgeTriggerElement.style.display = fullyHidden ? 'block' : 'none';
  }
}

function clearTimer(timer: number | null): null {
  if (timer !== null) window.clearTimeout(timer);
  return null;
}

function clearScheduledStateSync(): void {
  syncTimers.forEach((timer) => window.clearTimeout(timer));
  syncTimers = [];
}

function scheduleStateSync(): void {
  clearScheduledStateSync();
  syncTimers = STATE_SYNC_DELAYS_MS.map((delay) =>
    window.setTimeout(() => {
      attachSidebar();
      syncVisualState();
    }, delay),
  );
}

function findToggleButton(expand: boolean): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    expand ? OPEN_BUTTON_SELECTOR : CLOSE_BUTTON_SELECTOR,
  );
}

function cancelExpansionGrace(): void {
  expansionTimer = clearTimer(expansionTimer);
  expansionInProgress = false;
}

function beginExpansionGrace(): void {
  cancelExpansionGrace();
  expansionInProgress = true;
  setFullHideCollapsed(false);
  if (edgeTriggerElement) edgeTriggerElement.style.display = 'none';
  expansionTimer = window.setTimeout(() => {
    expansionTimer = null;
    expansionInProgress = false;
    scheduleStateSync();
  }, EXPANSION_GRACE_MS);
}

function clickSidebarToggle(expand: boolean): boolean {
  const button = findToggleButton(expand);
  if (!button) return false;

  if (expand) beginExpansionGrace();
  else cancelExpansionGrace();
  internalToggleClickDepth += 1;
  try {
    button.click();
  } finally {
    internalToggleClickDepth -= 1;
  }
  scheduleStateSync();
  syncVisualState();
  return true;
}

function restoreAutoCollapsedSidebar(): void {
  const button = findToggleButton(true);
  if (!button) return;

  internalToggleClickDepth += 1;
  try {
    button.click();
  } finally {
    internalToggleClickDepth -= 1;
  }
}

function hasBlockingPopup(): boolean {
  return BLOCKING_POPUP_SELECTORS.some((selector) => {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      (rect.width > 0 || rect.height > 0)
    );
  });
}

function cancelInteractionTimers(): void {
  enterTimer = clearTimer(enterTimer);
  leaveTimer = clearTimer(leaveTimer);
  safetyTimer = clearTimer(safetyTimer);
  cancelExpansionGrace();
}

function collapseNow(): void {
  leaveTimer = null;
  if (!enabled || isSidebarCollapsed() || hasBlockingPopup()) {
    syncVisualState();
    return;
  }

  if (clickSidebarToggle(false)) {
    autoCollapsed = true;
    syncVisualState();
  }
}

function expandNow(fromEdge: boolean): void {
  enterTimer = null;
  if (!enabled || !isSidebarCollapsed()) {
    syncVisualState();
    return;
  }

  if (clickSidebarToggle(true)) {
    autoCollapsed = false;
    syncVisualState();
    if (fromEdge) {
      safetyTimer = clearTimer(safetyTimer);
      safetyTimer = window.setTimeout(collapseNow, EDGE_SAFETY_COLLAPSE_MS);
    }
  }
}

function scheduleExpand(fromEdge = false): void {
  leaveTimer = clearTimer(leaveTimer);
  enterTimer = clearTimer(enterTimer);
  enterTimer = window.setTimeout(() => expandNow(fromEdge), ENTER_DELAY_MS);
}

function scheduleCollapse(): void {
  enterTimer = clearTimer(enterTimer);
  leaveTimer = clearTimer(leaveTimer);
  leaveTimer = window.setTimeout(collapseNow, LEAVE_DELAY_MS);
}

function handleSidebarEnter(): void {
  leaveTimer = clearTimer(leaveTimer);
  safetyTimer = clearTimer(safetyTimer);
  if (isSidebarCollapsed()) scheduleExpand(false);
}

function handleSidebarLeave(): void {
  scheduleCollapse();
}

function attachSidebar(): void {
  const next = getSidebar();
  if (!next || next === sidebarElement) return;

  sidebarElement?.removeEventListener('mouseenter', handleSidebarEnter);
  sidebarElement?.removeEventListener('mouseleave', handleSidebarLeave);
  sidebarElement = next;
  sidebarElement.addEventListener('mouseenter', handleSidebarEnter);
  sidebarElement.addEventListener('mouseleave', handleSidebarLeave);
}

function detachSidebar(): void {
  sidebarElement?.removeEventListener('mouseenter', handleSidebarEnter);
  sidebarElement?.removeEventListener('mouseleave', handleSidebarLeave);
  sidebarElement = null;
}

function createEdgeTrigger(): void {
  if (edgeTriggerElement) return;
  const edge = document.createElement('div');
  edge.id = EDGE_TRIGGER_ID;
  edge.style.cssText = `
    position: fixed;
    inset: 0 auto 0 0;
    width: ${EDGE_TRIGGER_WIDTH}px;
    z-index: 99999;
    display: none;
    background: transparent;
  `;
  edge.addEventListener('mouseenter', () => scheduleExpand(true));
  document.documentElement.appendChild(edge);
  edgeTriggerElement = edge;
}

function removeEdgeTrigger(): void {
  edgeTriggerElement?.remove();
  edgeTriggerElement = null;
}

function handleDocumentClick(event: Event): void {
  if (!enabled || internalToggleClickDepth > 0) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest(`${OPEN_BUTTON_SELECTOR},${CLOSE_BUTTON_SELECTOR}`)) return;
  autoCollapsed = false;
  scheduleStateSync();
}

function ensureObserver(): void {
  if (observer) return;
  observer = new MutationObserver(() => {
    attachSidebar();
    scheduleStateSync();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });
}

function enable(): void {
  if (enabled) return;
  enabled = true;
  ensureStyle();
  createEdgeTrigger();
  attachSidebar();
  ensureObserver();
  document.addEventListener('click', handleDocumentClick, true);
  initialTimer = clearTimer(initialTimer);
  initialTimer = window.setTimeout(collapseNow, INITIAL_COLLAPSE_DELAY_MS);
  syncVisualState();
}

function disable(restoreSidebar = true): void {
  if (!enabled) return;
  enabled = false;
  initialTimer = clearTimer(initialTimer);
  cancelInteractionTimers();
  clearScheduledStateSync();
  setFullHideCollapsed(false);

  if (restoreSidebar && autoCollapsed && isSidebarCollapsed()) restoreAutoCollapsedSidebar();
  autoCollapsed = false;

  document.removeEventListener('click', handleDocumentClick, true);
  observer?.disconnect();
  observer = null;
  detachSidebar();
  removeEdgeTrigger();
  removeStyle();
}

function enableFullHide(): void {
  fullHideEnabled = true;
  if (enabled) {
    ensureStyle();
    createEdgeTrigger();
    syncVisualState();
  }
}

function disableFullHide(): void {
  fullHideEnabled = false;
  cancelExpansionGrace();
  setFullHideCollapsed(false);
  if (edgeTriggerElement) edgeTriggerElement.style.display = 'none';
}

export function stopSidebarAutoHide(restoreSidebar = true): void {
  started = false;
  lifecycleGeneration += 1;
  disable(restoreSidebar);
  disableFullHide();

  if (storageChangeHandler) {
    try {
      chrome.storage?.onChanged?.removeListener(storageChangeHandler);
    } catch {
      /* Extension context may already be gone. */
    }
    storageChangeHandler = null;
  }
  if (beforeUnloadHandler) {
    window.removeEventListener('beforeunload', beforeUnloadHandler);
    beforeUnloadHandler = null;
  }
}

export function startSidebarAutoHide(): () => void {
  if (started) return stopSidebarAutoHide;
  started = true;
  const generation = ++lifecycleGeneration;
  let autoHideChanged = false;
  let fullHideChanged = false;

  storageChangeHandler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (!isActiveGeneration(generation) || area !== 'sync') return;

    if (changes[FULL_HIDE_KEY]) {
      fullHideChanged = true;
      if (changes[FULL_HIDE_KEY].newValue === true) enableFullHide();
      else disableFullHide();
    }

    if (changes[AUTO_HIDE_KEY]) {
      autoHideChanged = true;
      if (changes[AUTO_HIDE_KEY].newValue === true) enable();
      else disable();
    }
  };

  try {
    chrome.storage?.onChanged?.addListener(storageChangeHandler);
  } catch {
    storageChangeHandler = null;
  }

  beforeUnloadHandler = () => stopSidebarAutoHide(false);
  window.addEventListener('beforeunload', beforeUnloadHandler, { once: true });

  chrome.storage?.sync?.get({ [AUTO_HIDE_KEY]: false, [FULL_HIDE_KEY]: false }, (result) => {
    if (!isActiveGeneration(generation)) return;
    if (!fullHideChanged) {
      if (result?.[FULL_HIDE_KEY] === true) enableFullHide();
      else disableFullHide();
    }
    if (!autoHideChanged) {
      if (result?.[AUTO_HIDE_KEY] === true) enable();
      else disable();
    }
  });

  return stopSidebarAutoHide;
}
