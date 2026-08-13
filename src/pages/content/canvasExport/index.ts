import { StorageKeys } from '@/core/types/common';
import { addPageExitListener } from '@/core/utils/pageLifecycle';
import { getCurrentLanguage, getTranslation } from '@/utils/i18n';
import { normalizeLanguage } from '@/utils/language';
import type { TranslationKey } from '@/utils/translations';

import { showExportToast } from '../../../features/export/ui/ExportToast';
import { CHATGPT_MENU_SELECTOR } from '../chatgptDom';
import {
  CANVAS_MARKDOWN_BUTTON_CLASS,
  findCanvasProseMirrorRoot,
  injectCanvasCopyMarkdownButton,
  injectCanvasToolbarButton,
  isCanvasShareMenuCandidate,
  isCanvasShareMenuPanel,
} from './menuInjection';

const MENU_PANEL_SELECTOR = `${CHATGPT_MENU_SELECTOR}, .mat-mdc-menu-panel[role="menu"]`;
const MENU_INJECTION_RETRY_LIMIT = 8;
const MENU_INJECTION_RETRY_DELAY_MS = 80;

let canvasStarted = false;
let canvasGeneration = 0;
let canvasMenuObserver: MutationObserver | null = null;
let canvasStorageHandler:
  | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
  | null = null;
let removeCanvasPageExitListener: (() => void) | null = null;
let currentLabels = { label: 'Copy as Markdown', tooltip: 'Copy Canvas content as Markdown' };
let toolbarScanTimer: number | null = null;
const pendingTimers = new Set<number>();
const pendingMenuTimers = new Map<HTMLElement, number>();

function schedule(callback: () => void, delay: number): number | null {
  if (!canvasStarted) return null;
  const generation = canvasGeneration;
  const timer = window.setTimeout(() => {
    pendingTimers.delete(timer);
    if (!canvasStarted || generation !== canvasGeneration) return;
    callback();
  }, delay);
  pendingTimers.add(timer);
  return timer;
}

async function showCanvasToast(key: TranslationKey, fallback: string): Promise<void> {
  let message = fallback;
  try {
    message = await getTranslation(key);
  } catch {}
  showExportToast(message);
}

export async function copyMarkdownFromCanvas(): Promise<void> {
  try {
    const root = findCanvasProseMirrorRoot();
    if (!root) {
      await showCanvasToast('canvasExportEmpty', 'Canvas is empty');
      return;
    }

    // Keep conversion out of first-load. Import, conversion and clipboard are
    // one failure domain so every failure produces the same visible toast.
    const { convertCanvasDomToMarkdown } = await import('./markdownConverter');
    const markdown = convertCanvasDomToMarkdown(root).trim();
    if (!markdown) {
      await showCanvasToast('canvasExportEmpty', 'Canvas is empty');
      return;
    }

    await navigator.clipboard.writeText(markdown);
    await showCanvasToast('canvasExportCopied', 'Canvas copied as Markdown');
  } catch (error) {
    console.error('[GPT-Voyager] Canvas markdown copy failed:', error);
    await showCanvasToast('canvasExportFailed', 'Failed to copy Canvas as Markdown');
  }
}

function getMenuPanelsFromNode(node: HTMLElement): HTMLElement[] {
  const panels: HTMLElement[] = [];
  if (node.matches(MENU_PANEL_SELECTOR)) panels.push(node);
  panels.push(...Array.from(node.querySelectorAll<HTMLElement>(MENU_PANEL_SELECTOR)));
  return panels;
}

function removeInjectedButtonsFrom(root: ParentNode): void {
  root
    .querySelectorAll<HTMLElement>(`.${CANVAS_MARKDOWN_BUTTON_CLASS}`)
    .forEach((button) => button.remove());
}

function schedulePanelInjection(
  menuPanel: HTMLElement,
  retriesLeft = MENU_INJECTION_RETRY_LIMIT,
  delay = 30,
): void {
  if (!canvasStarted || pendingMenuTimers.has(menuPanel)) return;
  const timer = schedule(() => {
    pendingMenuTimers.delete(menuPanel);
    tryInjectOnPanel(menuPanel, retriesLeft);
  }, delay);
  if (timer !== null) pendingMenuTimers.set(menuPanel, timer);
}

function tryInjectOnPanel(menuPanel: HTMLElement, retriesLeft = MENU_INJECTION_RETRY_LIMIT): void {
  if (!canvasStarted || !menuPanel.isConnected) return;
  if (!isCanvasShareMenuPanel(menuPanel)) {
    removeInjectedButtonsFrom(menuPanel);
    if (retriesLeft > 0 && isCanvasShareMenuCandidate(menuPanel))
      schedulePanelInjection(menuPanel, retriesLeft - 1, MENU_INJECTION_RETRY_DELAY_MS);
    return;
  }

  const injected = injectCanvasCopyMarkdownButton(menuPanel, {
    label: currentLabels.label,
    tooltip: currentLabels.tooltip,
    onClick: () => void copyMarkdownFromCanvas(),
  });
  if (!injected && retriesLeft > 0) {
    schedulePanelInjection(menuPanel, retriesLeft - 1, MENU_INJECTION_RETRY_DELAY_MS);
  }
}

