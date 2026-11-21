import {
  type LiveConversationMessage,
  collectLiveConversationMessages,
  readThreadTurnOrder,
  threadMessageOrder,
} from '@/features/singleConvExport/liveSnapshot';

import { findActiveConversationScrollContainer } from '../chatgptDom';

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
  /** Stops an export from scrolling after the user switches conversations. */
  isCurrent?: () => boolean;
  /** Explicit pass budget for testing or advanced callers. */
  maxJumpPasses?: number;
  maxIdleJumpPasses?: number;
  /** Identity of the oldest loaded native exchange, even if its row is virtualized. */
  oldestLoadedId?: () => string | null;
}

const DEFAULT_MAX_PAGING_TIME_MS = 5 * 60 * 1000;
const DEFAULT_MAX_IDLE_JUMP_PASSES = 25;

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

export function findConversationScrollContainer(): HTMLElement | null {
  return findActiveConversationScrollContainer();
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
      reachedTop: collected.size > 0 && !options.isComplete,
    };
  }

  const isCurrent = () =>
    (options.isCurrent?.() ?? true) &&
    (options.scrollContainer !== undefined || findConversationScrollContainer() === container);
  const ensureCurrent = () => {
    if (!isCurrent()) throw new DOMException('Conversation changed during export.', 'AbortError');
  };
  const initialTop = container.scrollTop;
  const initialHeight = container.scrollHeight;
  const initialDistanceFromBottom = Math.abs(scrollBounds(container).bottom - initialTop);
  const isAtTop = () => container.scrollTop <= scrollBounds(container).top + 2;
  let stableTopPasses = 0;
  let previousCount = collected.size;
  let previousHeight = container.scrollHeight;
  let reachedTop = false;

  try {
    ensureCurrent();
    if (options.isComplete) {
      const deadline = Date.now() + DEFAULT_MAX_PAGING_TIME_MS;
      const knownHeads = new Set<string>();
      const firstHead = options.oldestLoadedId?.();
      if (firstHead) knownHeads.add(firstHead);
      let idlePasses = 0;
      for (
        let pass = 0;
        pass < (options.maxJumpPasses ?? Infinity) && Date.now() < deadline;
        pass += 1
      ) {
        container.scrollTop = scrollBounds(container).top;
        container.dispatchEvent(new Event('scroll', { bubbles: true }));
        const height = container.scrollHeight;
        await wait(options.topSettleDelayMs ?? DEFAULT_TOP_SETTLE_DELAY_MS);
        ensureCurrent();
        const count = mergeCollected(collected, collect());
        options.onProgress?.({ discovered: count, step: pass + 1 });
        // A completed response can arrive before its rows/layout are committed.
        // Make one more pass if the page extended the scroller or moved us.
        if (options.isComplete() && isAtTop() && container.scrollHeight === height) {
          reachedTop = true;
          break;
        }
        const oldest = options.oldestLoadedId?.();
        if (oldest && !knownHeads.has(oldest)) {
          knownHeads.add(oldest);
          idlePasses = 0;
        } else if (++idlePasses >= (options.maxIdleJumpPasses ?? DEFAULT_MAX_IDLE_JUMP_PASSES)) {
          break;
        }
      }
    } else {
      for (let step = 0; step < (options.maxSteps ?? DEFAULT_MAX_STEPS); step += 1) {
        const atTop = isAtTop();
        if (atTop && stableTopPasses >= STABLE_TOP_PASSES) {
          reachedTop = true;
          break;
        }

        if (!atTop) {
          const distance = Math.max(Math.floor(container.clientHeight * 0.82), 640);
          container.scrollTop = Math.max(
            scrollBounds(container).top,
            container.scrollTop - distance,
          );
          container.dispatchEvent(new Event('scroll', { bubbles: true }));
        }

        await wait(
          isAtTop()
            ? (options.topSettleDelayMs ?? DEFAULT_TOP_SETTLE_DELAY_MS)
            : (options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS),
        );
        ensureCurrent();
        const count = mergeCollected(collected, collect());
        options.onProgress?.({ discovered: count, step: step + 1 });

        // A history page can expand the scroller before its rows mount.
        const height = container.scrollHeight;
        if (isAtTop() && count === previousCount && height === previousHeight) stableTopPasses += 1;
        else stableTopPasses = 0;
        previousCount = count;
        previousHeight = height;
      }

      if (isAtTop() && stableTopPasses >= STABLE_TOP_PASSES) reachedTop = true;
    }
  } finally {
    // Do not scroll a new conversation or a cached page after navigation.
    if (isCurrent()) {
      const bounds = scrollBounds(container);
      if (initialDistanceFromBottom <= 2) {
        container.scrollTop = bounds.bottom;
      } else if (bounds.bottom === 0 && bounds.top < 0) {
        // On column-reverse threads the same bottom-relative offset survives prepends.
        container.scrollTop = Math.max(bounds.top, initialTop);
      } else {
        const addedHeight = Math.max(0, container.scrollHeight - initialHeight);
        container.scrollTop = Math.min(initialTop + addedHeight, bounds.bottom);
      }
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  }

  // Rows mount and unmount while we scroll, so per-pass orders are not
  // comparable; re-rank by the final exchange order where it is known.
  const turnOrder = readThreadTurnOrder();
  const messages = Array.from(collected.values()).map((live) => {
    const order = threadMessageOrder(turnOrder, live.turnKey, live.message.role);
    return order === null ? live : { ...live, order };
  });
  return { messages: messages.sort((a, b) => a.order - b.order), reachedTop };
}
