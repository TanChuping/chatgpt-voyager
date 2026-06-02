import { describe, expect, it, vi } from 'vitest';

import { computeFingerprint } from '@/pages/content/timeline/turnTextCache';
import type { TurnTextCache, TurnTextCacheEntry } from '@/pages/content/timeline/turnTextCache';

import { ConversationCaptureService } from '../../conversationApi/ConversationCaptureService';
import type { ApiConversation, LinearMessage } from '../../conversationApi/types';
import {
  installCachePrimerForManager,
  normalizeTextForCache,
  primeCacheFromLinear,
  toAttachmentInfos,
} from '../CachePrimer';

function fakeCache(): TurnTextCache & {
  setSpy: ReturnType<typeof vi.fn>;
  pruneSpy: ReturnType<typeof vi.fn>;
  entries: Map<string, TurnTextCacheEntry>;
} {
  const entries = new Map<string, TurnTextCacheEntry>();
  const setSpy = vi.fn((entry: TurnTextCacheEntry) => {
    entries.set(entry.id, { ...entry });
  });
  const pruneSpy = vi.fn((liveIds: Set<string>) => {
    let removed = 0;
    for (const id of entries.keys()) {
      if (!liveIds.has(id)) {
        entries.delete(id);
        removed++;
      }
    }
    return removed;
  });
  return {
    setSpy,
    pruneSpy,
    entries,
    set: setSpy,
    get: (id: string) => entries.get(id),
    touch: vi.fn(),
    prune: pruneSpy,
    size: () => entries.size,
    setConversation: vi.fn(),
    getConversationId: vi.fn(() => 'conv-x'),
    flushSync: vi.fn(),
    clear: vi.fn(),
  } as unknown as TurnTextCache & {
    setSpy: ReturnType<typeof vi.fn>;
    pruneSpy: ReturnType<typeof vi.fn>;
    entries: Map<string, TurnTextCacheEntry>;
  };
}

function userMsg(
  turnId: string,
  text: string,
  attachments: { name: string }[] = [],
): LinearMessage {
  return {
    turnId,
    messageId: turnId.replace(/^u-/, ''),
    role: 'user',
    authorName: null,
    text,
    attachments,
    createTime: 0,
  };
}

