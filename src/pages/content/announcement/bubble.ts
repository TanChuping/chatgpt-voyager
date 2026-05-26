/**
 * Non-blocking WeChat-style speech bubble that drops down from the
 * megaphone button when a new announcement is detected. Deliberately
 * lightweight: no backdrop, no focus trap, no animations that
 * interrupt the user's reading flow.
 *
 * Position: anchored to the bottom-center of the megaphone button. If
 * the button is too close to the right edge of the viewport, we shift
 * the bubble leftward and slide the arrow tail proportionally so it
 * still points at the button. Recomputed on window resize.
 *
 * Lifecycle is owned by the caller (the announcement index module):
 *  - `mountBubble({ … })` — show it now, returns a handle
 *  - handle.destroy()     — close it (called by × click and by
 *                           markSeen propagation across tabs)
 */
const BUBBLE_CLASS = 'gv-announcement-bubble';
const SUMMARY_TRUNCATE = 90;

export interface BubbleHandle {
  destroy: () => void;
  /** Re-position relative to the anchor (call on window resize). */
  reposition: () => void;
}

export interface MountBubbleArgs {
  anchor: HTMLElement;
  title: string;
  summary: string;
  detailLabel: string;
  closeLabel: string;
  onDetail: () => void;
  onClose: () => void;
}

function truncate(input: string, max: number): string {
  if (!input) return '';
  const trimmed = input.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}

export function mountBubble(args: MountBubbleArgs): BubbleHandle {
  // Remove any previous bubble before mounting a fresh one.
  document.querySelectorAll<HTMLElement>(`.${BUBBLE_CLASS}`).forEach((b) => b.remove());

  const root = document.createElement('div');
  root.className = BUBBLE_CLASS;
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');

  const arrow = document.createElement('span');
  arrow.className = `${BUBBLE_CLASS}__arrow`;
  root.appendChild(arrow);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = `${BUBBLE_CLASS}__close`;
  closeBtn.setAttribute('aria-label', args.closeLabel);
  closeBtn.title = args.closeLabel;
  closeBtn.textContent = '×';
  root.appendChild(closeBtn);

  const titleEl = document.createElement('div');
  titleEl.className = `${BUBBLE_CLASS}__title`;
  titleEl.textContent = args.title;
  root.appendChild(titleEl);

  const summaryEl = document.createElement('div');
  summaryEl.className = `${BUBBLE_CLASS}__summary`;
  summaryEl.textContent = truncate(args.summary, SUMMARY_TRUNCATE);
  root.appendChild(summaryEl);

  const detailBtn = document.createElement('button');
  detailBtn.type = 'button';
  detailBtn.className = `${BUBBLE_CLASS}__detail`;
  detailBtn.textContent = args.detailLabel;
  root.appendChild(detailBtn);

  document.body.appendChild(root);

  function reposition() {
    if (!root.isConnected) return;
    const rect = args.anchor.getBoundingClientRect();
    // Bubble width is set by CSS (max-content cap). Read its current
    // width after mount.
    const bubbleRect = root.getBoundingClientRect();
    const bubbleWidth = bubbleRect.width || 280;
    const buttonCenter = rect.left + rect.width / 2;
    const viewportPadding = 12;
    let left = buttonCenter - bubbleWidth / 2;
    if (left + bubbleWidth + viewportPadding > window.innerWidth) {
      left = window.innerWidth - bubbleWidth - viewportPadding;
    }
    if (left < viewportPadding) left = viewportPadding;
    const top = rect.bottom + 10;
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
    // Arrow horizontal position relative to the bubble.
    const arrowLeft = buttonCenter - left;
    arrow.style.left = `${Math.round(arrowLeft)}px`;
  }

  // Initial layout — wait one frame so the browser has measured the
  // bubble's actual content width.
  requestAnimationFrame(reposition);

  const onResize = () => reposition();
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('scroll', onResize, { passive: true });

  function destroy() {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onResize);
    root.remove();
  }

  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    destroy();
    args.onClose();
  });
  detailBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    destroy();
    args.onDetail();
  });

  return { destroy, reposition };
}
