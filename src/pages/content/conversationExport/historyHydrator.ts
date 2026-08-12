import {
  type LiveConversationMessage,
  collectLiveConversationMessages,
} from '@/features/singleConvExport/liveSnapshot';

const DEFAULT_MAX_STEPS = 180;
const DEFAULT_SETTLE_DELAY_MS = 140;
const STABLE_TOP_PASSES = 2;

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
  const initialDistanceFromBottom = container.scrollHeight - container.clientHeight - initialTop;
  let stableTopPasses = 0;
  let previousCount = collected.size;
  let reachedTop = false;

  for (let step = 0; step < (options.maxSteps ?? DEFAULT_MAX_STEPS); step += 1) {
    const atTop = container.scrollTop <= 2;
    if (atTop && stableTopPasses >= STABLE_TOP_PASSES) {
      reachedTop = true;
      break;
    }

    if (!atTop) {
      const distance = Math.max(Math.floor(container.clientHeight * 0.82), 640);
      container.scrollTop = Math.max(0, container.scrollTop - distance);
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
    }

    await wait(options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS);
    const count = mergeCollected(collected, collect());
    options.onProgress?.({ discovered: count, step: step + 1 });

    if (container.scrollTop <= 2 && count === previousCount) stableTopPasses += 1;
    else stableTopPasses = 0;
    previousCount = count;
  }

  if (container.scrollTop <= 2 && stableTopPasses >= STABLE_TOP_PASSES) reachedTop = true;

  // Keep the export from unexpectedly abandoning the user's reading position.
  if (initialDistanceFromBottom <= Math.max(container.clientHeight, 1000)) {
    container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  } else {
    container.scrollTop = Math.min(
      initialTop,
      Math.max(0, container.scrollHeight - container.clientHeight),
    );
  }
  container.dispatchEvent(new Event('scroll', { bubbles: true }));

  return {
    messages: Array.from(collected.values()).sort((a, b) => a.order - b.order),
    reachedTop,
  };
}
