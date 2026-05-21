/**
 * Cache primer.
 *
 * Subscribes to the ConversationCaptureService. Every time a fresh
 * `/backend-api/conversation/<id>` payload lands, we walk the linear messages
 * and write a snapshot into the timeline's TurnTextCache for every USER turn.
 *
 * Why only user turns: TurnTextCache exists to keep the timeline dot tooltip
 * populated even when ChatGPT has virtualised the inner message body. Only
 * user turns get a tooltip — assistant turns are anchored by user-turn dots.
 *
 * Why fingerprint matching is delicate: TimelineManager re-fingerprints turns
 * on every reconcile pass via `computeFingerprint(summary, attachments)` where
 * `summary` is the output of `extractTurnText` (strips visually-hidden /
 * attachment tiles / chrome buttons / fork-injected UI, then collapses
 * whitespace via `normalizeText`). The API-derived text doesn't have any of
 * those, so we only need to run the same whitespace collapse + prefix-strip
 * step. If we ever diverge from the live DOM normalisation, 1.5.4's
 * edit-detection (which compares fingerprints to invalidate cached
 * snapshots) misfires. Worth testing carefully.
 */
import type { AttachmentInfo, AttachmentType } from '@/pages/content/timeline/attachments';
import { classifyByName } from '@/pages/content/timeline/attachments';
import type { TurnTextCache } from '@/pages/content/timeline/turnTextCache';
import { computeFingerprint } from '@/pages/content/timeline/turnTextCache';

import type { ConversationCaptureService } from '../conversationApi/ConversationCaptureService';
import type { LinearAttachment, LinearMessage } from '../conversationApi/types';

/**
 * Mirror of `TimelineManager.TURN_LABEL_PREFIXES`. KEEP IN SYNC.
 * Uses `\uXXXX` escapes to avoid editor-driven zero-width-char corruption.
 */
const TURN_LABEL_PREFIXES =
  /^[​‌‍‎‏﻿]*(?:you said|you wrote|user message|your prompt|you asked)[:\s]*/i;

/**
 * The same normalisation `TimelineManager.normalizeText` applies.
 *
 * KEEP IN SYNC with `src/pages/content/timeline/manager.ts` (the private
 * `normalizeText` method) — otherwise the API-derived fingerprint won't match
 * the live-DOM fingerprint and the edit-detection invalidates good caches.
 */
export function normalizeTextForCache(text: string | null | undefined): string {
  try {
    if (!text) return '';
    const collapsed = String(text).replace(/\s+/g, ' ').trim();
    return collapsed.replace(TURN_LABEL_PREFIXES, '');
  } catch {
    return '';
  }
}

/** Convert API attachments to the timeline's AttachmentInfo shape. */
export function toAttachmentInfos(attachments: ReadonlyArray<LinearAttachment>): AttachmentInfo[] {
  return attachments.map((a): AttachmentInfo => {
    const type: AttachmentType = classifyByName(a.name);
    return { name: a.name, type };
  });
}

export interface CachePrimerHandle {
  dispose: () => void;
}

/**
 * Extract the raw conversation UUID from whatever format the cache is
 * keyed in. TurnTextCache binds to the timeline's namespaced form
 * (`gpt:conv:<uuid>`); the page-world capture hook reports the raw
 * UUID it pulled out of `/backend-api/conversation/<uuid>`. We have to
 * normalise one to the other before comparing — keep the matcher
 * tolerant of both shapes so a future refactor of either side doesn't
 * silently re-introduce the namespace-mismatch bug.
 */
function normaliseConvIdForCompare(id: string | null | undefined): string | null {
  if (!id) return null;
  // Strip a leading `gpt:conv:` prefix if present.
  const m = /(?:^|:)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(id);
  if (m) return m[1].toLowerCase();
  return id.toLowerCase();
}

/**
 * Install the primer on a specific TimelineManager's turnTextCache. Returns
 * a handle whose `dispose()` unsubscribes from the capture service.
 *
 * IMPORTANT: only primes when the captured `convId` matches the cache's
 * currently-bound conversation. ChatGPT can fire `/backend-api/conversation/*`
 * for other conversations (sidebar prefetch, switching), and writing those
 * payloads into the active cache would corrupt it.
 *
 * The two sides use different conversation-id shapes — capture service
 * reports the raw UUID extracted from the API URL, while TurnTextCache
 * binds under the timeline's namespaced `gpt:conv:<uuid>` form — so we
 * normalise both before comparing.
 */
export function installCachePrimerForManager(
  turnTextCache: TurnTextCache,
  captureService: ConversationCaptureService,
): CachePrimerHandle {
  const off = captureService.on('captured', (convId, entry) => {
    const boundId = normaliseConvIdForCompare(turnTextCache.getConversationId());
    const captureId = normaliseConvIdForCompare(convId);
    if (!boundId || !captureId || boundId !== captureId) return;
    try {
      primeCacheFromLinear(turnTextCache, entry.linear.messages);
    } catch (err) {
      console.warn('[GPT-Voyager] cache primer failed', err);
    }
  });
  return { dispose: off };
}

/**
 * Walk a linear conversation and write a snapshot into the cache for every
 * user turn. Exposed for tests + for the "prime on read" path.
 *
 * After writing, prunes any cached turn-id that wasn't in this linear
 * conversation. This mirrors TimelineManager's edit-detection prune:
 * if the user edits a message, ChatGPT forks the conversation and assigns
 * fresh turn-ids to every subsequent turn — the old ids never appear in
 * the API response again. Pruning here means the timeline preview panel
 * never briefly shows orphan ghosts between the API capture landing and
 * the next DOM reconcile.
 *
 * The cache's own `prune` has a transient-empty-DOM guard, but it allows
 * normal pruning for a sane-sized linear set, which is what we have here.
 */
export function primeCacheFromLinear(
  turnTextCache: TurnTextCache,
  messages: ReadonlyArray<LinearMessage>,
): number {
  let primed = 0;
  const now = Date.now();
  const userTurnIds = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const summary = normalizeTextForCache(m.text);
    const attachments = toAttachmentInfos(m.attachments);
    if (!summary && attachments.length === 0) continue;
    const fingerprint = computeFingerprint(summary, attachments);
    turnTextCache.set({
      id: m.turnId,
      summary,
      attachments,
      hasGeneratedImage: false,
      lastSeenAt: now,
      fingerprint,
    });
    userTurnIds.add(m.turnId);
    primed++;
  }
  // Edit/branch invalidation. Only prune if we actually saw user turns
  // (a malformed API response with 0 user turns shouldn't wipe the cache).
  if (userTurnIds.size > 0) {
    turnTextCache.prune(userTurnIds);
  }
  return primed;
}
