/**
 * Top-right "export this conversation" button.
 *
 * MutationObserver watches for ChatGPT's `[data-testid="share-chat-button"]`
 * (verified live — sits inside a `<div class="flex items-center">` at the
 * top-right of the conversation header). On detect we clone the Share
 * button's className so the export button picks up ChatGPT's native styling,
 * then swap the icon to a download glyph and rewire the click handler.
 *
 * Idempotent: tagged with `data-gv-export-btn` so reinsertions don't
 * double-inject.
 */
import { StorageKeys } from '@/core/types/common';
import {
  DEFAULT_SINGLE_CONV_EXPORT_FORMAT,
  type SingleConvExportFormat,
  exportPreparedConversation,
  isSingleConvExportFormat,
} from '@/features/singleConvExport';
import { getTranslationSync } from '@/utils/i18n';

import { extractChatGptConversationIdFromUrl } from '../chatgptDom';
import { buildClonedButtonClassName } from '../shared/clonedButtonClass';
import { findOptionsButtonRow } from '../shared/headerActionSlot';
import { isChatGptResponseGenerating } from './generationState';
import { prepareWholeConversationExport } from './prepareExport';
import { enterSelectionMode, exitSelectionMode } from './selectionMode';

const TAG = 'data-gv-export-btn';
const INJECT_DEBOUNCE_MS = 50;

let lifecycleGeneration = 0;
let activeGeneration: number | null = null;
let injectedButton: HTMLButtonElement | null = null;

function isActiveGeneration(generation: number): boolean {
  return activeGeneration === generation;
}

function currentConvIdFromUrl(): string | null {
  return extractChatGptConversationIdFromUrl(window.location.href);
}

function buildDownloadIcon(): SVGSVGElement {
  const xmlns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(xmlns, 'svg');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const arrow = document.createElementNS(xmlns, 'path');
  arrow.setAttribute('d', 'M12 3v12');
  svg.appendChild(arrow);
  const tip = document.createElementNS(xmlns, 'path');
  tip.setAttribute('d', 'M6 11l6 6 6-6');
  svg.appendChild(tip);
  const tray = document.createElementNS(xmlns, 'path');
  tray.setAttribute('d', 'M4 21h16');
  svg.appendChild(tray);
  return svg;
}

