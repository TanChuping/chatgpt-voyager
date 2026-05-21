import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConversationCaptureService,
  __resetConversationCaptureServiceForTests,
  getConversationCaptureService,
} from '../ConversationCaptureService';
import type { ApiConversation } from '../types';

function makeApi(id: string): ApiConversation {
  const messageId = '11111111-1111-1111-1111-111111111111';
  return {
    conversation_id: id,
    title: 'Hi',
    create_time: 0,
    update_time: 0,
    current_node: messageId,
    mapping: {
      [messageId]: {
        id: messageId,
        message: {
          id: messageId,
          author: { role: 'user' },
          create_time: 0,
          content: { content_type: 'text', parts: ['hello'] },
        },
        parent: null,
        children: [],
      },
    },
  };
}

describe('ConversationCaptureService', () => {
  beforeEach(() => {
    __resetConversationCaptureServiceForTests();
  });

  it('ingests and exposes via getLatest', () => {
    const svc = new ConversationCaptureService();
    svc.ingest('conv-1', makeApi('conv-1'));
    const linear = svc.getLatest('conv-1');
    expect(linear).not.toBeNull();
    expect(linear?.messages[0].text).toBe('hello');
  });

  it('fires captured event once per ingest', () => {
    const svc = new ConversationCaptureService();
    const cb = vi.fn();
    svc.on('captured', cb);
    svc.ingest('conv-1', makeApi('conv-1'));
    svc.ingest('conv-2', makeApi('conv-2'));
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[0][0]).toBe('conv-1');
    expect(cb.mock.calls[1][0]).toBe('conv-2');
  });

  it('install() bridges from page-world postMessage to ingest()', async () => {
    const svc = new ConversationCaptureService();
    svc.install();
    // Drive the listener directly via a synthetic MessageEvent — JSDOM's
    // window.postMessage is async + same-origin semantics get awkward, and
    // the actual cross-world bridge is exercised in real Chrome anyway.
    // What we DO want to test: the handler correctly unwraps our payload
    // shape, filters by __gvType, and feeds ingest().
    const evt = new MessageEvent('message', {
      // Intentionally NOT setting `source` — production code shouldn't
      // depend on it (MV3 isolated world sees the page-world window as
      // `e.source`, not its own).
      origin: window.location.origin,
      data: {
        __gvType: 'gv-conv-captured',
        payload: { convId: 'conv-evt', data: makeApi('conv-evt') },
      },
    });
    window.dispatchEvent(evt);
    expect(svc.getLatest('conv-evt')?.id).toBe('conv-evt');
    svc.uninstall();
  });

  it('install() ignores messages with the wrong magic type', () => {
    const svc = new ConversationCaptureService();
    svc.install();
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'something-else', detail: { convId: 'nope' } },
      }),
    );
    expect(svc.getLatest('nope')).toBeNull();
    svc.uninstall();
  });

  it('returns same singleton across getConversationCaptureService() calls', () => {
    const a = getConversationCaptureService();
    const b = getConversationCaptureService();
    expect(a).toBe(b);
  });

  it('rejects malformed payloads', () => {
    const svc = new ConversationCaptureService();
    expect(svc.ingest('conv-1', null)).toBeNull();
    expect(svc.ingest('conv-1', { foo: 'bar' })).toBeNull();
    expect(svc.ingest('', makeApi('x'))).toBeNull();
  });

  it('unsubscribe handle removes listener', () => {
    const svc = new ConversationCaptureService();
    const cb = vi.fn();
    const off = svc.on('captured', cb);
    off();
    svc.ingest('conv-1', makeApi('conv-1'));
    expect(cb).not.toHaveBeenCalled();
  });
});
