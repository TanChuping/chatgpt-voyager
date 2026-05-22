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
import {
  DEFAULT_SINGLE_CONV_EXPORT_FORMAT,
  exportConversation,
  isSingleConvExportFormat,
  type SingleConvExportFormat,
} from '@/features/singleConvExport';
import { StorageKeys } from '@/core/types/common';
import { getTranslationSync } from '@/utils/i18n';

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
  btn.setAttribute('aria-label', label);
  btn.title = tooltip;

  const icon = buildDownloadIcon();
  const labelEl = document.createElement('span');
  labelEl.className = 'gv-export-conv-topbar__label';
  labelEl.textContent = label;
  btn.replaceChildren(icon, labelEl);

  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const convId = currentConvIdFromUrl();
    if (!convId) {
      console.warn('[GPT-Voyager] export: no conversation ID in URL');
      return;
    }
    // Resolve format from the popup setting at click time so a
    // running ChatGPT tab picks up popup changes without a reload.
    void resolveExportFormat().then((fmt) => exportConversation(convId, fmt));
  });

  parent.insertBefore(btn, share.nextSibling);
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
  observer?.disconnect();
  observer = null;
}
