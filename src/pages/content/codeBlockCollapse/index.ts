import { StorageKeys } from '@/core/types/common';
import { getTranslationSync } from '@/utils/i18n';

export const LONG_CODE_BLOCK_MIN_LINES = 24;
export const LONG_CODE_BLOCK_MIN_HEIGHT = 520;

const VIEWER_SELECTOR = '#code-block-viewer';
const TOGGLE_CLASS = 'gv-code-block-toggle';
const COLLAPSIBLE_CLASS = 'gv-code-block-collapsible';
const COLLAPSED_CLASS = 'gv-code-block-collapsed';
const SCAN_DEBOUNCE_MS = 120;

interface CodeBlockParts {
  host: HTMLElement;
  viewer: HTMLElement;
  code: HTMLElement;
  header: HTMLElement;
  actions: HTMLElement;
}

interface CodeBlockMeasurement extends CodeBlockParts {
  shouldEnhance: boolean;
}

let observer: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let scanTimer: number | null = null;
let languageChangeListener:
  | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
  | null = null;

const pendingViewers = new Set<HTMLElement>();
const observedViewers = new Set<HTMLElement>();
const managedHosts = new Set<HTMLElement>();
const buttonsByHost = new Map<HTMLElement, HTMLButtonElement>();

function countLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r\n?|\n/).length;
}

function findCodeBlockParts(viewer: HTMLElement): CodeBlockParts | null {
  const code = viewer.querySelector<HTMLElement>('pre > code');
  if (!code) return null;

  // ChatGPT currently puts the language/copy toolbar in a sticky direct child
  // of the code-block surface. Walk only the local code-block ancestors instead
  // of depending on generated Tailwind class names or translated button labels.
  let host = viewer.parentElement;
  for (let depth = 0; host && depth < 10; depth += 1, host = host.parentElement) {
    const header = Array.from(host.children).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        child.classList.contains('sticky') &&
        child.querySelector('button') !== null,
    );
    if (!header) continue;

    const nativeButton = header.querySelector<HTMLButtonElement>('button');
    const actions = nativeButton?.parentElement;
    if (!nativeButton || !actions) return null;
    return { host, viewer, code, header, actions };
  }

  return null;
}

export function isLongCodeBlock(viewer: HTMLElement, code: HTMLElement): boolean {
  if (countLines(code.textContent ?? '') >= LONG_CODE_BLOCK_MIN_LINES) return true;

  const pre = code.closest('pre');
  const scroller = code.closest<HTMLElement>('.cm-scroller');
  return (
    Math.max(viewer.scrollHeight, pre?.scrollHeight ?? 0, scroller?.scrollHeight ?? 0) >=
    LONG_CODE_BLOCK_MIN_HEIGHT
  );
}

function isMermaidBlock(parts: CodeBlockParts): boolean {
  if (parts.code.closest('.gv-mermaid-wrapper')) return true;
  if (parts.code.dataset.mermaidCode || parts.code.dataset.mermaidProcessing === 'true')
    return true;
  return parts.header.textContent?.trim().toLowerCase() === 'mermaid';
}

function createToggleIcon(collapsed: boolean): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', collapsed ? 'M8 8l4 4 4-4M8 13l4 4 4-4' : 'M8 16l4-4 4 4M8 11l4-4 4 4');
  svg.appendChild(path);
  return svg;
}

function updateToggle(host: HTMLElement, button: HTMLButtonElement): void {
  const collapsed = host.classList.contains(COLLAPSED_CLASS);
  const label = getTranslationSync(collapsed ? 'codeBlockExpand' : 'codeBlockCollapse');
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-expanded', String(!collapsed));
  button.replaceChildren(createToggleIcon(collapsed));
}

function removeEnhancement(host: HTMLElement): void {
  const button =
    buttonsByHost.get(host) ?? host.querySelector<HTMLButtonElement>(`.${TOGGLE_CLASS}`);
  button?.remove();
  buttonsByHost.delete(host);
  managedHosts.delete(host);
  host.classList.remove(COLLAPSIBLE_CLASS, COLLAPSED_CLASS);
}

function observeViewer(viewer: HTMLElement): void {
  if (!resizeObserver || observedViewers.has(viewer)) return;
  resizeObserver.observe(viewer);
  observedViewers.add(viewer);
}

