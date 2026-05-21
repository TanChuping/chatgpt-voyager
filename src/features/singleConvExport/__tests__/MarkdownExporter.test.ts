import { describe, expect, it } from 'vitest';

import type { LinearConversation } from '../../conversationApi/types';
import { toMarkdown } from '../MarkdownExporter';

function makeLinear(): LinearConversation {
  return {
    id: 'conv-1',
    title: 'My chat',
    createTime: 1700000000,
    updateTime: 1700001000,
    messages: [
      {
        turnId: 'u-1',
        messageId: '1',
        role: 'user',
        authorName: null,
        text: 'Solve $x^2 + 1 = 0$ for me.',
        attachments: [],
        createTime: 1700000010,
      },
      {
        turnId: 'm-2',
        messageId: '2',
        role: 'assistant',
        authorName: null,
        text: 'Sure: $$x = \\pm i$$',
        attachments: [],
        createTime: 1700000020,
      },
      {
        turnId: 'u-3',
        messageId: '3',
        role: 'user',
        authorName: null,
        text: 'Thanks',
        attachments: [{ name: 'paper.pdf', mimeType: 'application/pdf' }],
        createTime: 1700000030,
      },
    ],
  };
}

describe('toMarkdown', () => {
  it('outputs role headings with timestamps', () => {
    const md = toMarkdown(makeLinear());
    expect(md).toContain('## You — ');
    expect(md).toContain('## ChatGPT — ');
  });

  it('preserves LaTeX wrappers verbatim', () => {
    const md = toMarkdown(makeLinear());
    expect(md).toContain('$x^2 + 1 = 0$');
    expect(md).toContain('$$x = \\pm i$$');
  });

  it('uses ISO timestamps for createTime', () => {
    const md = toMarkdown(makeLinear());
    // 1700000010 -> 2023-11-14T22:13:30.000Z
    expect(md).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('lists attachments under a header', () => {
    const md = toMarkdown(makeLinear());
    expect(md).toContain('**Attachments**');
    expect(md).toContain('paper.pdf');
  });

  it('emits document title and conversation id', () => {
    const md = toMarkdown(makeLinear());
    expect(md).toMatch(/^# My chat/);
    expect(md).toContain('conv-1');
  });

  it('quotes tool / system messages', () => {
    const linear = makeLinear();
    linear.messages.push({
      turnId: 't-4',
      messageId: '4',
      role: 'tool',
      authorName: 'browser',
      text: 'Visited example.com',
      attachments: [],
      createTime: 1700000040,
    });
    const md = toMarkdown(linear);
    expect(md).toContain('> [browser]');
    expect(md).toContain('> Visited example.com');
  });
});
