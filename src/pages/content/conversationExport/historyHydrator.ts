import {
  type LiveConversationMessage,
  collectLiveConversationMessages,
  readThreadTurnOrder,
  threadMessageOrder,
} from '@/features/singleConvExport/liveSnapshot';

const DEFAULT_MAX_STEPS = 180;
const DEFAULT_SETTLE_DELAY_MS = 140;
const STABLE_TOP_PASSES = 2;
/**
 * ChatGPT 2026-09 fetches older history over the network once the top is
 * reached (a spinner shows meanwhile), so "nothing new appeared" only means
 * "reached the first message" after a network-sized wait.
 */
const DEFAULT_TOP_SETTLE_DELAY_MS = 900;

export interface HistoryHydrationProgress {
  discovered: number;
  step: number;
}

export interface HistoryHydrationResult {
  messages: LiveConversationMessage[];
  reachedTop: boolean;
}

export interface HistoryHydrationOptions {
  maxSteps?: number;
  settleDelayMs?: number;
  onProgress?: (progress: HistoryHydrationProgress) => void;
  scrollContainer?: HTMLElement | null;
  collect?: () => LiveConversationMessage[];
  wait?: (delayMs: number) => Promise<void>;
  /** Wait used while parked at the top for a history page (defaults to 900 ms). */
  topSettleDelayMs?: number;
  /**
   * 2026-09 paginated capture: when given, the hydrator jumps straight to the
   * top and waits for ChatGPT to page history in until this reports true,
   * instead of walking the thread a screen at a time (a long conversation is
   * far taller than the step budget, and the capture — not the mounted rows —
   * is what the export reads).
   */
  isComplete?: () => boolean;
  /** Upper bound on jump-to-top passes in that mode (defaults to 60). */
  maxJumpPasses?: number;
}

const DEFAULT_MAX_JUMP_PASSES = 60;

/**
 * scrollTop range. The 2026-09 thread scroller is `flex-direction:
 * column-reverse`: 0 is the BOTTOM and the top is -(scrollHeight - clientHeight).
 */
function scrollBounds(container: HTMLElement): { top: number; bottom: number } {
  const range = Math.max(0, container.scrollHeight - container.clientHeight);
  let reversed = false;
  try {
    reversed = getComputedStyle(container).flexDirection === 'column-reverse';
  } catch {
    /* test env */
  }
  return reversed ? { top: -range, bottom: 0 } : { top: 0, bottom: range };
}

function isScrollable(element: HTMLElement): boolean {
  if (element.scrollHeight <= element.clientHeight + 80) return false;
  const overflowY = getComputedStyle(element).overflowY;
  return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
}

export function findConversationScrollContainer(): HTMLElement | null {
  const message = document.querySelector<HTMLElement>(
    '[data-message-id][data-message-author-role]',
  );
  let parent = message?.parentElement ?? null;
  while (parent && parent !== document.body) {
    if (isScrollable(parent)) return parent;
    parent = parent.parentElement;
  }

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'main, [data-testid="conversation-turns"], [class*="scroll"], [class*="overflow-y-auto"]',
    ),
  );
  return candidates.find(isScrollable) ?? (document.scrollingElement as HTMLElement | null);
}

function mergeCollected(
  target: Map<string, LiveConversationMessage>,
  messages: LiveConversationMessage[],
): number {
  for (const message of messages) target.set(message.message.messageId, message);
  return target.size;
}

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

/**
 * Whole-export-only hydrator. It progressively moves upward and yields between
 * steps so ChatGPT can virtualise/reuse rows without one giant synchronous
 * layout pass. Selection mode must never call this function.
 */
