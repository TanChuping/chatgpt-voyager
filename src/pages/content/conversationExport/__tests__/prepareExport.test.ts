import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetConversationCaptureServiceForTests,
  getConversationCaptureService,
} from '@/features/conversationApi/ConversationCaptureService';
import type { ApiConversation, LinearMessage } from '@/features/conversationApi/types';
import { collectLiveConversationMessages } from '@/features/singleConvExport/liveSnapshot';

import { hydrateConversationHistory } from '../historyHydrator';
import { prepareWholeConversationExport } from '../prepareExport';

vi.mock('../historyHydrator', async (importOriginal) => {
  const original = await importOriginal<typeof import('../historyHydrator')>();
  return { ...original, hydrateConversationHistory: vi.fn() };
});

const hydrateMock = vi.mocked(hydrateConversationHistory);
const CONV_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function api(count: number): ApiConversation {
  const mapping: ApiConversation['mapping'] = {};
  let parent: string | null = null;
  for (let index = 1; index <= count; index += 1) {
    const id = `11111111-1111-1111-1111-${String(index).padStart(12, '0')}`;
    mapping[id] = {
      id,
      parent,
      children: [],
      message: {
        id,
        author: { role: index % 2 === 0 ? 'assistant' : 'user' },
        create_time: index,
        content: { content_type: 'text', parts: [`message ${index}`] },
        channel: index % 2 === 0 ? 'final' : null,
      },
    };
    if (parent) mapping[parent].children.push(id);
    parent = id;
  }
  return {
    conversation_id: CONV_ID,
    title: 'Prepare export',
    update_time: count,
    current_node: parent || '',
    mapping,
  };
}

function mount(messages: Array<Pick<LinearMessage, 'messageId' | 'role' | 'text'>>): void {
  document.body.innerHTML = messages
    .map(
      (message, index) =>
        `<article data-testid="conversation-turn-${index}"><div data-message-id="${
          message.messageId
        }" data-message-author-role="${message.role}"><div class="${
          message.role === 'assistant' ? 'markdown' : 'whitespace-pre-wrap'
        }">${message.text}</div></div></article>`,
    )
    .join('');
}

describe('whole export preparation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    __resetConversationCaptureServiceForTests();
    hydrateMock.mockReset();
  });

  it('patches a short tail delta without loading to the top', async () => {
    const capture = getConversationCaptureService();
    capture.ingest(CONV_ID, api(18));
    const cached = capture.getLatest(CONV_ID)!;
    mount([
      ...cached.messages.slice(-3),
      {
        messageId: '11111111-1111-1111-1111-000000000019',
        role: 'user',
        text: 'message 19',
      },
      {
        messageId: '11111111-1111-1111-1111-000000000020',
        role: 'assistant',
        text: 'message 20',
      },
    ]);

    const prepared = await prepareWholeConversationExport(CONV_ID);
    expect(hydrateMock).not.toHaveBeenCalled();
    expect(prepared.messages.slice(-2).map((message) => message.text)).toEqual([
      'message 19',
      'message 20',
    ]);
  });

  it('loads to the top when all five live tail records disagree', async () => {
    const capture = getConversationCaptureService();
    capture.ingest(CONV_ID, api(18));
    const allCurrent = capture.getLatest(CONV_ID)!.messages.map((message) => ({ ...message }));
    for (let index = 19; index <= 23; index += 1) {
      allCurrent.push({
        ...allCurrent[index % 2],
        messageId: `11111111-1111-1111-1111-${String(index).padStart(12, '0')}`,
        turnId: `u-11111111-1111-1111-1111-${String(index).padStart(12, '0')}`,
        role: index % 2 === 0 ? 'assistant' : 'user',
        text: `message ${index}`,
      });
    }
    mount(allCurrent.slice(-5));
    hydrateMock.mockResolvedValue({
      messages: collectLiveConversationMessages(),
      reachedTop: true,
    });

    await prepareWholeConversationExport(CONV_ID);
    expect(hydrateMock).toHaveBeenCalledTimes(1);
  });
});
