/*
 * Fold away ChatGPT's 2026-09 icon rail (home / history / library / … / avatar)
 * with a ◀ button in the sidebar header, between the "ChatGPT" title and search.
 * Folded, only the sidebar panel is left; the button turns ▶ and brings the
 * rail back.
 *
 * That is the pre-2026-09 experience: an expanded sidebar was just the panel,
 * and the slim strip only appeared once the sidebar was collapsed — its top
 * button opens the sidebar again. So the rail folds only while all of these
 * hold, and otherwise stays exactly as ChatGPT draws it:
 *   - the user folded it;
 *   - the panel is expanded (ChatGPT's resize handle is rendered) — collapsed,
 *     the rail is all that is left and holds the way back;
 *   - our ▶ button is actually in the panel — if a ChatGPT update stops us from
 *     placing it, nothing folds, so there is always a way back.
 * Folded, the sidebar keeps the panel's width and shifts left by the rail's
 * width — the thread gains that space. ChatGPT won't narrow its panel below
 * ~290px, so this is a width override, scoped to the elements that read
 * `--app-shell-left-panel-width` (the aside, its content wrapper, the title
 * bar's start slot) and computed from ChatGPT's own width, so its drag handle
 * and collapse keep working. Not below 768px, where ChatGPT turns the sidebar
 * into an overlay and zeroes that variable. Default on; `gvRailToggleEnabled` turns it off.
 *
 * Performance: the page has ~27k elements and a full style recalc costs
 * ~200 ms. Two things trigger one, so both are avoided:
 *   - state attributes on <html> (plus `:has()`) invalidate the whole document
 *     — the state lives on the rail and the button instead, decided in JS;
 *   - ChatGPT's ResizeObserver writes the rail's width into
 *     `--app-shell-navigation-rail-width` on the app root, an inherited custom
 *     property — so the rail's box never changes size: folded, it is taken out
 *     of flow at full width, and the motion is transform/opacity only (FLIP).
 *   The width override is a plain `width` on those few elements, not a
 *   redefinition of the inherited variable.
 */
import { StorageKeys } from '@/core/types/common';
import { getTranslationSync } from '@/utils/i18n';

import {
  APP_SHELL_LEFT_PANEL_SELECTOR,
  APP_SHELL_NAVIGATION_RAIL_SELECTOR,
  APP_SHELL_PAGE_SURFACE_SELECTOR,
  APP_SHELL_PANEL_RESIZER_SELECTOR,
  APP_SHELL_SIDEBAR_TOGGLE_SELECTOR,
} from '../chatgptDom';

const STYLE_ID = 'gv-rail-toggle-style';
const TOOLTIP_ID = 'gv-rail-toggle-tooltip';
const BUTTON_ATTR = 'data-gv-rail-toggle';
/** On the rail (folded away), the page card behind the panel, and our button (shows ▶). */
const FOLDED_ATTR = 'data-gv-rail-folded';
const TOOLTIP_DELAY_MS = 200;
const FOLD_MS = 340;
const UNFOLD_MS = 560;
const FOLD_EASE = 'cubic-bezier(0.6, 0, 0.2, 1)';
const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
const SOFT_SPRING = 'cubic-bezier(0.34, 1.25, 0.64, 1)';
const SVG_NS = 'http://www.w3.org/2000/svg';

const RAIL = APP_SHELL_NAVIGATION_RAIL_SELECTOR;
const SURFACE = APP_SHELL_PAGE_SURFACE_SELECTOR;
const ASIDE = APP_SHELL_LEFT_PANEL_SELECTOR;
const HEADER_START_SLOT = 'header[data-app-shell-titlebar] > [data-app-shell-header-slot="start"]';
const MAIN_TITLEBAR = 'header[data-app-shell-titlebar] [data-app-shell-main-titlebar]';
const WORKSPACE_ROW = '[data-app-shell-workspace-row]';
/** ChatGPT's side-by-side layout; below it the sidebar is an overlay. */
const WIDE_QUERY = '(min-width: 768px)';
/** The panel's own width, without the rail. */
const FOLDED_WIDTH =
  'calc(var(--app-shell-left-panel-width) - var(--app-shell-navigation-rail-width, 52px))';