export async function hydrateConversationHistory(
  options: HistoryHydrationOptions = {},
): Promise<HistoryHydrationResult> {
  const collect = options.collect ?? (() => collectLiveConversationMessages());
  const wait = options.wait ?? defaultWait;
  const container = options.scrollContainer ?? findConversationScrollContainer();
  const collected = new Map<string, LiveConversationMessage>();
  mergeCollected(collected, collect());

  if (!container) {
    return {
      messages: Array.from(collected.values()).sort((a, b) => a.order - b.order),
      reachedTop: true,
    };
  }

  const initialTop = container.scrollTop;
  const initialDistanceFromBottom = Math.abs(scrollBounds(container).bottom - initialTop);
  const isAtTop = () => container.scrollTop <= scrollBounds(container).top + 2;
  let stableTopPasses = 0;
  let previousCount = collected.size;
  let previousHeight = container.scrollHeight;
  let reachedTop = false;

  if (options.isComplete) {
    for (let pass = 0; pass < (options.maxJumpPasses ?? DEFAULT_MAX_JUMP_PASSES); pass += 1) {
      if (options.isComplete()) {
        reachedTop = true;
        break;
      }
      container.scrollTop = scrollBounds(container).top;
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
      await wait(options.topSettleDelayMs ?? DEFAULT_TOP_SETTLE_DELAY_MS);
      const count = mergeCollected(collected, collect());
      options.onProgress?.({ discovered: count, step: pass + 1 });
      const height = container.scrollHeight;
      if (count === previousCount && height === previousHeight) stableTopPasses += 1;
      else stableTopPasses = 0;
      previousCount = count;
      previousHeight = height;
      // Nothing new for a while at the very top: ChatGPT has no more pages.
      if (stableTopPasses >= STABLE_TOP_PASSES + 2) break;
    }
    if (options.isComplete()) reachedTop = true;
  }

  for (
    let step = 0;
    !options.isComplete && step < (options.maxSteps ?? DEFAULT_MAX_STEPS);
    step += 1
  ) {
    const atTop = isAtTop();
    if (atTop && stableTopPasses >= STABLE_TOP_PASSES) {
      reachedTop = true;
      break;
    }

    if (!atTop) {
      const distance = Math.max(Math.floor(container.clientHeight * 0.82), 640);
      container.scrollTop = Math.max(scrollBounds(container).top, container.scrollTop - distance);
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
    }

    await wait(
      isAtTop()
        ? (options.topSettleDelayMs ?? DEFAULT_TOP_SETTLE_DELAY_MS)
        : (options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS),
    );
    const count = mergeCollected(collected, collect());
    options.onProgress?.({ discovered: count, step: step + 1 });

    // A history page landing above grows the scroller even before its rows
    // are collected; that is not "stable at the top".
    const height = container.scrollHeight;
    if (isAtTop() && count === previousCount && height === previousHeight) stableTopPasses += 1;
    else stableTopPasses = 0;
    previousCount = count;
    previousHeight = height;
  }

  if (!options.isComplete && isAtTop() && stableTopPasses >= STABLE_TOP_PASSES) reachedTop = true;

  // Keep the export from unexpectedly abandoning the user's reading position.
  const bounds = scrollBounds(container);
  if (initialDistanceFromBottom <= Math.max(container.clientHeight, 1000)) {
    container.scrollTop = bounds.bottom;
  } else if (bounds.bottom === 0 && bounds.top < 0) {
    // column-reverse: scrollTop is measured from the bottom, so the old value
    // still points at the same content after older pages were prepended.
    container.scrollTop = Math.max(bounds.top, initialTop);
  } else {
    container.scrollTop = Math.min(initialTop, bounds.bottom);
  }
  container.dispatchEvent(new Event('scroll', { bubbles: true }));

  // Rows mount and unmount while we scroll, so per-pass orders are not
  // comparable; re-rank by the final exchange order where it is known.
  const turnOrder = readThreadTurnOrder();
  const messages = Array.from(collected.values()).map((live) => {
    const order = threadMessageOrder(turnOrder, live.turnKey, live.message.role);
    return order === null ? live : { ...live, order };
  });
  return { messages: messages.sort((a, b) => a.order - b.order), reachedTop };
}
