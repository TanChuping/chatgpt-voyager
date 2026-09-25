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

  it('2026-09: jumps to the top of a column-reverse thread until the paged capture is complete', async () => {
    // column-reverse: 0 is the bottom, -(scrollHeight - clientHeight) the top.
    let scrollHeight = 5000;
    let pagesLoaded = 0;
    const container = document.createElement('div');
    container.style.flexDirection = 'column-reverse';
    Object.defineProperties(container, {
      clientHeight: { value: 1000, configurable: true },
      scrollHeight: { get: () => scrollHeight, configurable: true },
      scrollTop: { value: -3000, writable: true, configurable: true },
    });
    const tops: number[] = [];
    const wait = vi.fn(async () => {
      tops.push(container.scrollTop);
      // Each visit to the top pages one older page in above.
      if (container.scrollTop <= -(scrollHeight - 1000) + 2 && pagesLoaded < 2) {
        pagesLoaded += 1;
        scrollHeight += 3000;
      }
    });

    const result = await hydrateConversationHistory({
      scrollContainer: container,
      collect: () => [live('m1', 1)],
      wait,
      isComplete: () => pagesLoaded >= 2,
    });

    expect(result.reachedTop).toBe(true);
    // Straight to the top every pass, following the growing thread.
    expect(tops.slice(0, 2)).toEqual([-4000, -7000]);
    // A reading position far from the bottom is kept (measured from the bottom,
    // so the pages prepended above don't shift it).
    expect(container.scrollTop).toBe(-3000);
  });

  it('2026-09: reports failure when ChatGPT never completes the capture', async () => {
    const container = document.createElement('div');
    container.style.flexDirection = 'column-reverse';
    Object.defineProperties(container, {
      clientHeight: { value: 1000, configurable: true },
      scrollHeight: { value: 5000, configurable: true },
      scrollTop: { value: 0, writable: true, configurable: true },
    });
    const result = await hydrateConversationHistory({
      scrollContainer: container,
      collect: () => [],
      wait: async () => undefined,
      isComplete: () => false,
    });
    expect(result.reachedTop).toBe(false);
  });
});
