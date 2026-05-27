/**
 * Megaphone button injected into ChatGPT's top-right control cluster.
 *
 * Position rule (verified live 1.6.5+):
 *   - In a conversation page (`/c/<uuid>`): ChatGPT shows a Share button
 *     with `data-testid="share-chat-button"`. Our 1.6.0 export button
 *     already injects to the LEFT of Share. We inject our announcement
 *     button to the LEFT of the export button (or the LEFT of Share if
 *     the export button hasn't mounted yet — the MutationObserver will
 *     fix the ordering on the next page tick).
 *
 *   - Outside a conversation (`/`, `/?temporary-chat=true`, etc.):
 *     ChatGPT shows a "temporary chat" toggle. Its IMMEDIATE parent is
 *     a `<span>` with `display: block` (1 child). If we insert our
 *     button as a sibling of the toggle inside that span, both buttons
 *     (each `display: flex`, hence block-level) stack vertically in
 *     block flow — which then doubles the cluster height to 72px and
 *     pushes the top button off-screen because the surrounding wrappers
 *     are `items-center` over the 52px header. So on the homepage we
 *     walk OUT of any wrappers that would force vertical stacking,
 *     until we land in a real horizontal flex row (the `flex items-
 *     center` div one level above the span), and insert there.
 *
 * Reusing ChatGPT's own button className gives us native styling for
 * free (padding, hover, border-radius). We clone from the *button*
 * itself (Share / temp-chat-toggle), never from the wrapper div we
 * insert into — wrapper utility classes copied onto a `<button>` can
 * disable pointer events or stretch the button into a full-viewport
 * click shield (1.6.5 regression).
 *
 * The MutationObserver covers ChatGPT's SPA route changes — they tear
 * down and re-mount the header on every navigation, and our static
 * injection wouldn't survive.
 */
const TAG = 'data-gv-announcement-btn';
const INDICATOR_CLASS = 'gv-announcement-btn__indicator';

/**
 * Last value passed to `applyUnreadState`. Held at module scope so that
 * when the button is destroyed and re-injected (e.g., when ChatGPT
 * remounts the header on SPA route change), the new button can be
 * created already carrying the correct `--unread` class without
 * having to wait on the next snapshot refresh. Pre-fix this caused
 * the red dot to "disappear" until the next visibilitychange / poll
 * tick fired applyUnreadState again.
 */
let currentUnread = false;

/**
 * Optional listener that fires when a fresh button has just been
 * injected into the DOM (NOT on relocate/reorder). Set by the
 * announcement bootstrap so it can:
 *  - reapply unread state (`applyUnreadState`) against the new node
 *  - retry `showBubbleFor` for any announcement that was pending
 *    because the button wasn't ready on the first snapshot evaluation
 *
 * Pre-fix the bootstrap relied on a 2.5s setTimeout for this retry —
 * which the user could navigate past, leaving `markBubbleShown` never
 * called and the bubble re-popping on every page load.
 */
type ButtonAvailableListener = () => void;
let buttonAvailableListener: ButtonAvailableListener | null = null;

export function setAnnouncementButtonAvailableListener(
  cb: ButtonAvailableListener | null,
): void {
  buttonAvailableListener = cb;
  // Fire immediately if a button is already in the DOM. Lets the
  // bootstrap recover state synchronously when it registers late
  // (e.g., feature-init ordering puts other modules ahead of us).
  if (cb && document.querySelector(`[${TAG}]`)) {
    try {
      cb();
    } catch (err) {
      console.warn('[GPT-Voyager] announcement button listener threw', err);
    }
  }
}

function buildMegaphoneIcon(): SVGSVGElement {
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
  // Megaphone shape — bell-ish silhouette
  const horn = document.createElementNS(xmlns, 'path');
  horn.setAttribute('d', 'M3 11v2a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1z');
  svg.appendChild(horn);
  const wave1 = document.createElementNS(xmlns, 'path');
  wave1.setAttribute('d', 'M15 7c1.5 1.5 1.5 8 0 10');
  svg.appendChild(wave1);
  const wave2 = document.createElementNS(xmlns, 'path');
  wave2.setAttribute('d', 'M18 4.5c3 3 3 12 0 15');
  svg.appendChild(wave2);
  return svg;
}

