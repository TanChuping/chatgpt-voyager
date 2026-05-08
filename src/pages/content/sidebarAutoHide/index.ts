import { findChatGptSidebar } from '../chatgptDom';

const STYLE_ID = 'gv-sidebar-auto-hide-style';
const EDGE_TRIGGER_ID = 'gv-sidebar-edge-trigger';
const STORAGE_KEY = 'gvSidebarAutoHide';
const FULL_HIDE_STORAGE_KEY = 'gvSidebarFullHide';
const COLLAPSED_CLASS = 'gv-sidebar-auto-collapsed';

const LEAVE_DELAY_MS = 350;
const EDGE_TRIGGER_WIDTH = 8;

let enabled = false;
let fullHideEnabled = false;
let sidebarElement: HTMLElement | null = null;
let edgeTriggerElement: HTMLElement | null = null;
let observer: MutationObserver | null = null;
let leaveTimeoutId: number | null = null;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #stage-slideover-sidebar,
    [id*='sidebar' i] {
      transition: width 180ms ease, min-width 180ms ease, transform 180ms ease, opacity 180ms ease !important;
    }

    html.${COLLAPSED_CLASS} {
      --sidebar-width: 0px !important;
    }

    html.${COLLAPSED_CLASS} #stage-slideover-sidebar,
    html.${COLLAPSED_CLASS} [id*='sidebar' i] {
      width: 0 !important;
      min-width: 0 !important;
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

function setCollapsed(collapsed: boolean): void {
  document.documentElement.classList.toggle(COLLAPSED_CLASS, collapsed);
}

function cancelLeave(): void {
  if (leaveTimeoutId !== null) {
    window.clearTimeout(leaveTimeoutId);
    leaveTimeoutId = null;
  }
}

function collapseSoon(): void {
  if (!enabled) return;
  cancelLeave();
  leaveTimeoutId = window.setTimeout(() => {
    leaveTimeoutId = null;
    setCollapsed(true);
  }, LEAVE_DELAY_MS);
}

function expand(): void {
  cancelLeave();
  setCollapsed(false);
}

function createEdgeTrigger(): void {
  if (edgeTriggerElement) return;
  const edge = document.createElement('div');
  edge.id = EDGE_TRIGGER_ID;
  edge.style.cssText = `
    position: fixed;
    left: 0;
    top: 0;
    width: ${EDGE_TRIGGER_WIDTH}px;
    height: 100vh;
    z-index: 99999;
    background: transparent;
  `;
  edge.addEventListener('mouseenter', expand);
  document.documentElement.appendChild(edge);
  edgeTriggerElement = edge;
}

function removeEdgeTrigger(): void {
  edgeTriggerElement?.removeEventListener('mouseenter', expand);
  edgeTriggerElement?.remove();
  edgeTriggerElement = null;
}

function attachSidebar(): void {
  const next = findChatGptSidebar();
  if (!next || next === sidebarElement) return;

  sidebarElement?.removeEventListener('mouseenter', expand);
  sidebarElement?.removeEventListener('mouseleave', collapseSoon);

  sidebarElement = next;
  sidebarElement.addEventListener('mouseenter', expand);
  sidebarElement.addEventListener('mouseleave', collapseSoon);
}

function detachSidebar(): void {
  sidebarElement?.removeEventListener('mouseenter', expand);
  sidebarElement?.removeEventListener('mouseleave', collapseSoon);
  sidebarElement = null;
}

function ensureObserver(): void {
  if (observer) return;
  observer = new MutationObserver(() => {
    if (enabled || fullHideEnabled) attachSidebar();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function cleanupObserverIfIdle(): void {
  if (enabled || fullHideEnabled || !observer) return;
  observer.disconnect();
  observer = null;
}

function enable(): void {
  if (enabled) return;
  enabled = true;
  ensureStyle();
  createEdgeTrigger();
  attachSidebar();
  ensureObserver();
}

function disable(): void {
  if (!enabled) return;
  enabled = false;
  cancelLeave();
  setCollapsed(false);
  detachSidebar();
  if (!fullHideEnabled) {
    removeEdgeTrigger();
    removeStyle();
  }
  cleanupObserverIfIdle();
}

function enableFullHide(): void {
  if (fullHideEnabled) return;
  fullHideEnabled = true;
  ensureStyle();
  createEdgeTrigger();
  attachSidebar();
  ensureObserver();
}

function disableFullHide(): void {
  if (!fullHideEnabled) return;
  fullHideEnabled = false;
  if (!enabled) {
    setCollapsed(false);
    detachSidebar();
    removeEdgeTrigger();
    removeStyle();
  }
  cleanupObserverIfIdle();
}

export function startSidebarAutoHide(): void {
  chrome.storage?.sync?.get({ [STORAGE_KEY]: false, [FULL_HIDE_STORAGE_KEY]: false }, (res) => {
    if (res?.[STORAGE_KEY] === true) enable();
    if (res?.[FULL_HIDE_STORAGE_KEY] === true) enableFullHide();
  });

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'sync') return;

    if (changes[STORAGE_KEY]) {
      if (changes[STORAGE_KEY].newValue === true) enable();
      else disable();
    }

    if (changes[FULL_HIDE_STORAGE_KEY]) {
      if (changes[FULL_HIDE_STORAGE_KEY].newValue === true) enableFullHide();
      else disableFullHide();
    }
  });

  window.addEventListener(
    'beforeunload',
    () => {
      disable();
      disableFullHide();
    },
    { once: true },
  );
}