function buildSelectIcon(): SVGSVGElement {
  // Checklist glyph: two ticked rows, signalling "pick which messages".
  const xmlns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(xmlns, 'svg');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const paths = ['M3 6l2 2 3-3', 'M3 16l2 2 3-3', 'M12 6h9', 'M12 17h9'];
  for (const d of paths) {
    const p = document.createElementNS(xmlns, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

/**
 * True when the button we clone styling from shows an icon and nothing else.
 * Read off the live reference rather than hard-coding ChatGPT's current class
 * names, so a future header restyle doesn't need a code change here.
 */
export function isIconOnly(reference: HTMLElement): boolean {
  return (reference.textContent || '').trim().length === 0;
}

function removeTrackedButton(): void {
  injectedButton?.remove();
  injectedButton = null;
}

function injectIfNeeded(generation: number): void {
  if (!isActiveGeneration(generation)) return;

  const conversationId = currentConvIdFromUrl();
  if (!conversationId) {
    removeTrackedButton();
    closeExportMenu();
    return;
  }

  // See `headerActionSlot.ts`: Share's wrapper is a `display: inline` Radix
  // span, so anything inserted beside it stacks underneath instead of sitting
  // in the row. Anchor on the "…" options row, which is a real flex row.
  if (injectedButton && !injectedButton.isConnected) {
    removeTrackedButton();
    closeExportMenu();
  }
  const site = findOptionsButtonRow();
  if (!site) return;
  const { parent: host, before, styleSource } = site;
  if (injectedButton && injectedButton.parentElement !== host) {
    removeTrackedButton();
  }
  const existing = host.querySelector<HTMLButtonElement>(`[${TAG}]`);
  if (existing) {
    injectedButton = existing;
    return;
  }

  const label = getTranslationSync('singleConvExportButton');
  const tooltip = getTranslationSync('singleConvExportButtonTooltip');

  const btn = document.createElement('button');
  // Clone styling from Share so we inherit ChatGPT-native padding / rounding /
  // hover state. We add our own marker class for a small gap between the icon
  // and the label (ChatGPT's native icon-only buttons don't need one).
  // Strip Share's transient disabled classes so our (always-functional) button
  // never renders dimmed with a not-allowed cursor.
  btn.className = buildClonedButtonClassName(styleSource.className, 'gv-export-conv-topbar');
  btn.type = 'button';
  btn.setAttribute(TAG, '1');
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', label);
  btn.title = tooltip;

  const icon = buildDownloadIcon();
  // ChatGPT's 2026-07 header renders these actions as FIXED-SIZE icon-only
  // buttons (`flex h-9 w-9 items-center justify-center`). We clone that class
  // list, so appending a text label overflows the 36×36 box and the label
  // spills onto its own line under the icon — the "被换行了很丑" report.
  // Mirror the reference button instead: no text on Share ⇒ no text on ours,
  // with the localised label carried by `aria-label` + `title`. If ChatGPT ever
  // goes back to labelled header buttons, this flips back on its own.
  if (isIconOnly(styleSource)) {
    btn.replaceChildren(icon);
  } else {
    const labelEl = document.createElement('span');
    labelEl.className = 'gv-export-conv-topbar__label';
    labelEl.textContent = label;
    btn.replaceChildren(icon, labelEl);
  }

  // One top-bar button now opens a small menu so "export whole" and "select &
  // export" share a single slot instead of crowding the header with two
  // buttons at the same level.
  btn.addEventListener('click', (event) => {
    if (!isActiveGeneration(generation)) return;
    event.preventDefault();
    event.stopPropagation();
    toggleExportMenu(btn, generation);
  });

  host.insertBefore(btn, before);
  injectedButton = btn;
}

// ─── Export menu (popover) ──────────────────────────────────────────────────
let openMenuEl: HTMLElement | null = null;
let openMenuAnchor: HTMLElement | null = null;
let menuDismissHandlers: Array<() => void> = [];

function closeExportMenu(restoreAnchorFocus = false): void {
  const anchor = openMenuAnchor;
  anchor?.setAttribute('aria-expanded', 'false');
  openMenuAnchor = null;
  openMenuEl?.remove();
  openMenuEl = null;
  menuDismissHandlers.forEach((off) => off());
  menuDismissHandlers = [];
  if (restoreAnchorFocus && anchor?.isConnected) anchor.focus();
}

function makeMenuItem(label: string, onClick: () => void, generation: number): HTMLButtonElement {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'gv-export-menu__item';
  item.setAttribute('role', 'menuitem');
  item.textContent = label;
  item.addEventListener('click', (event) => {
    if (!isActiveGeneration(generation)) return;
    event.preventDefault();
    event.stopPropagation();
    closeExportMenu();
    onClick();
  });
  return item;
}

function disableWhileGenerating(item: HTMLButtonElement): void {
  if (!isChatGptResponseGenerating()) return;
  item.disabled = true;
  item.setAttribute('aria-disabled', 'true');
  item.title = getTranslationSync('singleConvExportGenerating');
}

function toggleExportMenu(anchor: HTMLElement, generation: number): void {
  if (!isActiveGeneration(generation)) return;
  if (openMenuEl) {
    closeExportMenu();
    return;
  }
  const convId = currentConvIdFromUrl();
  if (!convId) {
    console.warn('[GPT-Voyager] export: no conversation ID in URL');
    return;
  }

  const menu = document.createElement('div');
  menu.className = 'gv-export-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', getTranslationSync('singleConvExportButton'));

  const wholeItem = makeMenuItem(
    getTranslationSync('singleConvExportMenuWhole'),
    () => {
      if (isChatGptResponseGenerating()) {
        alert(getTranslationSync('singleConvExportGenerating'));
        return;
      }
      // Resolve format from the popup setting at click time so a running ChatGPT
      // tab picks up popup changes without a reload. The generation guard keeps
      // a late storage result from exporting after feature teardown.
      void resolveExportFormat().then(async (fmt) => {
        if (!isActiveGeneration(generation) || isChatGptResponseGenerating()) return;
        const currentPath = window.location.pathname;
        anchor.setAttribute('aria-busy', 'true');
        if (anchor instanceof HTMLButtonElement) anchor.disabled = true;
        try {
          const prepared = await prepareWholeConversationExport(convId, {
            onStage: (stage, discovered) => {
              if (!isActiveGeneration(generation)) return;
              anchor.title =
                stage === 'rebuilding'
                  ? `Loading conversation history (${discovered ?? 0})…`
                  : stage === 'incremental'
                    ? 'Updating conversation cache…'
                    : 'Checking conversation cache…';
            },
          });
          if (
            isActiveGeneration(generation) &&
            window.location.pathname === currentPath &&
            !isChatGptResponseGenerating()
          ) {
            await exportPreparedConversation(prepared, fmt);
          }
        } catch (error) {
          console.warn('[GPT-Voyager] export: unable to prepare complete conversation', error);
          alert(
            'GPT-Voyager could not safely load the complete conversation. Please keep this chat open and try again.',
          );
        } finally {
          if (isActiveGeneration(generation) && anchor.isConnected) {
            anchor.removeAttribute('aria-busy');
            anchor.title = getTranslationSync('singleConvExportButtonTooltip');
            if (anchor instanceof HTMLButtonElement) anchor.disabled = false;
          }
        }
      });
    },
    generation,
  );
  const wholeIcon = buildDownloadIcon();
  wholeIcon.classList.add('gv-export-menu__icon');
  wholeItem.prepend(wholeIcon);
  disableWhileGenerating(wholeItem);

  const selectItem = makeMenuItem(
    getTranslationSync('singleConvExportSelectButton'),
    () => enterSelectionMode(convId),
    generation,
  );
  const selectIcon = buildSelectIcon();
  selectIcon.classList.add('gv-export-menu__icon');
  selectItem.prepend(selectIcon);
  disableWhileGenerating(selectItem);

  const menuItems = [wholeItem, selectItem];
  const focusMenuItem = (index: number) => {
    menuItems.forEach((item, itemIndex) => {
      item.tabIndex = itemIndex === index ? 0 : -1;
    });
    menuItems[index]?.focus();
  };

  menu.append(wholeItem, selectItem);
  document.body.appendChild(menu);
  openMenuEl = menu;
  openMenuAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');

  // Position below the anchor, right-aligned, clamped to the viewport.
  const rect = anchor.getBoundingClientRect();
  const menuWidth = menu.offsetWidth || 200;
  let left = rect.right - menuWidth;
  if (left < 8) left = 8;
  menu.style.top = `${Math.round(rect.bottom + 6)}px`;
  menu.style.left = `${Math.round(left)}px`;

  // Dismiss on outside click, Escape, scroll, or resize. While the menu is
  // open, keep a single menuitem in the tab order and support the standard
  // arrow/Home/End navigation pattern without installing a persistent global
  // listener.
  const onPointerDown = (e: Event) => {
    if (menu.contains(e.target as Node) || anchor.contains(e.target as Node)) return;
    closeExportMenu();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeExportMenu(true);
      return;
    }

    const activeIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (e.key === 'ArrowDown')
      nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % menuItems.length;
    if (e.key === 'ArrowUp') {
      nextIndex = activeIndex <= 0 ? menuItems.length - 1 : activeIndex - 1;
    }
    if (e.key === 'Home') nextIndex = 0;
    if (e.key === 'End') nextIndex = menuItems.length - 1;
    if (nextIndex === null) return;

    e.preventDefault();
    e.stopPropagation();
    focusMenuItem(nextIndex);
  };
  const onReflow = () => closeExportMenu();
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onReflow, true);
  window.addEventListener('resize', onReflow, true);
  menuDismissHandlers = [
    () => document.removeEventListener('pointerdown', onPointerDown, true),
    () => window.removeEventListener('keydown', onKeyDown, true),
    () => window.removeEventListener('scroll', onReflow, true),
    () => window.removeEventListener('resize', onReflow, true),
  ];
  focusMenuItem(0);
}