describe('CachePrimer', () => {
  it('writes one entry per user turn with u- prefix', () => {
    const cache = fakeCache();
    const messages: LinearMessage[] = [
      userMsg('u-aaa', 'first user prompt'),
      {
        turnId: 'm-1',
        messageId: '1',
        role: 'assistant',
        authorName: null,
        text: 'assistant reply',
        attachments: [],
        createTime: 0,
      },
      userMsg('u-bbb', 'second user prompt'),
    ];
    const primed = primeCacheFromLinear(cache, messages);
    expect(primed).toBe(2);
    expect(cache.setSpy).toHaveBeenCalledTimes(2);
    expect(cache.entries.has('u-aaa')).toBe(true);
    expect(cache.entries.has('u-bbb')).toBe(true);
    expect(cache.entries.has('m-1')).toBe(false);
  });

  it('fingerprint of API-derived summary matches a live-DOM summary with same text + attachments', () => {
    const liveSummary = normalizeTextForCache('hi there, please solve this');
    const apiSummary = normalizeTextForCache('hi there,    please solve this'); // collapse whitespace
    const attachments = toAttachmentInfos([{ name: 'paper.pdf' }]);
    expect(liveSummary).toBe(apiSummary);
    const fpFromApi = computeFingerprint(apiSummary, attachments);
    const fpFromLive = computeFingerprint(liveSummary, attachments);
    expect(fpFromApi).toBe(fpFromLive);
  });

  it('strips "You said:" prefix to match live-DOM normalizeText output', () => {
    expect(normalizeTextForCache('You said: hello world')).toBe('hello world');
    expect(normalizeTextForCache('  You wrote   hello world  ')).toBe('hello world');
  });

  it('skips entries with empty summary and no attachments', () => {
    const cache = fakeCache();
    const primed = primeCacheFromLinear(cache, [userMsg('u-1', '')]);
    expect(primed).toBe(0);
    expect(cache.setSpy).not.toHaveBeenCalled();
  });

  it('keeps entries that only have attachments (no body text)', () => {
    const cache = fakeCache();
    const primed = primeCacheFromLinear(cache, [userMsg('u-1', '', [{ name: 'doc.pdf' }])]);
    expect(primed).toBe(1);
    expect(cache.entries.get('u-1')?.attachments[0]?.name).toBe('doc.pdf');
  });

  it('toAttachmentInfos classifies known extensions', () => {
    const infos = toAttachmentInfos([{ name: 'a.pdf' }, { name: 'b.docx' }, { name: 'c.zip' }]);
    expect(infos.map((i) => i.type)).toEqual(['pdf', 'doc', 'archive']);
  });

  it('prunes orphan turn-ids after writing (edit/branch invalidation)', () => {
    const cache = fakeCache();
    // Pre-seed with old turn IDs that simulate stale cached data from a
    // pre-edit conversation state.
    cache.entries.set('u-old1', {
      id: 'u-old1',
      summary: 'old',
      attachments: [],
      hasGeneratedImage: false,
      lastSeenAt: 0,
      fingerprint: computeFingerprint('old', []),
    });
    cache.entries.set('u-old2', {
      id: 'u-old2',
      summary: 'old2',
      attachments: [],
      hasGeneratedImage: false,
      lastSeenAt: 0,
      fingerprint: computeFingerprint('old2', []),
    });
    primeCacheFromLinear(cache, [userMsg('u-new1', 'new'), userMsg('u-new2', 'new2')]);
    expect(cache.entries.has('u-old1')).toBe(false);
    expect(cache.entries.has('u-old2')).toBe(false);
    expect(cache.entries.has('u-new1')).toBe(true);
    expect(cache.entries.has('u-new2')).toBe(true);
    expect(cache.pruneSpy).toHaveBeenCalledWith(new Set(['u-new1', 'u-new2']));
  });

  it('does NOT prune when linear has zero user turns (malformed API payload)', () => {
    const cache = fakeCache();
    cache.entries.set('u-existing', {
      id: 'u-existing',
      summary: 'keep me',
      attachments: [],
      hasGeneratedImage: false,
      lastSeenAt: 0,
      fingerprint: computeFingerprint('keep me', []),
    });
    primeCacheFromLinear(cache, []); // no messages
    expect(cache.entries.has('u-existing')).toBe(true);
    expect(cache.pruneSpy).not.toHaveBeenCalled();
  });

  // --- Fiber fallback options: { prune:false, fillMissingOnly:true } ---

  it('with prune:false, never prunes even when orphan turns exist', () => {
    const cache = fakeCache();
    cache.entries.set('u-keep', {
      id: 'u-keep',
      summary: 'pre-existing API snapshot',
      attachments: [],
      hasGeneratedImage: false,
      lastSeenAt: 0,
      fingerprint: computeFingerprint('pre-existing API snapshot', []),
    });
    const primed = primeCacheFromLinear(cache, [userMsg('u-new', 'fiber text')], {
      prune: false,
    });
    expect(primed).toBe(1);
    expect(cache.entries.has('u-new')).toBe(true);
    // The orphan must survive — fiber data must never delete good snapshots.
    expect(cache.entries.has('u-keep')).toBe(true);
    expect(cache.pruneSpy).not.toHaveBeenCalled();
  });

  it('with fillMissingOnly:true, does not overwrite an existing snapshot', () => {
    const cache = fakeCache();
    cache.entries.set('u-1', {
      id: 'u-1',
      summary: 'authoritative API text',
      attachments: [],
      hasGeneratedImage: false,
      lastSeenAt: 123,
      fingerprint: computeFingerprint('authoritative API text', []),
    });
    const primed = primeCacheFromLinear(
      cache,
      [userMsg('u-1', 'inferior fiber text'), userMsg('u-2', 'fiber gap fill')],
      { prune: false, fillMissingOnly: true },
    );
    // Only the missing turn is written; the cached one is left untouched.
    expect(primed).toBe(1);
    expect(cache.entries.get('u-1')?.summary).toBe('authoritative API text');
    expect(cache.entries.get('u-2')?.summary).toBe('fiber gap fill');
  });

  it('fiber combo fills gaps without touching existing entries or pruning', () => {
    const cache = fakeCache();
    cache.entries.set('u-a', {
      id: 'u-a',
      summary: 'A from API',
      attachments: [],
      hasGeneratedImage: false,
      lastSeenAt: 0,
      fingerprint: computeFingerprint('A from API', []),
    });
    const primed = primeCacheFromLinear(
      cache,
      [userMsg('u-a', 'A from fiber'), userMsg('u-b', 'B from fiber')],
      { prune: false, fillMissingOnly: true },
    );
    expect(primed).toBe(1);
    expect(cache.entries.get('u-a')?.summary).toBe('A from API');
    expect(cache.entries.get('u-b')?.summary).toBe('B from fiber');
    expect(cache.pruneSpy).not.toHaveBeenCalled();
    expect(cache.entries.size).toBe(2);
  });

  describe('installCachePrimerForManager', () => {
    function makeApi(convId: string, msgs: string[]): ApiConversation {
      const mapping: ApiConversation['mapping'] = {};
      let prev: string | undefined;
      for (let i = 0; i < msgs.length; i++) {
        const id = `${convId}-msg-${i}`;
        mapping[id] = {
          id,
          parent: prev,
          children: [],
          message: {
            id,
            author: { role: 'user' },
            content: { content_type: 'text', parts: [msgs[i]] },
            status: 'finished_successfully',
          } as ApiConversation['mapping'][string]['message'],
        };
        prev = id;
      }
      return {
        conversation_id: convId,
        title: 't',
        create_time: 0,
        update_time: 0,
        current_node: `${convId}-msg-${msgs.length - 1}`,
        mapping,
      };
    }

    it("ONLY primes when the captured convId matches the cache's bound conversation", () => {
      const cache = fakeCache();
      // Cache pretends to be bound to "conv-x"
      (cache as unknown as { getConversationId: () => string }).getConversationId = () => 'conv-x';
      const svc = new ConversationCaptureService();
      installCachePrimerForManager(cache, svc);

      // Capture for the WRONG conversation — must be ignored.
      svc.ingest('conv-other', makeApi('conv-other', ['unrelated 1', 'unrelated 2']));
      expect(cache.setSpy).not.toHaveBeenCalled();

      // Capture for the RIGHT conversation — primes.
      svc.ingest('conv-x', makeApi('conv-x', ['hello', 'world']));
      expect(cache.setSpy).toHaveBeenCalledTimes(2);
    });

    it('matches across the namespaced / raw-UUID format split (the regression that bit us)', () => {
      const cache = fakeCache();
      // TurnTextCache binds under the timeline's namespaced form…
      const uuid = '69ecf9a2-d5b4-83ea-a03c-80b3b2514998';
      (cache as unknown as { getConversationId: () => string }).getConversationId = () =>
        `gpt:conv:${uuid}`;
      const svc = new ConversationCaptureService();
      installCachePrimerForManager(cache, svc);

      // …but the capture service reports the raw UUID it pulled out of
      // the API URL. Primer must normalise both sides and still match.
      svc.ingest(uuid, makeApi('match', ['hello uuid']));
      expect(cache.setSpy).toHaveBeenCalledTimes(1);
    });
  });
});
