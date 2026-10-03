import { StorageKeys } from '@/core/types/common';
import { getTranslationSync } from '@/utils/i18n';
import type { TranslationKey } from '@/utils/translations';

import type { QuotaSnapshot, QuotaWindow } from '../../pageWorld/quotaMirror';
import {
  APP_SHELL_NAVIGATION_RAIL_SELECTOR,
  QUOTA_COMPOSER_ANCHOR_SELECTOR,
  QUOTA_RAIL_AVATAR_SELECTOR,
  isChatQuotaComposer,
} from '../chatgptDom';
import { type QuotaState, readQuotaState, ringRemaining } from './data';

const PANEL_ID = 'gv-quota-panel';
const STYLE_ID = 'gv-quota-style';
const MOUNT_ANCHORS = `${QUOTA_COMPOSER_ANCHOR_SELECTOR}, ${QUOTA_RAIL_AVATAR_SELECTOR}`;
const STALE_MS = 180_000;
const SVG_NS = 'http://www.w3.org/2000/svg';
type Widget = {
  button: HTMLButtonElement;
  progress: SVGCircleElement;
  anchor: HTMLElement;
  form: HTMLElement | null;
  wrapper: HTMLElement | null;
  signature: string;
};
let stopCurrent: (() => void) | null = null;

const CSS = `
.gv-quota-ring{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:28px;height:28px;margin-inline-end:3px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--color-text-tertiary,#8b8b8b);cursor:pointer;pointer-events:auto;transition:transform 180ms cubic-bezier(.22,1.35,.36,1),color 120ms ease}
.gv-quota-ring>svg{display:block;width:20px;height:20px;overflow:visible;pointer-events:none}
.gv-quota-ring:hover,.gv-quota-ring:focus-visible{color:var(--color-text-primary,#aaa);transform:scale(1.09);background:var(--app-color-background-button-tertiary-hover,rgba(128,128,128,.1))}
.gv-quota-ring:focus-visible{outline:2px solid var(--color-border-heavy,#a78bfa);outline-offset:2px}
.gv-quota-ring:active{transform:scale(.94)}
.gv-quota-track{opacity:.22}.gv-quota-progress{transform:rotate(-90deg);transform-origin:10px 10px}
.gv-quota-ring[data-unknown=true] .gv-quota-track{stroke-dasharray:8 6;opacity:.5}
.gv-quota-ring[data-stale=true]{opacity:.65}
.gv-quota-sidebar-slot{display:flex;flex:none;width:100%;justify-content:center;align-items:center;margin-block:2px}
.gv-quota-sidebar-slot .gv-quota-ring{width:36px;height:36px;margin:0}
#${PANEL_ID}{position:fixed;z-index:2147483000;width:288px;max-width:calc(100vw - 20px);box-sizing:border-box;padding:16px;border-radius:17px;border:1px solid var(--color-border,var(--border-default,rgba(128,128,128,.2)));background:var(--color-surface,var(--main-surface-primary,#202020));color:var(--color-text-primary,#eee);box-shadow:0 14px 44px rgba(0,0,0,.24),0 3px 10px rgba(0,0,0,.1);font:13px/1.45 ui-sans-serif,system-ui,sans-serif;opacity:0;visibility:hidden;pointer-events:none;transform:translateY(6px) scale(.96);transform-origin:bottom center;transition:opacity 130ms ease,transform 260ms cubic-bezier(.22,1.3,.36,1),visibility 0s 150ms}
#${PANEL_ID}[data-placement=side]{transform:translateX(-5px) scale(.96);transform-origin:left center}
#${PANEL_ID}[data-open]{opacity:1;visibility:visible;pointer-events:auto;transform:translate(0) scale(1);transition-delay:0s}
#${PANEL_ID} .gv-quota-title{font-weight:650;font-size:13px;line-height:1.4;margin:0}
#${PANEL_ID} .gv-quota-note{font-size:11px;line-height:1.5;color:var(--color-text-tertiary,#999);margin-top:4px}
#${PANEL_ID} .gv-quota-window{margin-top:13px}
#${PANEL_ID} .gv-quota-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
#${PANEL_ID} .gv-quota-name{color:var(--color-text-secondary,#aaa);min-width:0;overflow-wrap:anywhere}
#${PANEL_ID} .gv-quota-value{font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}
#${PANEL_ID} .gv-quota-bar{height:5px;overflow:hidden;border-radius:5px;background:var(--app-color-background-button-tertiary-hover,rgba(128,128,128,.18));margin-top:6px}
#${PANEL_ID} .gv-quota-fill{height:100%;border-radius:inherit;background:currentColor;opacity:.8}
#${PANEL_ID} .gv-quota-meta{color:var(--color-text-tertiary,#999);font-size:11px;margin-top:5px}
#${PANEL_ID} .gv-quota-footer{color:var(--color-text-tertiary,#999);font-size:11px;margin-top:13px;padding-top:10px;border-top:1px solid var(--color-border,rgba(128,128,128,.15))}
@media(prefers-reduced-motion:reduce){.gv-quota-ring,#${PANEL_ID}{transition:none!important;transform:none!important}}
`;

