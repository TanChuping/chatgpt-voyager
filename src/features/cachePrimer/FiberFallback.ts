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
 *      unmounted cache miss, at most once per conversation until satisfied,
 *      throttled so a not-yet-ready store just gets retried on the next pass.
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

export interface FiberFallbackOptions {
  /** Bound conversation id (raw uuid or `gpt:conv:<uuid>` — both tolerated). */
  getConversationId: () => string | null;
  /** Invoked after ≥1 turn was filled, so the timeline can re-render. */
  onPrimed: () => void;
}

export interface FiberFallbackHandle {
  /**
   * Ask the page-world reader for fiber turns. No-op unless `hasUnmountedMiss`
   * is true and we haven't already satisfied (or very recently asked for) the
   * current conversation. Safe to call on every render pass.
   */
  requestIfNeeded(hasUnmountedMiss: boolean): void;
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
  let disposed = false;

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
    requestIfNeeded(hasUnmountedMiss: boolean): void {
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
        }
        if (!hasUnmountedMiss) return;
        const now = Date.now();
        // Start the grace clock on the first observed miss; don't fire yet.
        if (firstMissAt === 0) {
          firstMissAt = now;
          return;
        }
        if (now - firstMissAt < FIRST_REQUEST_GRACE_MS) return;
        if (fireCount >= MAX_REQUESTS_PER_CONV) return;
        if (now - lastFireAt < MIN_REQUEST_INTERVAL_MS) return;
        fireCount += 1;
        lastFireAt = now;
        window.postMessage({ __gvType: REQUEST_TYPE, convId: conv }, window.location.origin);
      } catch {
        /* transport unavailable — timeline keeps the "消息未加载" placeholder */
      }
    },
    dispose(): void {
      disposed = true;
      window.removeEventListener('message', onMessage);
    },
  };
}
