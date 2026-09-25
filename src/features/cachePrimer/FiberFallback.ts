/**
 * React-fiber fallback (content-script side).
 *
 * Companion to `pageWorld/fiberReader.ts`. The page-world reader walks
 * ChatGPT's React fiber to recover user-turn text for conversations opened
 * from the client cache (where no `/backend-api/conversation` fetch fires, so
 * the normal {@link installCachePrimerForManager} capture path never runs and
 * virtualised turns show "消息未加载").
 *
 * This side:
 *   1. Asks the reader for fiber turns — only when the timeline actually has an
 *      unmounted cache miss, a few times per conversation until satisfied,
 *      throttled so a not-yet-ready store just gets retried on the next pass.
 *      Wrappers it has never asked about re-arm one more read: ChatGPT pages
 *      older history in as the user scrolls up, long after the first reads.
 *   2. On a reply, validates it belongs to the bound conversation, then primes
 *      the TurnTextCache in *fill-only* mode: never prune, never overwrite the
 *      authoritative API-derived snapshot — fiber only fills genuine gaps.
 *   3. Triggers a re-render so the freshly-filled dots stop saying "消息未加载".
 *
 * The transport is `window.postMessage` (Chrome bridges it between the MAIN
 * and isolated worlds), mirroring the `gv-conv-captured` channel.
 */
import type { TurnTextCache } from '@/pages/content/timeline/turnTextCache';

import { withTurnIdPrefix } from '../conversationApi/types';
import type { LinearMessage } from '../conversationApi/types';
import { normaliseConvIdForCompare, primeCacheFromLinear } from './CachePrimer';

const REQUEST_TYPE = 'gv-fiber-request';
const RESULT_TYPE = 'gv-fiber-result';
/** Min gap between requests, so we don't spam the reader while it hydrates. */
const MIN_REQUEST_INTERVAL_MS = 1500;
/**
 * Wait this long after the FIRST unmounted miss before asking fiber, giving the
 * conversation a moment to hydrate and the (preferred) API capture a chance to
 * fill the gap first. Fiber is the fallback, not the front-runner.
 */
const FIRST_REQUEST_GRACE_MS = 1000;
/**
 * Cap requests per conversation. One shot isn't enough: an early read can land
 * before ChatGPT has populated the fiber and return almost nothing, while more
 * turns virtualize as the thread finishes hydrating — so we allow a few
 * throttled retries while misses remain, then stop (no infinite churn).
 */
const MAX_REQUESTS_PER_CONV = 3;
/**
 * Slack added to a recheck timer so it lands after the grace / throttle window
 * it waited out, not a clock tick before it (which would just defer again).
 */
const RECHECK_SLACK_MS = 20;

export interface FiberFallbackOptions {
  /** Bound conversation id (raw uuid or `gpt:conv:<uuid>` — both tolerated). */
  getConversationId: () => string | null;
  /** Invoked after ≥1 turn was filled, so the timeline can re-render. */
  onPrimed: () => void;
  /**
   * Invoked once a request deferred by the grace / throttle window may fire,
   * so the timeline reconciles and calls {@link FiberFallbackHandle.requestIfNeeded}
   * with current state. Without it a deferred request waits for an unrelated
   * DOM mutation, and a settled thread may never produce one.
   */
  onRecheckDue?: () => void;
}

export interface FiberFallbackHandle {
  /**
   * Ask the page-world reader for fiber turns. No-op unless `hasUnmountedMiss`
   * is true and we haven't already satisfied (or very recently asked for) the
   * current conversation. Safe to call on every render pass.
   *
   * `unresolvedTurnIds` are the virtualised wrappers the timeline couldn't
   * classify on this pass. One we haven't asked about yet earns another read
   * even after the per-conversation budget is spent.
   */
  requestIfNeeded(hasUnmountedMiss: boolean, unresolvedTurnIds?: readonly string[]): void;
  dispose(): void;
}

interface FiberResultTurn {
  id: string;
  text: string;
}

