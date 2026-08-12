import { describe, expect, it, vi } from 'vitest';

import type { LinearConversation } from '../../conversationApi/types';
import { toHtmlBlobParts } from '../HtmlExporter';

function conversation(text: string): LinearConversation {
  return {
    id: 'conv-html',
    title: 'Large <chat>',
    createTime: 1,
    updateTime: 2,
    messages: [
      {
        turnId: 'message-1',
        messageId: 'message-1',
        role: 'assistant',
        authorName: null,
        text,
        attachments: [],
        createTime: 2,
        contentType: 'text',
        channel: 'final',
      },
    ],
  };
}

describe('chunked HTML export', () => {
  it('escapes large content in bounded parts and yields to the main thread', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T00:00:00.000Z'));
    const yieldToMain = vi.fn(async () => undefined);
    const text = `${'<tag>&"\''.repeat(1000)} end`;
    const parts = await toHtmlBlobParts(conversation(text), {
      chunkSize: 1024,
      yieldEveryChunks: 2,
      yieldToMain,
    });
    const html = parts.join('');
    expect(parts.length).toBeGreaterThan(8);
    expect(yieldToMain).toHaveBeenCalled();
    expect(html).toContain('&lt;tag&gt;&amp;&quot;&#39;');
    expect(html).toContain('<title>Large &lt;chat&gt;</title>');
    expect(html).toContain('</html>');
    vi.useRealTimers();
  });
});
