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
  exportConversation,
  isSingleConvExportFormat,
} from '@/features/singleConvExport';
import { getTranslationSync } from '@/utils/i18n';

import { enterSelectionMode } from './selectionMode';

const TAG = 'data-gv-export-btn';

function currentConvIdFromUrl(): string | null {
  const m = /\/c\/([a-f0-9-]{36})/i.exec(window.location.pathname);
  return m ? m[1] : null;
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

function injectIfNeeded(): void {
  const share = document.querySelector<HTMLElement>('[data-testid="share-chat-button"]');
  if (!share) return;
  const parent = share.parentElement;
  if (!parent) return;
  if (parent.querySelector(`[${TAG}]`)) return;

  const label = getTranslationSync('singleConvExportButton');
  const tooltip = getTranslationSync('singleConvExportButtonTooltip');

  const btn = document.createElement('button');
  // Clone styling from Share so we inherit ChatGPT-native padding / rounding /
  // hover state. We add our own marker class for a small gap between the icon
  // and the label (ChatGPT's native icon-only buttons don't need one).
  btn.className = `${share.className} gv-export-conv-topbar`;
  btn.type = 'button';
  btn.setAttribute(TAG, '1');
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', label);
  btn.title = tooltip;

  const icon = buildDownloadIcon();
  const labelEl = document.createElement('span');
  labelEl.className = 'gv-export-conv-topbar__label';
  labelEl.textContent = label;
  btn.replaceChildren(icon, labelEl);

  // One top-bar button now opens a small menu so "export whole" and "select &
  // export" share a single slot instead of crowding the header with two
  // buttons at the same level.
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleExportMenu(btn);
  });

  parent.insertBefore(btn, share.nextSibling);
}

// ─── Export menu (popover) ──────────────────────────────────────────────────
let openMenuEl: HTMLElement | null = null;
let openMenuAnchor: HTMLElement | null = null;
let menuDismissHandlers: Array<() => void> = [];

function closeExportMenu(): void {
  openMenuAnchor?.setAttribute('aria-expanded', 'false');
  openMenuAnchor = null;
  openMenuEl?.remove();
  openMenuEl = null;
  menuDismissHandlers.forEach((off) => off());
  menuDismissHandlers = [];
}

function makeMenuItem(label: string, onClick: () => void): HTMLButtonElement {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'gv-export-menu__item';
  item.setAttribute('role', 'menuitem');
  item.textContent = label;
  item.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeExportMenu();
    onClick();
  });
  return item;
}

function toggleExportMenu(anchor: HTMLElement): void {
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

  const wholeItem = makeMenuItem(getTranslationSync('singleConvExportMenuWhole'), () => {
    // Resolve format from the popup setting at click time so a running ChatGPT
    // tab picks up popup changes without a reload.
    void resolveExportFormat().then((fmt) => exportConversation(convId, fmt));
  });
  const wholeIcon = buildDownloadIcon();
  wholeIcon.classList.add('gv-export-menu__icon');
  wholeItem.prepend(wholeIcon);

  const selectItem = makeMenuItem(getTranslationSync('singleConvExportSelectButton'), () =>
    enterSelectionMode(convId),
  );
  const selectIcon = buildSelectIcon();
  selectIcon.classList.add('gv-export-menu__icon');
  selectItem.prepend(selectIcon);

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

  // Dismiss on outside click, Escape, scroll, or resize.
  const onPointerDown = (e: Event) => {
    if (menu.contains(e.target as Node) || anchor.contains(e.target as Node)) return;
    closeExportMenu();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeExportMenu();
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

export function startTopBarExportButton(): void {
  // Try immediately
  injectIfNeeded();
  if (observer) return;
  observer = new MutationObserver(() => injectIfNeeded());
  observer.observe(document.body, { childList: true, subtree: true });
}

export function stopTopBarExportButton(): void {
  closeExportMenu();
  observer?.disconnect();
  observer = null;
}