function tryInjectToolbar(): void {
  if (!canvasStarted) return;
  injectCanvasToolbarButton({
    label: currentLabels.label,
    tooltip: currentLabels.tooltip,
    onClick: () => void copyMarkdownFromCanvas(),
  });
}

function scheduleToolbarScan(): void {
  if (toolbarScanTimer !== null) {
    window.clearTimeout(toolbarScanTimer);
    pendingTimers.delete(toolbarScanTimer);
  }
  toolbarScanTimer = schedule(() => {
    toolbarScanTimer = null;
    tryInjectToolbar();
  }, 60);
}

function updateExistingButton(label: string, tooltip: string): void {
  document.querySelectorAll<HTMLElement>(`.${CANVAS_MARKDOWN_BUTTON_CLASS}`).forEach((button) => {
    button.title = tooltip;
    button.setAttribute('aria-label', tooltip);
    const text = button.querySelector<HTMLElement>(
      '[data-gv-canvas-label], .mat-mdc-menu-item-text',
    );
    if (text) text.textContent = label;
  });
}

async function refreshLabels(generation = canvasGeneration): Promise<void> {
  if (!canvasStarted || generation !== canvasGeneration) return;
  const [label, tooltip] = await Promise.all([
    getTranslation('canvasExportCopyMarkdown'),
    getTranslation('canvasExportCopyMarkdownTooltip'),
  ]);
  if (!canvasStarted || generation !== canvasGeneration) return;
  currentLabels = { label, tooltip };
  updateExistingButton(label, tooltip);
}

function isCanvasCandidateNode(node: HTMLElement): boolean {
  const signalSelector =
    '[data-testid*="canvas" i], [aria-label*="canvas" i], [data-testid*="artifact" i], [aria-label*="artifact" i], immersive-editor';
  if (node.matches(signalSelector) || node.querySelector(signalSelector)) return true;
  if (
    !node.matches(
      '.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]',
    ) &&
    !node.querySelector(
      '.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]',
    )
  ) {
    return false;
  }
  const localOwner = node.closest<HTMLElement>('aside, [role="dialog"], section');
  return Boolean(localOwner?.querySelector(signalSelector));
}

export async function startCanvasExport(): Promise<void> {
  if (!['chatgpt.com', 'chat.openai.com'].includes(location.hostname)) return;
  if (canvasStarted) return;
  canvasStarted = true;
  const generation = ++canvasGeneration;

  try {
    await refreshLabels(generation);
  } catch {}
  if (!canvasStarted || generation !== canvasGeneration) return;

  void getCurrentLanguage()
    .then(() => refreshLabels(generation))
    .catch(() => {});

  canvasMenuObserver = new MutationObserver((mutations) => {
    if (!canvasStarted || generation !== canvasGeneration) return;
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        const panels = new Set(getMenuPanelsFromNode(node));
        const closest = node.closest<HTMLElement>(MENU_PANEL_SELECTOR);
        if (closest) panels.add(closest);
        panels.forEach((panel) => schedulePanelInjection(panel));
        if (isCanvasCandidateNode(node)) scheduleToolbarScan();
      });
    }
  });
  canvasMenuObserver.observe(document.body, { childList: true, subtree: true });

  document
    .querySelectorAll<HTMLElement>(MENU_PANEL_SELECTOR)
    .forEach((panel) => schedulePanelInjection(panel));
  tryInjectToolbar();

  canvasStorageHandler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (!canvasStarted || generation !== canvasGeneration || (area !== 'sync' && area !== 'local'))
      return;
    const next = changes[StorageKeys.LANGUAGE]?.newValue;
    if (typeof next !== 'string') return;
    normalizeLanguage(next);
    void refreshLabels(generation).catch(() => {});
  };
  try {
    chrome.storage?.onChanged?.addListener(canvasStorageHandler);
  } catch {}

  removeCanvasPageExitListener = addPageExitListener(stopCanvasExport);
}

export function stopCanvasExport(): void {
  canvasStarted = false;
  canvasGeneration += 1;
  canvasMenuObserver?.disconnect();
  canvasMenuObserver = null;

  if (toolbarScanTimer !== null) window.clearTimeout(toolbarScanTimer);
  toolbarScanTimer = null;
  pendingTimers.forEach((timer) => window.clearTimeout(timer));
  pendingTimers.clear();
  pendingMenuTimers.clear();

  if (canvasStorageHandler) {
    try {
      chrome.storage?.onChanged?.removeListener(canvasStorageHandler);
    } catch {}
  }
  canvasStorageHandler = null;
  if (removeCanvasPageExitListener) {
    removeCanvasPageExitListener();
  }
  removeCanvasPageExitListener = null;

  removeInjectedButtonsFrom(document);
}