/**
 * Read the user's preferred export format from chrome.storage.sync.
 * Defensive against malformed values written by older builds — anything
 * outside the union falls back to the standard markdown default.
 */
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

let observer: MutationObserver | null = null;
let injectTimer: number | null = null;
let locationChangeHandler: (() => void) | null = null;

function nodeTouchesHeader(node: Node, header: HTMLElement | null): boolean {
  if (!(node instanceof Element)) return false;
  if (header && (node === header || header.contains(node) || node.contains(header))) return true;
  if (node.id === 'conversation-header-actions') return true;
  return node.querySelector('#conversation-header-actions') !== null;
}

function mutationsMayAffectHeader(records: MutationRecord[]): boolean {
  const header = document.getElementById('conversation-header-actions');
  if (injectedButton && !injectedButton.isConnected) return true;

  return records.some((record) => {
    if (header && header.contains(record.target)) return true;
    return [...record.addedNodes, ...record.removedNodes].some((node) =>
      nodeTouchesHeader(node, header),
    );
  });
}

function scheduleInjection(generation: number): void {
  if (!isActiveGeneration(generation)) return;
  if (injectTimer !== null) window.clearTimeout(injectTimer);
  injectTimer = window.setTimeout(() => {
    injectTimer = null;
    injectIfNeeded(generation);
  }, INJECT_DEBOUNCE_MS);
}

export function startTopBarExportButton(): void {
  if (activeGeneration !== null) {
    injectIfNeeded(activeGeneration);
    return;
  }

  const generation = ++lifecycleGeneration;
  activeGeneration = generation;

  // Try immediately, then watch the page cheaply. Streaming token mutations
  // outside the semantic header are ignored; relevant header replacements are
  // coalesced into one bounded slot lookup.
  injectIfNeeded(generation);
  observer = new MutationObserver((records) => {
    if (mutationsMayAffectHeader(records)) scheduleInjection(generation);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  locationChangeHandler = () => scheduleInjection(generation);
  window.addEventListener('popstate', locationChangeHandler);
  window.addEventListener('hashchange', locationChangeHandler);
}

export function stopTopBarExportButton(): void {
  activeGeneration = null;
  lifecycleGeneration++;
  if (injectTimer !== null) {
    window.clearTimeout(injectTimer);
    injectTimer = null;
  }
  closeExportMenu();
  exitSelectionMode();
  observer?.disconnect();
  observer = null;
  if (locationChangeHandler) {
    window.removeEventListener('popstate', locationChangeHandler);
    window.removeEventListener('hashchange', locationChangeHandler);
    locationChangeHandler = null;
  }
  removeTrackedButton();
  document.querySelectorAll<HTMLElement>(`[${TAG}]`).forEach((button) => button.remove());
}