function text(key: TranslationKey, params: Record<string, string> = {}): string {
  let result = getTranslationSync(key);
  for (const [name, value] of Object.entries(params)) result = result.replace(`{${name}}`, value);
  return result;
}
function div(className: string, value?: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  if (value !== undefined) el.textContent = value;
  return el;
}
function percent(value: number): string {
  return String(Math.round(value * 10) / 10);
}
function windowName(w: QuotaWindow): string {
  const duration =
    w.seconds === 604800
      ? text('quotaRing_weekly')
      : w.seconds === 18000
        ? text('quotaRing_fiveHour')
        : text('quotaRing_window', { hours: String(Math.round(w.seconds / 360) / 10) });
  return w.group === 'review'
    ? `${text('quotaRing_review')} · ${duration}`
    : w.group === 'additional'
      ? `${w.name || text('quotaRing_additional')} · ${duration}`
      : duration;
}

export function startQuotaRing(): () => void {
  if (stopCurrent) return stopCurrent;
  let stopped = false;
  let state: QuotaState = { epoch: -1, snapshot: null, failed: false };
  const widgets = new Set<Widget>();
  let active: Widget | null = null;
  let enterTimer: number | null = null;
  let leaveTimer: number | null = null;
  let freshnessTimer: number | null = null;
  let mountTimer: number | null = null;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  const panel = div('gv-quota-panel');
  panel.id = PANEL_ID;
  panel.setAttribute('role', 'tooltip');
  panel.setAttribute('aria-hidden', 'true');
  document.body.appendChild(panel);
  const clearTimer = (id: number | null) => {
    if (id !== null) window.clearTimeout(id);
  };
  const isStale = () =>
    state.failed || (!!state.snapshot && Date.now() - state.snapshot.capturedAt > STALE_MS);
  const updateWidget = (widget: Widget) => {
    const remaining = ringRemaining(state.snapshot);
    const stale = isStale();
    const label = `${text('quotaRing_title')} · ${remaining === null ? text('quotaRing_waiting') : text('quotaRing_remaining', { percent: percent(remaining) })}${stale ? ` · ${text('quotaRing_stale')}` : ''}`;
    const signature = `${remaining}|${stale}|${label}`;
    if (signature === widget.signature) return;
    widget.signature = signature;
    widget.button.setAttribute('aria-label', label);
    widget.button.dataset.unknown = String(remaining === null);
    widget.button.dataset.stale = String(stale);
    widget.progress.setAttribute('stroke-dasharray', `${remaining ?? 0} 100`);
  };
  const chatMode = (widget: Widget) => {
    const form =
      widget.form ??
      document.querySelector<HTMLElement>(
        'form[data-chatgpt-composer],form[data-type="unified-composer"]',
      );
    return !!form && isChatQuotaComposer(form);
  };
  const position = () => {
    if (!active || !active.button.isConnected) return;
    const r = active.button.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const side = active.form === null;
    panel.dataset.placement = side ? 'side' : 'above';
    let left = side ? r.right + 12 : r.left + r.width / 2 - p.width / 2;
    let top = side ? r.top + r.height / 2 - p.height / 2 : r.top - p.height - 10;
    if (!side && top < 10) top = r.bottom + 10;
    left = Math.max(10, Math.min(left, window.innerWidth - p.width - 10));
    top = Math.max(10, Math.min(top, window.innerHeight - p.height - 10));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  };
  const renderPanel = () => {
    if (!active) return;
    panel.replaceChildren(div('gv-quota-title', text('quotaRing_title')));
    if (chatMode(active)) panel.appendChild(div('gv-quota-note', text('quotaRing_chatNote')));
    const snapshot = state.snapshot;
    if (!snapshot?.windows.length)
      panel.appendChild(
        div(
          'gv-quota-window gv-quota-name',
          text(snapshot ? 'quotaRing_noPercentage' : 'quotaRing_waiting'),
        ),
      );
    for (const w of snapshot?.windows ?? []) {
      const section = div('gv-quota-window');
      const row = div('gv-quota-row');
      row.append(
        div('gv-quota-name', windowName(w)),
        div('gv-quota-value', text('quotaRing_remaining', { percent: percent(w.remaining) })),
      );
      const bar = div('gv-quota-bar');
      const fill = div('gv-quota-fill');
      fill.style.width = `${w.remaining}%`;
      bar.appendChild(fill);
      section.append(row, bar);
      if (w.resetAt !== null)
        section.appendChild(
          div(
            'gv-quota-meta',
            text('quotaRing_reset', {
              time: new Date(w.resetAt * 1000).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              }),
            }),
          ),
        );
      panel.appendChild(section);
    }
    if (snapshot && (snapshot.credits !== null || snapshot.unlimitedCredits))
      panel.appendChild(
        div(
          'gv-quota-meta',
          text('quotaRing_credits', {
            balance: snapshot.unlimitedCredits ? text('quotaRing_unlimited') : snapshot.credits!,
          }),
        ),
      );
    if (snapshot) {
      const footer = div(
        'gv-quota-footer',
        text('quotaRing_updated', {
          time: new Date(snapshot.capturedAt).toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }),
        }),
      );
      if (isStale()) footer.appendChild(div('gv-quota-meta', text('quotaRing_stale')));
      panel.appendChild(footer);
    }
    clearTimer(freshnessTimer);
    freshnessTimer = null;
    if (snapshot && !isStale())
      freshnessTimer = window.setTimeout(
        () => {
          freshnessTimer = null;
          if (active) {
            widgets.forEach(updateWidget);
            renderPanel();
            position();
          }
        },
        Math.max(1, snapshot.capturedAt + STALE_MS + 1 - Date.now()),
      );
  };
  const hide = () => {
    clearTimer(enterTimer);
    enterTimer = null;
    clearTimer(leaveTimer);
    leaveTimer = null;
    clearTimer(freshnessTimer);
    freshnessTimer = null;
    panel.removeAttribute('data-open');
    panel.setAttribute('aria-hidden', 'true');
    active = null;
  };
  const show = (widget: Widget) => {
    if (stopped || !widget.button.isConnected || document.visibilityState === 'hidden') return;
    clearTimer(leaveTimer);
    leaveTimer = null;
    active = widget;
    updateWidget(widget);
    renderPanel();
    position();
    panel.setAttribute('aria-hidden', 'false');
    panel.setAttribute('data-open', '');
  };
  const leave = () => {
    clearTimer(enterTimer);
    enterTimer = null;
    clearTimer(leaveTimer);
    leaveTimer = window.setTimeout(hide, 160);
  };
  panel.addEventListener('mouseenter', () => {
    clearTimer(leaveTimer);
    leaveTimer = null;
  });
  panel.addEventListener('mouseleave', leave);
  const createWidget = (
    anchor: HTMLElement,
    form: HTMLElement | null,
    wrapper: HTMLElement | null,
  ): Widget => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gv-quota-ring';
    button.setAttribute('aria-describedby', PANEL_ID);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const circle = (className: string) => {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('class', className);
      for (const [key, value] of Object.entries({
        cx: '10',
        cy: '10',
        r: '7.3',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2.3',
        pathLength: '100',
      }))
        c.setAttribute(key, value);
      return c;
    };
    const progress = circle('gv-quota-progress');
    progress.setAttribute('stroke-linecap', 'round');
    svg.append(circle('gv-quota-track'), progress);
    button.appendChild(svg);
    const widget: Widget = { button, progress, anchor, form, wrapper, signature: '' };
    button.addEventListener('mouseenter', () => {
      clearTimer(leaveTimer);
      leaveTimer = null;
      clearTimer(enterTimer);
      enterTimer = window.setTimeout(() => {
        enterTimer = null;
        show(widget);
      }, 110);
    });
    button.addEventListener('mouseleave', leave);
    button.addEventListener('focus', () => show(widget));
    button.addEventListener('blur', leave);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      show(widget);
    });
    updateWidget(widget);
    widgets.add(widget);
    return widget;
  };
  const mount = () => {
    mountTimer = null;
    if (stopped) return;
    for (const widget of widgets) {
      if (widget.anchor.isConnected && widget.button.isConnected) continue;
      if (active === widget) hide();
      widget.button.remove();
      widget.wrapper?.remove();
      widgets.delete(widget);
    }
    for (const anchor of document.querySelectorAll<HTMLElement>(QUOTA_COMPOSER_ANCHOR_SELECTOR)) {
      if ([...widgets].some((w) => w.anchor === anchor)) continue;
      const form = anchor.closest<HTMLElement>('form');
      if (!form) continue;
      let insertion: HTMLElement = anchor;
      while (
        insertion.parentElement &&
        getComputedStyle(insertion.parentElement).display === 'contents'
      )
        insertion = insertion.parentElement;
      insertion.before(createWidget(anchor, form, null).button);
    }
    const avatars = document.querySelectorAll<HTMLElement>(QUOTA_RAIL_AVATAR_SELECTOR);
    const avatar = avatars.item(avatars.length - 1);
    const rail = avatar?.closest(APP_SHELL_NAVIGATION_RAIL_SELECTOR);
    if (avatar && rail && ![...widgets].some((w) => w.anchor === avatar)) {
      let footer = avatar;
      while (footer.parentElement && footer.parentElement !== rail) footer = footer.parentElement;
      const wrapper = div('gv-quota-sidebar-slot');
      footer.before(wrapper);
      wrapper.appendChild(createWidget(avatar, null, wrapper).button);
    }
  };
  const scheduleMount = () => {
    if (!stopped && mountTimer === null) mountTimer = window.setTimeout(mount, 80);
  };
  const observer = new MutationObserver((mutations) => {
    if ([...widgets].some((w) => !w.button.isConnected || !w.anchor.isConnected)) {
      scheduleMount();
      return;
    }
    for (const mutation of mutations)
      for (const node of mutation.addedNodes) {
        if (
          !(node instanceof Element) ||
          node.closest('.gv-quota-ring,.gv-quota-sidebar-slot,#gv-quota-panel')
        )
          continue;
        // Only search newly mounted subtrees, never rescan the document per token.
        if (node.matches(MOUNT_ANCHORS) || node.querySelector(MOUNT_ANCHORS)) {
          scheduleMount();
          return;
        }
      }
  });
  const message = (event: MessageEvent) => {
    if (event.origin !== location.origin) return;
    const next = readQuotaState(event.data);
    if (
      !next ||
      next.epoch < state.epoch ||
      (next.epoch === state.epoch &&
        next.snapshot &&
        state.snapshot &&
        next.snapshot.capturedAt < state.snapshot.capturedAt)
    )
      return;
    state = next;
    widgets.forEach(updateWidget);
    if (active) {
      renderPanel();
      position();
    }
  };
  const language = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if ((area === 'sync' || area === 'local') && changes[StorageKeys.LANGUAGE])
      queueMicrotask(() => {
        if (stopped) return;
        widgets.forEach(updateWidget);
        if (active) {
          renderPanel();
          position();
        }
      });
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && active) hide();
  };
  const visibility = () => {
    if (document.visibilityState === 'hidden') hide();
    else {
      widgets.forEach(updateWidget);
      window.postMessage({ __gvType: 'gv-quota-subscribe' }, location.origin);
    }
  };
  const scroll = () => {
    if (active) hide();
  };
  window.addEventListener('message', message);
  window.addEventListener('keydown', key);
  window.addEventListener('resize', position);
  window.addEventListener('scroll', scroll, true);
  document.addEventListener('visibilitychange', visibility);
  chrome.storage?.onChanged?.addListener(language);
  observer.observe(document.body, { childList: true, subtree: true });
  mount();
  window.postMessage({ __gvType: 'gv-quota-subscribe' }, location.origin);
  stopCurrent = () => {
    stopped = true;
    hide();
    clearTimer(mountTimer);
    observer.disconnect();
    window.removeEventListener('message', message);
    window.removeEventListener('keydown', key);
    window.removeEventListener('resize', position);
    window.removeEventListener('scroll', scroll, true);
    document.removeEventListener('visibilitychange', visibility);
    chrome.storage?.onChanged?.removeListener(language);
    widgets.forEach((w) => {
      w.button.remove();
      w.wrapper?.remove();
    });
    widgets.clear();
    panel.remove();
    style.remove();
    stopCurrent = null;
  };
  return stopCurrent;
}

export function stopQuotaRing(): void {
  stopCurrent?.();
}
