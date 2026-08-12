import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetConversationCaptureServiceForTests,
  getConversationCaptureService,
} from '@/features/conversationApi/ConversationCaptureService';
import type { ApiConversation } from '@/features/conversationApi/types';

import { enterSelectionMode, exitSelectionMode } from '../selectionMode';

const CONV_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function api(): ApiConversation {
  const user = '11111111-1111-1111-1111-111111111111';
  const assistant = '22222222-2222-2222-2222-222222222222';
  return {
    conversation_id: CONV_ID,
    title: 'Incremental selection',
    current_node: assistant,
    mapping: {
      [user]: {
        id: user,
        parent: null,
        children: [assistant],
        message: {
          id: user,
          author: { role: 'user' },
          create_time: 1,
          content: { content_type: 'text', parts: ['first'] },
        },
      },
      [assistant]: {
        id: assistant,
        parent: user,
        children: [],
        message: {
          id: assistant,
          author: { role: 'assistant' },
          create_time: 2,
          content: { content_type: 'text', parts: ['reply'] },
          channel: 'final',
        },
      },
    },
  };
}

function host(id: string, role: 'user' | 'assistant', text: string): HTMLElement {
  const wrapper = document.createElement('article');
  wrapper.dataset.testid = `conversation-turn-${document.querySelectorAll('article').length}`;
  wrapper.innerHTML = `<div data-message-id="${id}" data-message-author-role="${role}"><div class="${
    role === 'assistant' ? 'markdown' : 'whitespace-pre-wrap'
  }">${text}</div></div>`;
  return wrapper;
}

describe('incremental selection mode', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    __resetConversationCaptureServiceForTests();
    getConversationCaptureService().ingest(CONV_ID, api());
    document.body.append(
      host('11111111-1111-1111-1111-111111111111', 'user', 'first'),
      host('22222222-2222-2222-2222-222222222222', 'assistant', 'reply'),
    );
  });

  afterEach(() => {
    exitSelectionMode();
    document.body.innerHTML = '';
  });

  it('adds selectors for user-scrolled messages and keeps an active role policy', async () => {
    enterSelectionMode(CONV_ID);
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.gv-export-pick-bar__btn'),
    );
    expect(buttons).toHaveLength(6);
    buttons[2].click(); // user-only

    const newUserId = '33333333-3333-3333-3333-333333333333';
    const newAssistantId = '44444444-4444-4444-4444-444444444444';
    document.body.append(
      host(newUserId, 'user', 'later question'),
      host(newAssistantId, 'assistant', 'later answer'),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const userCheckbox = document.querySelector<HTMLButtonElement>(
      `[data-message-id="${newUserId}"] .gv-export-pick-checkbox`,
    );
    const assistantCheckbox = document.querySelector<HTMLButtonElement>(
      `[data-message-id="${newAssistantId}"] .gv-export-pick-checkbox`,
    );
    expect(userCheckbox?.dataset.selected).toBe('true');
    expect(assistantCheckbox?.dataset.selected).toBe('false');
    expect(getConversationCaptureService().getLatest(CONV_ID)?.messages).toHaveLength(4);
  });

  it('starts from mounted messages on a cold capture cache without scrolling', () => {
    exitSelectionMode();
    __resetConversationCaptureServiceForTests();
    enterSelectionMode(CONV_ID);
    expect(document.querySelectorAll('.gv-export-pick-checkbox')).toHaveLength(2);
    expect(getConversationCaptureService().getLatest(CONV_ID)?.messages).toHaveLength(2);
  });

  it('ignores content-only mutations inside an already mounted long message', async () => {
    const capture = getConversationCaptureService();
    enterSelectionMode(CONV_ID);
    const updateSpy = vi.spyOn(capture, 'updateLatest');
    const content = document.querySelector<HTMLElement>(
      '[data-message-author-role="assistant"] .markdown',
    )!;
    content.appendChild(document.createElement('span'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it.each([
    { buttonIndex: 0, expectedUser: 'true', expectedAssistant: 'true' },
    { buttonIndex: 3, expectedUser: 'false', expectedAssistant: 'true' },
  ])(
    'extends all/assistant policies to later messages',
    async ({ buttonIndex, expectedUser, expectedAssistant }) => {
      enterSelectionMode(CONV_ID);
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.gv-export-pick-bar__btn'),
      );
      buttons[buttonIndex].click();

      const newUserId = '55555555-5555-5555-5555-555555555555';
      const newAssistantId = '66666666-6666-6666-6666-666666666666';
      document.body.append(
        host(newUserId, 'user', 'new user'),
        host(newAssistantId, 'assistant', 'new assistant'),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(
        document.querySelector<HTMLButtonElement>(
          `[data-message-id="${newUserId}"] .gv-export-pick-checkbox`,
        )?.dataset.selected,
      ).toBe(expectedUser);
      expect(
        document.querySelector<HTMLButtonElement>(
          `[data-message-id="${newAssistantId}"] .gv-export-pick-checkbox`,
        )?.dataset.selected,
      ).toBe(expectedAssistant);
    },
  );
});