function isResultTurn(v: unknown): v is FiberResultTurn {
  if (v === null || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return typeof t.id === 'string' && typeof t.text === 'string';
}

export function installFiberFallbackForManager(
  turnTextCache: TurnTextCache,
  options: FiberFallbackOptions,
): FiberFallbackHandle {
  // Per-conversation request budget (see constants above).
  let convKey: string | null = null;
  let firstMissAt = 0;
  let fireCount = 0;
  let lastFireAt = 0;
  // Unresolved wrapper ids already present when a request fired. Assistant
  // wrappers never resolve (fiber only returns user turns), so without this a
  // long thread would look "newly missing" on every pass.
  let askedIds = new Set<string>();
  let recheckTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearRecheck = (): void => {
    if (recheckTimer === null) return;
    clearTimeout(recheckTimer);
    recheckTimer = null;
  };

  const scheduleRecheck = (delayMs: number): void => {
    if (!options.onRecheckDue) return;
    clearRecheck();
    recheckTimer = setTimeout(() => {
      recheckTimer = null;
      if (disposed) return;
      try {
        options.onRecheckDue?.();
      } catch {
        /* the timeline's own reconcile path handles its errors */
      }
    }, delayMs + RECHECK_SLACK_MS);
  };

  const onMessage = (ev: MessageEvent): void => {
    try {
      if (disposed || ev.source !== window) return;
      const data = ev.data as Record<string, unknown> | null;
      if (!data || data.__gvType !== RESULT_TYPE) return;
      const payload = data.payload as Record<string, unknown> | null;
      if (!payload) return;

      const boundConvId = normaliseConvIdForCompare(options.getConversationId());
      if (!boundConvId) return;
      const resultConvId = normaliseConvIdForCompare(
        typeof payload.convId === 'string' ? payload.convId : null,
      );
      // Reject stale results (user navigated away since the request fired).
      if (resultConvId && resultConvId !== boundConvId) return;

      const rawTurns = Array.isArray(payload.turns) ? payload.turns : [];
      const messages: LinearMessage[] = rawTurns.filter(isResultTurn).map((t) => ({
        turnId: withTurnIdPrefix(t.id),
        messageId: t.id,
        role: 'user' as const,
        text: t.text,
        attachments: [],
        createTime: null,
      }));
      if (messages.length === 0) return;

      const primed = primeCacheFromLinear(turnTextCache, messages, {
        prune: false,
        fillMissingOnly: true,
      });
      // Re-render if we filled anything. We deliberately do NOT mark the
      // conversation permanently "done" here — an early/partial fiber read may
      // have filled only a few turns while others are still unmounted; the next
      // reconcile re-evaluates and may request again (bounded by the per-conv
      // budget) until no misses remain.
      if (primed > 0) options.onPrimed();
    } catch (err) {
      console.warn('[GPT-Voyager] fiber fallback prime failed', err);
    }
  };

  window.addEventListener('message', onMessage);

  return {
    requestIfNeeded(hasUnmountedMiss: boolean, unresolvedTurnIds: readonly string[] = []): void {
      try {
        if (disposed) return;
        const conv = normaliseConvIdForCompare(options.getConversationId());
        if (!conv) return;
        // Reset the budget when the bound conversation changes.
        if (conv !== convKey) {
          convKey = conv;
          firstMissAt = 0;
          fireCount = 0;
          lastFireAt = 0;
          askedIds = new Set();
          clearRecheck();
        }
        if (!hasUnmountedMiss) return;
        const now = Date.now();
        // ChatGPT loads long threads a page at a time as the user scrolls up,
        // and an older page's turns are virtualised again before the deferred
        // reconcile sees them mounted. Those wrappers didn't exist when the
        // early reads ran, so a spent budget must not leave them unresolved
        // for good: grant one more read. Each id can do this only once.
        const hasNewMiss = unresolvedTurnIds.some((id) => !askedIds.has(id));
        if (hasNewMiss && fireCount >= MAX_REQUESTS_PER_CONV) {
          fireCount = MAX_REQUESTS_PER_CONV - 1;
        }
        // Start the grace clock on the first observed miss; don't fire yet.
        if (firstMissAt === 0) firstMissAt = now;
        if (fireCount >= MAX_REQUESTS_PER_CONV) return;
        const wait = Math.max(
          firstMissAt + FIRST_REQUEST_GRACE_MS - now,
          lastFireAt ? lastFireAt + MIN_REQUEST_INTERVAL_MS - now : 0,
        );
        if (wait > 0) {
          // Make sure a read someone is waiting on actually happens. Plain
          // retries stay opportunistic (next reconcile pass), as before.
          if (fireCount === 0 || hasNewMiss) scheduleRecheck(wait);
          return;
        }
        clearRecheck();
        fireCount += 1;
        lastFireAt = now;
        for (const id of unresolvedTurnIds) askedIds.add(id);
        window.postMessage({ __gvType: REQUEST_TYPE, convId: conv }, window.location.origin);
      } catch {
        /* transport unavailable — timeline keeps the "消息未加载" placeholder */
      }
    },
    dispose(): void {
      disposed = true;
      clearRecheck();
      window.removeEventListener('message', onMessage);
    },
  };
}