function buildStyle(): string {
  return `
    @media ${WIDE_QUERY} {
      ${RAIL}[${FOLDED_ATTR}] {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        opacity: 0;
        transform: translateX(-100%);
        pointer-events: none;
        visibility: hidden;
        transition: visibility 0s linear ${FOLD_MS}ms;
      }
      /* The card behind panel + thread otherwise keeps starting at the rail's
         edge, and its corner and shadow show through the panel. */
      ${SURFACE}[${FOLDED_ATTR}] {
        left: 0;
      }
      /* Keep the panel's width and give the rail's space to the thread. */
      ${ASIDE}[${FOLDED_ATTR}],
      ${ASIDE} > [${FOLDED_ATTR}],
      ${HEADER_START_SLOT}[${FOLDED_ATTR}] {
        width: ${FOLDED_WIDTH} !important;
      }
      ${ASIDE} > [${FOLDED_ATTR}],
      ${HEADER_START_SLOT}[${FOLDED_ATTR}] {
        min-width: 0 !important;
      }
    }

    [${BUTTON_ATTR}] .gv-rail-toggle-icon {
      transition: transform 480ms ${SPRING};
    }
    [${BUTTON_ATTR}]:hover .gv-rail-toggle-icon {
      transform: translateX(-2px);
    }
    [${BUTTON_ATTR}]:active .gv-rail-toggle-icon {
      transform: translateX(-2px) scale(0.8);
      transition-duration: 120ms;
    }
    [${BUTTON_ATTR}][${FOLDED_ATTR}] .gv-rail-toggle-icon {
      transform: rotate(180deg);
    }
    [${BUTTON_ATTR}][${FOLDED_ATTR}]:hover .gv-rail-toggle-icon {
      transform: rotate(180deg) translateX(-2px);
    }
    [${BUTTON_ATTR}][${FOLDED_ATTR}]:active .gv-rail-toggle-icon {
      transform: rotate(180deg) translateX(-2px) scale(0.8);
    }

    #${TOOLTIP_ID} {
      position: fixed;
      z-index: 2147483000;
      pointer-events: none;
      padding: 5px 9px;
      border-radius: 8px;
      font: 500 12.5px/1.35 ui-sans-serif, system-ui, sans-serif;
      color: #fff;
      background: rgba(17, 17, 17, 0.94);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
      white-space: nowrap;
      opacity: 0;
      transform: translate(-50%, -4px) scale(0.96);
      transition: opacity 140ms ease, transform 240ms ${SPRING};
    }
    #${TOOLTIP_ID}[data-visible] {
      opacity: 1;
      transform: translate(-50%, 0) scale(1);
    }
  `;
}

let started = false;
/** The user's choice; whether the rail is actually folded also depends on `canFold()`. */
let wantFolded = false;
let observer: MutationObserver | null = null;
let wideQuery: MediaQueryList | null = null;
let tooltipTimer: number | null = null;
let storageListener:
  | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
  | null = null;

function label(): string {
  return getTranslationSync(wantFolded ? 'railToggle_show' : 'railToggle_hide');
}

function createIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'gv-rail-toggle-icon');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M13.25 5.25 L6.5 10 L13.25 14.75 Z');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('fill-opacity', '0.18');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

/** The header button row: the nearest ancestor of ChatGPT's toggle that isn't a `display: contents` tooltip wrapper. */
function findHeaderButtonRow(toggle: HTMLElement): HTMLElement | null {
  let parent = toggle.parentElement;
  while (parent && getComputedStyle(parent).display === 'contents') {
    parent = parent.parentElement;
  }
  return parent;
}

function createButton(template: HTMLElement): HTMLButtonElement {
  // Clone ChatGPT's own header button so size, hover and focus styles match.
  const button = template.cloneNode(true) as HTMLButtonElement;
  for (const name of [
    'id',
    'aria-controls',
    'aria-expanded',
    'aria-pressed',
    'data-state',
    'data-suppress-active-style',
  ]) {
    button.removeAttribute(name);
  }
  button.type = 'button';
  button.setAttribute(BUTTON_ATTR, '');
  button.setAttribute('aria-label', label());
  // Compact, like the activity bell beside it: ChatGPT's minimum panel width
  // follows this header row, so a full-size button widens the whole sidebar.
  button.setAttribute('data-size', 'xs');
  button.removeAttribute('data-icon-size');
  const icon = createIcon();
  const nativeIcon = button.querySelector('svg');
  if (nativeIcon) nativeIcon.replaceWith(icon);
  else button.replaceChildren(icon);

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    hideTooltip();
    setWantFolded(!wantFolded, { animate: true, persist: true });
  });
  button.addEventListener('mouseenter', () => scheduleTooltip(button));
  button.addEventListener('mouseleave', hideTooltip);
  button.addEventListener('focus', () => scheduleTooltip(button));
  button.addEventListener('blur', hideTooltip);
  return button;
}