interface InjectArgs {
  label: string;
  onClick: () => void;
}

let onClickRef: (() => void) | null = null;
let labelRef = '';

interface Anchor {
  /** Container we insertBefore() into. */
  parent: HTMLElement;
  /** Direct child of `parent` we sit immediately to the LEFT of. */
  before: HTMLElement;
  /**
   * The actual native button to clone styling from (padding, hover,
   * border radius). Always a `<button>` — never a wrapper element,
   * which would otherwise pollute the megaphone with layout utility
   * classes (`absolute`, `inset-0`, etc.) and can turn it into a
   * fullscreen click shield (1.6.5 regression).
   */
  styleSource: HTMLElement;
}

/**
 * Return TRUE if appending a NEW `<button display:flex>` sibling into
 * `container` would lay out top-to-bottom (visual vertical stacking),
 * which we want to avoid because the surrounding header is only 52px
 * tall and the two stacked buttons (36px each) overflow above/below.
 *
 * Cases:
 *   - `display: flex` row → side-by-side (false)
 *   - `display: flex` column → stacked (true)
 *   - `display: block` (most common offender — that `<span>` wrapping
 *     the temp-chat toggle) → block-level children stack (true)
 *   - `display: inline-block` → block-level kids still stack (true)
 *   - `display: grid` → can't tell without measuring, treat as
 *     non-stacking to avoid walking too far
 */
function wouldStackVertically(container: HTMLElement): boolean {
  const cs = window.getComputedStyle(container);
  if (cs.display === 'flex' || cs.display === 'inline-flex') {
    return cs.flexDirection === 'column' || cs.flexDirection === 'column-reverse';
  }
  if (cs.display === 'grid' || cs.display === 'inline-grid') return false;
  // block / inline-block / list-item / flow-root / table-* — sibling
  // block-level children (our flex buttons are block-level) stack.
  // `inline` is the only safe one (children flow inline), but it's
  // unusual for a ChatGPT layout wrapper. Treat anything that isn't a
  // confirmed horizontal-row mode as stacking.
  if (cs.display === 'inline') return false;
  return true;
}

/**
 * Walk up the parent chain from `start` until we find an ancestor that
 * does NOT stack vertically — i.e. a real horizontal flex row. Returns
 * that ancestor + the direct child of it on the path back to `start`,
 * so the caller can `insertBefore(newBtn, that child)` and end up
 * immediately to the LEFT of the existing icon cluster.
 *
 * Bounded depth (5) + a width cap (≤ half viewport) so we don't drift
 * up into the page header row and land next to the model picker on
 * the opposite side.
 */
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

function findAnchor(): Anchor | null {
  // In a conversation: anchor on the share button, but if our 1.6.0
  // export button (`data-gv-export-btn`) is to its left we anchor on
  // that instead so we end up further left.
  const share = document.querySelector<HTMLElement>('[data-testid="share-chat-button"]');
  if (share && share.parentElement) {
    const exportBtn = share.parentElement.querySelector<HTMLElement>('[data-gv-export-btn]');
    return {
      parent: share.parentElement,
      before: exportBtn ?? share,
      styleSource: share,
    };
  }
  // Outside a conversation, find the temporary-chat toggle. ChatGPT
  // historically has used a few different `aria-label`s for this; we
  // match by data-testid first, then by an icon-button title containing
  // "temporary" / "临时".
  const temp =
    document.querySelector<HTMLElement>('[data-testid="temporary-chat-toggle"]') ||
    document.querySelector<HTMLElement>(
      '[aria-label*="emporary" i], [aria-label*="临时" i], [aria-label*="临" i]',
    );
  if (!temp || !temp.parentElement) return null;
  // Escape any wrapper that would force vertical stacking. On 2026-05
  // ChatGPT the immediate parent is a `<span display:block>` (1 child),
  // one level above is the `flex items-center` row we actually want.
  // styleSource is *always* the temp-chat button — wrapper classes
  // are never copied onto our `<button>`.
  const horiz = findHorizontalRowAncestor(temp);
  if (horiz) {
    return { parent: horiz.parent, before: horiz.before, styleSource: temp };
  }
  return { parent: temp.parentElement, before: temp, styleSource: temp };
}