function measureViewer(viewer: HTMLElement): CodeBlockMeasurement | null {
  observeViewer(viewer);
  const parts = findCodeBlockParts(viewer);
  if (!parts) return null;
  return {
    ...parts,
    shouldEnhance: !isMermaidBlock(parts) && isLongCodeBlock(parts.viewer, parts.code),
  };
}

function applyMeasurement(measurement: CodeBlockMeasurement): void {
  const { host, actions, shouldEnhance } = measurement;
  if (!shouldEnhance) {
    removeEnhancement(host);
    return;
  }

  managedHosts.add(host);
  host.classList.add(COLLAPSIBLE_CLASS);

  let button = buttonsByHost.get(host);
  if (!button || !button.isConnected || button.parentElement !== actions) {
    button?.remove();
    button = document.createElement('button');
    button.type = 'button';
    button.className = TOGGLE_CLASS;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      host.classList.toggle(COLLAPSED_CLASS);
      updateToggle(host, button!);
    });
    actions.appendChild(button);
    buttonsByHost.set(host, button);
  }

  updateToggle(host, button);
}

function cleanupDisconnectedBlocks(): void {
  for (const viewer of [...observedViewers]) {
    if (viewer.isConnected) continue;
    resizeObserver?.unobserve(viewer);
    observedViewers.delete(viewer);
  }
  for (const host of [...managedHosts]) {
    if (!host.isConnected) removeEnhancement(host);
  }
}

export function processLongCodeBlocks(root: ParentNode = document): void {
  if (root instanceof HTMLElement && root.matches(VIEWER_SELECTOR)) {
    const measurement = measureViewer(root);
    if (measurement) applyMeasurement(measurement);
  }
  root.querySelectorAll<HTMLElement>(VIEWER_SELECTOR).forEach((viewer) => {
    const measurement = measureViewer(viewer);
    if (measurement) applyMeasurement(measurement);
  });
  cleanupDisconnectedBlocks();
}

function collectViewers(node: Node): void {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  if (!element) return;

  const containingViewer = element.closest<HTMLElement>(VIEWER_SELECTOR);
  if (containingViewer) pendingViewers.add(containingViewer);
  if (element.matches(VIEWER_SELECTOR)) pendingViewers.add(element);
  element
    .querySelectorAll<HTMLElement>(VIEWER_SELECTOR)
    .forEach((viewer) => pendingViewers.add(viewer));
}

function flushPendingViewers(): void {
  const measurements = [...pendingViewers]
    .filter((viewer) => viewer.isConnected)
    .map(measureViewer)
    .filter((measurement): measurement is CodeBlockMeasurement => measurement !== null);
  pendingViewers.clear();
  measurements.forEach(applyMeasurement);
  cleanupDisconnectedBlocks();
}

function scheduleFlush(): void {
  if (scanTimer !== null) window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => {
    scanTimer = null;
    flushPendingViewers();
  }, SCAN_DEBOUNCE_MS);
}

function handleMutations(records: MutationRecord[]): void {
  records.forEach((record) => {
    collectViewers(record.target);
    record.addedNodes.forEach(collectViewers);
  });
  if (pendingViewers.size > 0) scheduleFlush();
}

export function stopCodeBlockCollapse(): void {
  observer?.disconnect();
  observer = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (scanTimer !== null) window.clearTimeout(scanTimer);
  scanTimer = null;
  pendingViewers.clear();
  observedViewers.clear();
  for (const host of [...managedHosts]) removeEnhancement(host);
  if (languageChangeListener) {
    chrome.storage?.onChanged?.removeListener(languageChangeListener);
    languageChangeListener = null;
  }
}

export function startCodeBlockCollapse(): () => void {
  stopCodeBlockCollapse();

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.target instanceof HTMLElement && entry.target.matches(VIEWER_SELECTOR)) {
          pendingViewers.add(entry.target);
        }
      });
      if (pendingViewers.size > 0) scheduleFlush();
    });
  }

  processLongCodeBlocks();
  observer = new MutationObserver(handleMutations);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  languageChangeListener = (changes, areaName) => {
    if ((areaName !== 'sync' && areaName !== 'local') || !changes[StorageKeys.LANGUAGE]) return;
    queueMicrotask(() => {
      for (const [host, button] of buttonsByHost) updateToggle(host, button);
    });
  };
  chrome.storage?.onChanged?.addListener(languageChangeListener);

  return stopCodeBlockCollapse;
}
