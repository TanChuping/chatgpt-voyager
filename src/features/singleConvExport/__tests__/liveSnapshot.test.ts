import { beforeEach, describe, expect, it } from 'vitest';

import type { LinearConversation, LinearMessage } from '../../conversationApi/types';
import {
  collectLiveConversationMessages,
  mergeLiveConversationMessages,
  readThreadTurnOrder,
  reconcileExportTail,
} from '../liveSnapshot';

it('collects messages and their order only from the active app-shell page', () => {
  document.body.innerHTML = `
    <div data-app-shell-active-page="false" style="display:none"><main>
      <div data-gv-thread-anchor="old"></div>
      <div data-message-id="old" data-message-author-role="user">Old chat</div>
    </main></div>
    <div data-app-shell-active-page="true"><main>
      <div data-gv-thread-anchor="current"></div>
      <div data-message-id="current" data-message-author-role="user">Current chat</div>
    </main></div>`;
  expect(collectLiveConversationMessages().map((live) => live.message.messageId)).toEqual([
    'current',
  ]);
  expect([...readThreadTurnOrder().keys()]).toEqual(['current']);
  document.body.innerHTML = '';
});

it('does not collect a cached chat while no app-shell page is active', () => {
  document.body.innerHTML =
    '<div data-app-shell-active-page="false"><main><div data-message-id="old" data-message-author-role="user">Old chat</div></main></div>';
  expect(collectLiveConversationMessages()).toEqual([]);
  document.body.innerHTML = '';
});

function message(id: string, role: 'user' | 'assistant', text: string): LinearMessage {
  return {
    turnId: id,
    messageId: id,
    role,
    authorName: null,
    text,
    attachments: [],
    createTime: null,
    contentType: 'text',
    channel: role === 'assistant' ? 'final' : null,
  };
}

function conversation(count: number): LinearConversation {
  return {
    id: 'conv',
    title: 'Export test',
    createTime: null,
    updateTime: null,
    messages: Array.from({ length: count }, (_, index) =>
      message(`m${index + 1}`, index % 2 === 0 ? 'user' : 'assistant', `message ${index + 1}`),
    ),
  };
}

function mount(messages: LinearMessage[]): void {
  document.body.innerHTML = messages
    .map(
      (item, index) => `
        <article data-testid="conversation-turn-${index}">
          <div data-message-id="${item.messageId}" data-message-author-role="${item.role}">
            <div class="${item.role === 'assistant' ? 'markdown' : 'whitespace-pre-wrap'}">${item.text}</div>
          </div>
        </article>`,
    )
    .join('');
}

describe('live export snapshot reconciliation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('uses the cache when the latest five live records are unchanged', () => {
    const cached = conversation(18);
    mount(cached.messages.slice(-5));
    const result = reconcileExportTail(cached, collectLiveConversationMessages());
    expect(result.kind).toBe('fresh');
    expect(result.unchangedAnchors).toBe(5);
  });

  it('patches a few appended records when an unchanged tail anchor remains', () => {
    const cached = conversation(18);
    const live = [
      ...cached.messages.slice(-3),
      message('m19', 'user', 'message 19'),
      message('m20', 'assistant', 'message 20'),
    ];
    mount(live);
    const collected = collectLiveConversationMessages();
    const result = reconcileExportTail(cached, collected);
    expect(result.kind).toBe('incremental');
    expect(result.changed.map((item) => item.message.messageId)).toEqual(['m19', 'm20']);

    const merged = mergeLiveConversationMessages(cached, collected);
    expect(merged.messages.slice(-2).map((item) => item.messageId)).toEqual(['m19', 'm20']);
  });

  it('patches a modified record when surrounding records still agree', () => {
    const cached = conversation(18);
    const live = cached.messages.slice(-5).map((item) => ({ ...item }));
    live[3] = { ...live[3], text: 'edited message 17' };
    mount(live);
    const collected = collectLiveConversationMessages();
    const result = reconcileExportTail(cached, collected);
    expect(result.kind).toBe('incremental');
    expect(result.changed.map((item) => item.message.messageId)).toEqual(['m17']);
    expect(mergeLiveConversationMessages(cached, collected).messages[16].text).toBe(
      'edited message 17',
    );
  });

  it('requires a rebuild when all five live tail records disagree', () => {
    const cached = conversation(18);
    const live = Array.from({ length: 5 }, (_, index) =>
      message(`m${19 + index}`, index % 2 === 0 ? 'user' : 'assistant', `message ${19 + index}`),
    );
    mount(live);
    const result = reconcileExportTail(cached, collectLiveConversationMessages());
    expect(result.kind).toBe('rebuild');
    expect(result.unchangedAnchors).toBe(0);
    expect(result.sharedIdAnchors).toBe(0);
  });

  it('patches same-id rendered text differences instead of falsely rebuilding', () => {
    const cached = conversation(18);
    const live = cached.messages.slice(-5).map((item) => ({
      ...item,
      text: `rendered ${item.text} without markdown punctuation`,
    }));
    mount(live);

    const result = reconcileExportTail(cached, collectLiveConversationMessages());

    expect(result.kind).toBe('incremental');
    expect(result.unchangedAnchors).toBe(0);
    expect(result.sharedIdAnchors).toBe(5);
    expect(result.changed).toHaveLength(5);
  });
});