function injectIfNeeded(): void {
  const anchor = findAnchor();
  if (!anchor) return;
  const { parent, before, styleSource } = anchor;
  // Idempotency. Use a GLOBAL query (not parent-scoped) so that if
  // ChatGPT remounted the header into a different subtree — or our
  // anchor logic now picks a different ancestor than it did last tick
  // — we relocate the existing button instead of leaking duplicates.
  const allExisting = Array.from(document.querySelectorAll<HTMLButtonElement>(`[${TAG}]`));
  if (allExisting.length > 0) {
    const survivor = allExisting[0];
    for (let i = 1; i < allExisting.length; i++) allExisting[i].remove();
    if (survivor.parentElement !== parent || survivor.nextSibling !== before) {
      try {
        parent.insertBefore(survivor, before);
      } catch {
        // `before` may have been detached between findAnchor and now —
        // ignore; the next mutation tick re-attempts with fresh refs.
      }
    }
    return;
  }
  if (!onClickRef) return;

  // Clone styling from a real `<button>` (never a wrapper div). See
  // the `Anchor.styleSource` doc for why this matters.
  const btn = document.createElement('button');
  // Apply the remembered unread state UP-FRONT so a freshly-injected
  // button (e.g., after ChatGPT remounts the header on SPA route
  // change) carries the right `--unread` class without needing the
  // bootstrap to re-call `applyUnreadState`. Pre-fix this caused the
  // dot to "disappear" until the next snapshot refresh.
  btn.className =
    `${styleSource.className || ''} gv-announcement-btn${currentUnread ? ' gv-announcement-btn--unread' : ''}`.trim();
  btn.type = 'button';
  btn.setAttribute(TAG, '1');
  btn.setAttribute('aria-label', labelRef);
  btn.title = labelRef;

  const icon = buildMegaphoneIcon();
  btn.appendChild(icon);

  // Indicator dot — toggled on/off via `applyUnreadState`.
  const dot = document.createElement('span');
  dot.className = INDICATOR_CLASS;
  dot.setAttribute('aria-hidden', 'true');
  btn.appendChild(dot);

  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClickRef?.();
  });

  parent.insertBefore(btn, before);

  // Notify the bootstrap that a fresh button is now available so it
  // can retry any pending bubble-show whose first attempt landed
  // before the header had finished mounting.
  if (buttonAvailableListener) {
    try {
      buttonAvailableListener();
    } catch (err) {
      console.warn('[GPT-Voyager] announcement button listener threw', err);
    }
  }
}

export function applyUnreadState(unread: boolean): void {
  currentUnread = unread;
  document.querySelectorAll<HTMLElement>(`[${TAG}]`).forEach((btn) => {
    btn.classList.toggle('gv-announcement-btn--unread', unread);
  });
}

let observer: MutationObserver | null = null;

export function startTopBarAnnouncementButton(args: InjectArgs): void {
  onClickRef = args.onClick;
  labelRef = args.label;
  injectIfNeeded();
  if (observer) return;
  observer = new MutationObserver(() => injectIfNeeded());
  observer.observe(document.body, { childList: true, subtree: true });
}

export function getButtonRect(): DOMRect | null {
  const btn = document.querySelector<HTMLElement>(`[${TAG}]`);
  return btn ? btn.getBoundingClientRect() : null;
}

export function getButtonElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${TAG}]`);
}

export function stopTopBarAnnouncementButton(): void {
  observer?.disconnect();
  observer = null;
  document.querySelectorAll<HTMLElement>(`[${TAG}]`).forEach((b) => b.remove());
  onClickRef = null;
}
