import { describe, expect, it } from 'vitest';

import { ConversationCaptureService, mergeConversationPage } from '../ConversationCaptureService';
import { walkMessagesPage } from '../conversationParser';
import type { ApiConversationPage, ConversationNodeMessage, LinearMessage } from '../types';

const id = (n: number) => `22222222-2222-2222-2222-${String(n).padStart(12, '0')}`;

function msg(n: number): ConversationNodeMessage {
  return {
    id: id(n),
    author: { role: n % 2 === 1 ? 'user' : 'assistant' },
    create_time: n,
    content: { content_type: 'text', parts: [`message ${n}`] },
  };
}

/** Messages `from..to` (inclusive), as the 2026-09 endpoints return them. */
function page(
  from: number,
  to: number,
  hasPrevious: boolean,
  title = 'Paged',
): ApiConversationPage {
  const messages: ConversationNodeMessage[] = [];
  for (let n = from; n <= to; n += 1) messages.push(msg(n));
  return {
    conversation_id: 'conv-paged',
    title,
    update_time: 100,
    messages,
    page_info: { start_cursor: id(from), end_cursor: id(to), has_previous_page: hasPrevious },
  };
}

const texts = (messages: readonly LinearMessage[]) => messages.map((m) => m.text);

describe('walkMessagesPage', () => {
  it('linearises a page in its chronological order', () => {
    const linear = walkMessagesPage(page(3, 6, true));
    expect(texts(linear.messages)).toEqual(['message 3', 'message 4', 'message 5', 'message 6']);
    expect(linear.messages[0].turnId).toBe(`u-${id(3)}`);
    expect(linear.title).toBe('Paged');
  });
});

describe('mergeConversationPage', () => {
  const lin = (from: number, to: number) => walkMessagesPage(page(from, to, true)).messages;

  it('puts an older page right in front of its cursor', () => {
    const merged = mergeConversationPage(lin(5, 8), lin(1, 4), { kind: 'before', before: id(5) });
    expect(texts(merged.messages)).toEqual(texts(lin(1, 8)));
    expect(merged.replacedHead).toBe(true);
  });

  it('lets a re-fetched latest page replace the tail from its first message on', () => {
    const edited = walkMessagesPage(page(5, 6, true)).messages.map((m, i) =>
      i === 1 ? { ...m, text: 'edited reply' } : m,
    );
    const merged = mergeConversationPage(lin(1, 8), edited, { kind: 'latest' });
    expect(texts(merged.messages)).toEqual([...texts(lin(1, 5)), 'edited reply']);
    expect(merged.replacedHead).toBe(false);
  });

  it('starts over when the latest page shares nothing with what was held', () => {
    const merged = mergeConversationPage(lin(1, 4), lin(9, 10), { kind: 'latest' });
    expect(texts(merged.messages)).toEqual(texts(lin(9, 10)));
    expect(merged.replacedHead).toBe(true);
  });
});

describe('ConversationCaptureService — paginated captures', () => {
  it('reports a capture incomplete until the first page has been seen', () => {
    const svc = new ConversationCaptureService();
    svc.ingest('conv-paged', page(5, 8, true), { kind: 'latest' });
    expect(svc.isComplete('conv-paged')).toBe(false);
    expect(svc.getLatest('conv-paged')?.messages).toHaveLength(4);

    svc.ingest('conv-paged', page(1, 4, false), { kind: 'before', before: id(5) });
    expect(svc.isComplete('conv-paged')).toBe(true);
    expect(texts(svc.getLatest('conv-paged')!.messages)).toEqual(
      Array.from({ length: 8 }, (_, i) => `message ${i + 1}`),
    );
  });

  it('keeps title and completeness when the latest page is re-fetched', () => {
    const svc = new ConversationCaptureService();
    svc.ingest('conv-paged', page(5, 8, true, 'Title'), { kind: 'latest' });
    svc.ingest(
      'conv-paged',
      { messages: page(1, 4, false).messages, page_info: { has_previous_page: false } },
      {
        kind: 'before',
        before: id(5),
      },
    );
    svc.ingest('conv-paged', page(5, 9, true, 'Title'), { kind: 'latest' });
    expect(svc.isComplete('conv-paged')).toBe(true);
    expect(svc.getLatest('conv-paged')?.title).toBe('Title');
    expect(svc.getLatest('conv-paged')?.messages).toHaveLength(9);
  });

  it('treats a page without a page kind as the latest page', () => {
    const svc = new ConversationCaptureService();
    const entry = svc.ingest('conv-paged', page(1, 2, false));
    expect(entry?.complete).toBe(true);
  });

  it('keeps full mapping captures complete', () => {
    const svc = new ConversationCaptureService();
    const entry = svc.ingest('conv-full', {
      conversation_id: 'conv-full',
      current_node: id(1),
      mapping: { [id(1)]: { id: id(1), message: msg(1), parent: null, children: [] } },
    });
    expect(entry?.complete).toBe(true);
    expect(svc.isComplete('conv-full')).toBe(true);
  });
});
