import { describe, expect, it, vi } from 'vitest';

import type { LiveConversationMessage } from '@/features/singleConvExport/liveSnapshot';

import { hydrateConversationHistory } from '../historyHydrator';

function live(id: string, order: number): LiveConversationMessage {
  return {
    host: document.createElement('div'),
    order,
    message: {
      turnId: id,
      messageId: id,
      role: order % 2 === 0 ? 'user' : 'assistant',
      authorName: null,
      text: id,
      attachments: [],
      createTime: null,
      contentType: 'text',
      channel: null,
    },
  };
}

describe('whole export history hydrator', () => {
  it('collects virtualised batches while moving upward and restores the bottom', async () => {
    const container = document.createElement('div');
    Object.defineProperties(container, {
      clientHeight: { value: 1000, configurable: true },
      scrollHeight: { value: 5000, configurable: true },
      scrollTop: { value: 4000, writable: true, configurable: true },
    });
    let batch = 0;
    const batches = [
      [live('m5', 5), live('m6', 6)],
      [live('m3', 3), live('m4', 4)],
      [live('m1', 1), live('m2', 2)],
    ];
    const collect = vi.fn(() => batches[Math.min(batch, batches.length - 1)]);
    const wait = vi.fn(async () => {
      batch += 1;
      if (batch >= 2) container.scrollTop = 0;
    });

    const result = await hydrateConversationHistory({
      container: undefined,
      scrollContainer: container,
      collect,
      wait,
      maxSteps: 8,
    } as Parameters<typeof hydrateConversationHistory>[0]);

    expect(result.reachedTop).toBe(true);
    expect(result.messages.map((item) => item.message.messageId)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
      'm6',
    ]);
    expect(container.scrollTop).toBe(4000);
  });
});