function scheduleTooltip(button: HTMLElement): void {
  if (tooltipTimer !== null) window.clearTimeout(tooltipTimer);
  tooltipTimer = window.setTimeout(() => {
    tooltipTimer = null;
    if (!button.isConnected) return;
    let tooltip = document.getElementById(TOOLTIP_ID);
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = TOOLTIP_ID;
      tooltip.setAttribute('role', 'tooltip');
      document.body.appendChild(tooltip);
    }
    tooltip.textContent = label();
    const rect = button.getBoundingClientRect();
    tooltip.style.left = `${rect.left + rect.width / 2}px`;
    tooltip.style.top = `${rect.bottom + 6}px`;
    // Next frame, so the entry transition runs from the hidden state.
    requestAnimationFrame(() => tooltip?.setAttribute('data-visible', ''));
  }, TOOLTIP_DELAY_MS);
}

function hideTooltip(): void {
  if (tooltipTimer !== null) {
    window.clearTimeout(tooltipTimer);
    tooltipTimer = null;
  }
  document.getElementById(TOOLTIP_ID)?.removeAttribute('data-visible');
}

function ensureButton(): void {
  // Only ever in the expanded panel's header, never in the rail.
  for (const stray of document.querySelectorAll(`${RAIL} [${BUTTON_ATTR}]`)) stray.remove();
  if (document.querySelector(`[${BUTTON_ATTR}]`)) return;
  const toggle = document.querySelector<HTMLElement>(APP_SHELL_SIDEBAR_TOGGLE_SELECTOR);
  if (!toggle || toggle.closest(RAIL)) return;
  const row = findHeaderButtonRow(toggle);
  if (!row) return;
  row.insertBefore(createButton(toggle), row.firstChild);
}

function canFold(): boolean {
  return (
    !!document.querySelector(APP_SHELL_PANEL_RESIZER_SELECTOR) &&
    !!document.querySelector(`${ASIDE} [${BUTTON_ATTR}]`) &&
    (wideQuery?.matches ?? true)
  );
}

