/**
 * Megaphone button injected into ChatGPT's top-right control cluster.
 *
 * Position rule (verified live in 1.6.5):
 *   - In a conversation page (`/c/<uuid>`): ChatGPT shows a Share button
 *     with `data-testid="share-chat-button"`. Our 1.6.0 export button
 *     already injects to the LEFT of Share. We inject our announcement
 *     button to the LEFT of the export button (or the LEFT of Share if
 *     the export button hasn't mounted yet — the MutationObserver will
 *     fix the ordering on the next page tick).
 *
 *   - Outside a conversation (`/`, `/temporary-chat`, etc.): ChatGPT shows
 *     a "temporary chat" toggle icon top-right. We inject to its LEFT.
 *
 * Reusing ChatGPT's own button className gives us native styling for free
 * (padding, hover, border-radius, etc.). The MutationObserver covers
 * ChatGPT's SPA route changes — they tear down and re-mount the header
 * on every navigation, and our static injection wouldn't survive.
 */
const TAG = 'data-gv-announcement-btn';
const INDICATOR_CLASS = 'gv-announcement-btn__indicator';

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

function findAnchor(): { parent: HTMLElement; before: HTMLElement } | null {
  // In a conversation: anchor on the share button, but if our 1.6.0
  // export button (`data-gv-export-btn`) is to its left we anchor on
  // that instead so we end up further left.
  const share = document.querySelector<HTMLElement>('[data-testid="share-chat-button"]');
  if (share && share.parentElement) {
    const exportBtn = share.parentElement.querySelector<HTMLElement>('[data-gv-export-btn]');
    return { parent: share.parentElement, before: exportBtn ?? share };
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
  if (temp && temp.parentElement) {
    return { parent: temp.parentElement, before: temp };
  }
  return null;
}

function injectIfNeeded(): void {
  const anchor = findAnchor();
  if (!anchor) return;
  const { parent, before } = anchor;
  // Idempotency: don't re-inject. Also re-order if a competing element
  // ended up to our right (e.g. share button got remounted later).
  const existing = parent.querySelector<HTMLButtonElement>(`[${TAG}]`);
  if (existing) {
    if (existing.nextSibling !== before) parent.insertBefore(existing, before);
    return;
  }
  if (!onClickRef) return;

  // Clone styling from the anchor's sibling (share or temp button) so
  // we inherit ChatGPT-native padding/rounding/hover state. Fall back
  // to a minimal class set if there's nothing to clone.
  const styleSource =
    parent.querySelector<HTMLElement>('[data-testid="share-chat-button"]') ||
    parent.querySelector<HTMLElement>('[data-gv-export-btn]') ||
    before;
  const btn = document.createElement('button');
  btn.className = `${styleSource.className || ''} gv-announcement-btn`.trim();
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
}

export function applyUnreadState(unread: boolean): void {
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
