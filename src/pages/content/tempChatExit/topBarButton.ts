/**
 * "Temp Chat Regret" button injected to the LEFT of the temporary-chat
 * toggle while the user IS in temporary chat mode.
 *
 * Visibility rule:
 *   - URL has `?temporary-chat=true` OR the toggle's aria-label is the
 *     "关闭..." / "Close..." variant (i.e. temp mode is active right now).
 *   - Otherwise the button is removed so it never shows on normal pages.
 *
 * Position rule (mirrors announcement/topBarButton.ts — same DOM lesson):
 *   - Temp toggle's immediate parent is a `<span display:block>`. Two
 *     `<button display:flex>` siblings in block flow would stack
 *     vertically. We walk up to the first horizontal flex row ancestor
 *     and insert there, so the megaphone + regret + temp-toggle line up
 *     in one horizontal row.
 *   - Styling is cloned from the temp-chat-toggle button itself (never
 *     the wrapper div) — same anti-pattern the announcement button had.
 *
 * Rendering: icon + localized label (NOT icon-only). The label and
 * hover tooltip are pulled from `messages.json` via the shared `t()`
 * helper, so a user running the extension in Chinese sees "临时反悔"
 * and an English user sees "Regret temp chat" — no bilingual cramming.
 */
import { t } from './i18n';
import { runTempChatRegret } from './orchestrator';

const TAG = 'data-gv-temp-regret-btn';

const TEMP_TOGGLE_SELECTOR =
  '[data-testid="temporary-chat-toggle"], button[aria-label*="临时聊天"], button[aria-label*="temporary chat" i]';

// ChatGPT swaps the temp-chat-toggle out for a conversation-options
// button once the user sends their first message in temp mode. We
// anchor on either one (temp toggle takes priority since it's the
// stronger semantic match, but in the post-message state only the
// options button is there).
const ANCHOR_SELECTOR =
  TEMP_TOGGLE_SELECTOR + ', [data-testid="conversation-options-button"]';

function isTempModeActive(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get('temporary-chat') === 'true') {
      return true;
    }
  } catch {
    /* ignore */
  }
  // No URL signal — fall back to checking the toggle's aria-label
  // (which says "关闭..." / "Close..." in temp mode).
  const toggle = document.querySelector<HTMLElement>(TEMP_TOGGLE_SELECTOR);
  if (!toggle) return false;
  const label = (toggle.getAttribute('aria-label') || '').toLowerCase();
  return label.includes('关闭') || label.includes('close');
}

function buildIcon(): SVGSVGElement {
  // Curved "undo" arrow — visual shorthand for "regret/take back".
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
  arrow.setAttribute('d', 'M9 14L4 9l5-5');
  svg.appendChild(arrow);
  const tail = document.createElementNS(xmlns, 'path');
  tail.setAttribute('d', 'M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5h-4');
  svg.appendChild(tail);
  return svg;
}

/** Detect a container that would stack a new `<button display:flex>`
 *  sibling top-to-bottom rather than side-by-side. Same heuristic as
 *  announcement/topBarButton.ts:wouldStackVertically — kept independent
 *  here so the two features can be edited without cross-coupling. */
function wouldStackVertically(container: HTMLElement): boolean {
  const cs = window.getComputedStyle(container);
  if (cs.display === 'flex' || cs.display === 'inline-flex') {
    return cs.flexDirection === 'column' || cs.flexDirection === 'column-reverse';
  }
  if (cs.display === 'grid' || cs.display === 'inline-grid') return false;
  if (cs.display === 'inline') return false;
  return true;
}

function findHorizontalRowAncestor(
  start: HTMLElement,
): { parent: HTMLElement; before: HTMLElement } | null {
  const widthLimit = Math.max(window.innerWidth * 0.5, 320);
  let child: HTMLElement = start;
  let parent: HTMLElement | null = start.parentElement;
  let depth = 0;
  while (parent && parent !== document.body && depth < 5) {
    const pr = parent.getBoundingClientRect();
    if (pr.width > widthLimit) break;
    if (!wouldStackVertically(parent)) {
      return { parent, before: child };
    }
    child = parent;
    parent = parent.parentElement;
    depth++;
  }
  return null;
}

interface Anchor {
  parent: HTMLElement;
  before: HTMLElement;
  styleSource: HTMLElement;
}

function findAnchor(): Anchor | null {
  // Prefer the temp toggle (pre-message), fall back to options button
  // (post-message). Both occupy the same top-right slot in the header.
  const temp =
    document.querySelector<HTMLElement>(TEMP_TOGGLE_SELECTOR) ||
    document.querySelector<HTMLElement>('[data-testid="conversation-options-button"]');
  if (!temp || !temp.parentElement) return null;
  // Always anchor on the temp-toggle's wrapper (the span). Both this
  // button and the announcement button anchor here — natural insertion
  // order will be: [announce, regret, span] or [regret, announce, span]
  // depending on which observer fires first. We deliberately do NOT try
  // to anchor on the announcement button to force a specific order:
  // chasing announce's position triggers a fight with announce's own
  // idempotency logic (announce wants its nextSibling to be the span,
  // not us) which produces churn on every mutation tick.
  const horiz = findHorizontalRowAncestor(temp);
  if (horiz) {
    return { parent: horiz.parent, before: horiz.before, styleSource: temp };
  }
  return { parent: temp.parentElement, before: temp, styleSource: temp };
}