/** Everything the fold restyles; the rail's own attribute is the source of truth. */
function foldTargets(rail: HTMLElement): HTMLElement[] {
  const aside = rail.closest<HTMLElement>(ASIDE);
  const wrapper = aside
    ? Array.from(aside.children).find(
        (child): child is HTMLElement => child instanceof HTMLElement && child.contains(rail),
      )
    : undefined;
  return [
    rail,
    aside,
    wrapper,
    document.querySelector<HTMLElement>(SURFACE),
    document.querySelector<HTMLElement>(HEADER_START_SLOT),
  ].filter((el): el is HTMLElement => !!el);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * FLIP: the attributes flip the layout once; everything right of the rail —
 * panel, thread, the card behind them, the thread's title bar — then slides
 * from where it was, and the rail slides out / in. Transform and opacity only.
 */
function playFold(rail: HTMLElement, folded: boolean, shift: number): void {
  const panel = rail.nextElementSibling instanceof HTMLElement ? rail.nextElementSibling : null;
  const row = rail.closest(WORKSPACE_ROW);
  const besideAside = row
    ? Array.from(row.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement && !child.matches(ASIDE),
      )
    : [];
  const movers = [panel, ...besideAside, document.querySelector<HTMLElement>(MAIN_TITLEBAR)].filter(
    (el): el is HTMLElement => !!el,
  );
  const from = folded ? shift : -shift;
  const timing = folded
    ? { duration: FOLD_MS, easing: FOLD_EASE }
    : { duration: UNFOLD_MS, easing: SOFT_SPRING };
  for (const el of movers) {
    el.animate([{ transform: `translateX(${from}px)` }, { transform: 'translateX(0)' }], timing);
  }
  if (folded) {
    rail.animate(
      [
        { transform: 'translateX(0)', opacity: 1 },
        { transform: 'translateX(-100%)', opacity: 0 },
      ],
      timing,
    );
    return;
  }
  rail.animate([{ transform: 'translateX(-100%)' }, { transform: 'translateX(0)' }], timing);
  // The icons pop back in one after another.
  rail.querySelectorAll<HTMLElement>(':scope > * > *').forEach((item, index) => {
    item.animate(
      [
        { transform: 'translateX(-14px) scale(0.8)', opacity: 0 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 520, delay: 60 + index * 24, easing: SPRING, fill: 'backwards' },
    );
  });
}

/** Brings the rail, the button and the user's choice in line. Cheap when nothing changed. */
function syncFold(animate: boolean): void {
  const button = document.querySelector<HTMLElement>(`[${BUTTON_ATTR}]`);
  if (button) {
    button.toggleAttribute(FOLDED_ATTR, wantFolded);
    const text = label();
    if (button.getAttribute('aria-label') !== text) button.setAttribute('aria-label', text);
  }
  const rail = document.querySelector<HTMLElement>(RAIL);
  if (!rail) return;
  const folded = wantFolded && canFold();
  const changed = rail.hasAttribute(FOLDED_ATTR) !== folded;
  if (!changed && !folded) return;
  const shift = changed ? rail.getBoundingClientRect().width : 0;
  // Re-applied while folded too: ChatGPT may re-render any of these.
  for (const el of foldTargets(rail)) el.toggleAttribute(FOLDED_ATTR, folded);
  if (changed && animate && shift > 0 && !prefersReducedMotion()) playFold(rail, folded, shift);
}

function setWantFolded(value: boolean, options: { animate: boolean; persist: boolean }): void {
  wantFolded = value;
  syncFold(options.animate);
  if (options.persist) {
    try {
      chrome.storage?.local?.set({ [StorageKeys.GV_RAIL_COLLAPSED]: value });
    } catch {}
  }
}

function onWideChange(): void {
  if (started) syncFold(false);
}

export function startRailToggle(): () => void {
  if (started) return stopRailToggle;
  started = true;

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.documentElement.appendChild(style);
  }
  style.textContent = buildStyle();

  ensureButton();
  // Synchronously, so the button — and with it the fold — is back in the same
  // frame ChatGPT re-renders the panel, and the rail returns the moment the
  // panel collapses.
  observer = new MutationObserver(() => {
    if (!started) return;
    ensureButton();
    syncFold(false);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  wideQuery = window.matchMedia?.(WIDE_QUERY) ?? null;
  wideQuery?.addEventListener('change', onWideChange);

  chrome.storage?.local?.get(StorageKeys.GV_RAIL_COLLAPSED, (result) => {
    if (!started || result?.[StorageKeys.GV_RAIL_COLLAPSED] !== true) return;
    // Restore the saved fold without animating it on page load.
    setWantFolded(true, { animate: false, persist: false });
  });

  storageListener = (changes, area) => {
    if (area !== 'local' || !changes[StorageKeys.GV_RAIL_COLLAPSED]) return;
    const next = changes[StorageKeys.GV_RAIL_COLLAPSED].newValue === true;
    if (next !== wantFolded) setWantFolded(next, { animate: true, persist: false });
  };
  try {
    chrome.storage?.onChanged?.addListener(storageListener);
  } catch {
    storageListener = null;
  }

  return stopRailToggle;
}

export function stopRailToggle(): void {
  if (!started) return;
  started = false;
  wantFolded = false;
  observer?.disconnect();
  observer = null;
  wideQuery?.removeEventListener('change', onWideChange);
  wideQuery = null;
  if (tooltipTimer !== null) window.clearTimeout(tooltipTimer);
  tooltipTimer = null;
  if (storageListener) {
    try {
      chrome.storage?.onChanged?.removeListener(storageListener);
    } catch {}
    storageListener = null;
  }
  document.querySelectorAll(`[${BUTTON_ATTR}]`).forEach((button) => button.remove());
  document.querySelectorAll(`[${FOLDED_ATTR}]`).forEach((el) => el.removeAttribute(FOLDED_ATTR));
  document.getElementById(TOOLTIP_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();
}