function removeAll(): void {
  document.querySelectorAll(`[${TAG}]`).forEach((b) => b.remove());
}

function injectIfNeeded(): void {
  if (!isTempModeActive()) {
    removeAll();
    return;
  }
  const anchor = findAnchor();
  if (!anchor) return;
  const { parent, before, styleSource } = anchor;

  // Idempotency: collapse any duplicates left by SPA route changes.
  const allExisting = Array.from(document.querySelectorAll<HTMLButtonElement>(`[${TAG}]`));
  if (allExisting.length > 0) {
    const survivor = allExisting[0];
    for (let i = 1; i < allExisting.length; i++) allExisting[i].remove();
    if (survivor.parentElement !== parent || survivor.nextSibling !== before) {
      try {
        parent.insertBefore(survivor, before);
      } catch {
        /* `before` detached — next mutation tick will retry. */
      }
    }
    return;
  }

  const btn = document.createElement('button');
  btn.className = `${styleSource.className || ''} gv-temp-regret-btn`.trim();
  btn.type = 'button';
  btn.setAttribute(TAG, '1');
  const label = t('tempChatRegretButton');
  btn.setAttribute('aria-label', label);
  // `title` provides the native browser hover tooltip; richer styling
  // (multi-line) would be nice but ChatGPT's own header buttons also
  // use native `title` so this keeps the UX consistent.
  btn.title = t('tempChatRegretButtonTooltip');

  const icon = buildIcon();
  const labelEl = document.createElement('span');
  labelEl.className = 'gv-temp-regret-btn__label';
  labelEl.textContent = label;
  btn.replaceChildren(icon, labelEl);

  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void runTempChatRegret();
  });

  parent.insertBefore(btn, before);

  // Adapt to the actual row width. ChatGPT's right-cluster wrapper
  // (`#conversation-header-actions` and friends) sits inside an
  // `overflow-x-hidden` container — and on top of that, ChatGPT
  // started shipping their OWN labels on the temporary-chat toggle
  // ("临时聊天" / "Temporary chat"), which eats most of the available
  // pixels. If we don't fit, hide the label and fall back to icon-only
  // (the native `title` tooltip still carries the full explanation).
  // Re-evaluated on resize via a ResizeObserver on the row.
  applyLabelFit(btn);
  watchRowFit(btn);
}

/**
 * Hide our `<span>` label if our button can't comfortably fit inside
 * the row container (the parent flex row) alongside whatever else is
 * already in there. Threshold: keep the label if there's at least
 * 60px of *headroom* in the row after rendering with the label.
 */
function applyLabelFit(btn: HTMLElement): void {
  const labelEl = btn.querySelector<HTMLElement>('.gv-temp-regret-btn__label');
  if (!labelEl) return;
  // Temporarily ensure the label is visible so measurement reflects
  // the "with-label" footprint. After measuring we toggle the modifier
  // class based on overflow.
  btn.classList.remove('gv-temp-regret-btn--no-label');
  const row = btn.parentElement;
  if (!row) return;
  const overflow = row.scrollWidth - row.clientWidth;
  if (overflow > 0) {
    btn.classList.add('gv-temp-regret-btn--no-label');
  }
}

/**
 * Re-run the label-fit check when the row resizes (e.g. ChatGPT toggles
 * temp-mode banner or the user resizes the window). Cheap — only one
 * ResizeObserver per button, disconnected when the button leaves DOM.
 */
const fitObservers = new WeakMap<HTMLElement, ResizeObserver>();
function watchRowFit(btn: HTMLElement): void {
  const row = btn.parentElement;
  if (!row) return;
  if (fitObservers.has(btn)) fitObservers.get(btn)!.disconnect();
  const ro = new ResizeObserver(() => {
    if (!btn.isConnected) {
      ro.disconnect();
      fitObservers.delete(btn);
      return;
    }
    applyLabelFit(btn);
  });
  ro.observe(row);
  fitObservers.set(btn, ro);
}

let observer: MutationObserver | null = null;
let scheduled = false;

/**
 * Throttle injectIfNeeded to once per animation frame. ChatGPT does a
 * very high volume of body+subtree mutations (especially in temp mode,
 * where additional banner animations seem to push it past the budget),
 * and running our findAnchor / getComputedStyle / getBoundingClientRect
 * for EACH one was enough to freeze the main thread within seconds.
 * One run per frame is more than enough — the header doesn't change
 * that fast and any missed mutation gets re-checked on the next frame.
 */
function scheduleInject(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    try {
      injectIfNeeded();
    } catch (err) {
      console.warn('[GPT-Voyager] temp-regret inject failed', err);
    }
  });
}

export function startTempChatRegretButton(): void {
  injectIfNeeded();
  if (observer) return;
  observer = new MutationObserver(() => scheduleInject());
  observer.observe(document.body, { childList: true, subtree: true });
}

export function stopTempChatRegretButton(): void {
  observer?.disconnect();
  observer = null;
  removeAll();
}
