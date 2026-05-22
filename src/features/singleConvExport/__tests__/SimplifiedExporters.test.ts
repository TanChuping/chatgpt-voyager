/**
 * Output-shape tests for the three simplified exporters. The filter
 * itself is covered in `simpleFilter.test.ts`; these tests focus on
 * "given a conversation that includes noise, does each format produce
 * a clean transcript?".
 */
import { describe, expect, it } from 'vitest';

import type { LinearConversation, LinearMessage } from '../../conversationApi/types';
import { toHtml } from '../HtmlExporter';
import { toJsonSimple } from '../JsonSimpleExporter';
import { toMarkdownSimple } from '../MarkdownSimpleExporter';

function msg(partial: Partial<LinearMessage>): LinearMessage {
  return {
    turnId: partial.turnId ?? 'u-x',
    messageId: partial.messageId ?? 'x',
    role: partial.role ?? 'assistant',
    authorName: partial.authorName ?? null,
    text: partial.text ?? '',
    attachments: partial.attachments ?? [],
    createTime: partial.createTime ?? null,
    contentType: partial.contentType,
    channel: partial.channel,
  };
}

/**
 * Mirrors the live observation: user → commentary narration → final
 * answer → code block → tool output. Standard exporters keep all five;
 * simplified exporters should keep two (user + final answer).
 */
function noisyConversation(): LinearConversation {
  return {
    id: 'c-1',
    title: 'Merge Sort',
    createTime: 1700000000,
    updateTime: null,
    messages: [
      msg({
        role: 'user',
        text: 'Make me a Merge Sort visualiser please.',
        contentType: 'text',
        createTime: 1700000010,
      }),
      msg({
        role: 'assistant',
        text: 'About to build a single-file HTML page...',
        contentType: 'text',
        channel: 'commentary',
        createTime: 1700000020,
      }),
      msg({
        role: 'assistant',
        text: 'from pathlib import Path\nhtml = "..."',
        contentType: 'code',
        channel: 'commentary',
        createTime: 1700000030,
      }),
      msg({
        role: 'tool',
        authorName: 'python',
        text: 'Created: /mnt/data/merge_sort.html',
        contentType: 'execution_output',
        createTime: 1700000040,
      }),
      msg({
        role: 'assistant',
        text: 'Done — [open the visualiser](sandbox:/mnt/data/merge_sort.html)',
        contentType: 'text',
        channel: 'final',
        createTime: 1700000050,
      }),
    ],
  };
}

describe('toMarkdownSimple', () => {
  it('emits only the user message and the final assistant reply', () => {
    const md = toMarkdownSimple(noisyConversation());
    expect(md).toContain('# Merge Sort');
    expect(md).toContain('## You');
    expect(md).toContain('## ChatGPT');
    expect(md).toContain('Make me a Merge Sort visualiser');
    expect(md).toContain('open the visualiser');
    // None of the noise should leak
    expect(md).not.toContain('About to build');
    expect(md).not.toContain('from pathlib');
    expect(md).not.toContain('Created: /mnt/data');
    expect(md).not.toContain('> [python]');
  });

  it('includes timestamps in role headings', () => {
    const md = toMarkdownSimple(noisyConversation());
    expect(md).toMatch(/## You \(\d{4}-\d{2}-\d{2}T/);
    expect(md).toMatch(/## ChatGPT \(\d{4}-\d{2}-\d{2}T/);
  });

  it('lists attachments under the user message', () => {
    const conv: LinearConversation = {
      id: 'c',
      title: 'T',
      createTime: 1700000000,
      updateTime: null,
      messages: [
        msg({
          role: 'user',
          text: 'See attached',
          contentType: 'text',
          attachments: [{ name: 'paper.pdf', mimeType: 'application/pdf' }],
          createTime: 1700000010,
        }),
      ],
    };
    const md = toMarkdownSimple(conv);
    expect(md).toContain('**Attachments**');
    expect(md).toContain('paper.pdf');
  });
});

describe('toJsonSimple', () => {
  it('emits exactly v=1 shape with role/text/createTime', () => {
    const json = JSON.parse(toJsonSimple(noisyConversation()));
    expect(json.v).toBe(1);
    expect(json.title).toBe('Merge Sort');
    expect(typeof json.createTime).toBe('string'); // ISO
    expect(json.messages).toHaveLength(2);
    expect(json.messages[0]).toMatchObject({ role: 'user' });
    expect(json.messages[1]).toMatchObject({ role: 'assistant' });
    // No internal fields leaked
    for (const m of json.messages) {
      expect(m).not.toHaveProperty('turnId');
      expect(m).not.toHaveProperty('messageId');
      expect(m).not.toHaveProperty('contentType');
      expect(m).not.toHaveProperty('channel');
    }
  });

  it('drops commentary / code / tool / system noise', () => {
    const json = JSON.parse(toJsonSimple(noisyConversation()));
    const allText = JSON.stringify(json);
    expect(allText).not.toContain('About to build');
    expect(allText).not.toContain('from pathlib');
    expect(allText).not.toContain('Created: /mnt/data');
  });

  it('emits ISO timestamps, not epoch seconds', () => {
    const json = JSON.parse(toJsonSimple(noisyConversation()));
    expect(json.messages[0].createTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('omits empty attachments arrays', () => {
    const json = JSON.parse(toJsonSimple(noisyConversation()));
    for (const m of json.messages) {
      if (!m.attachments) continue;
      expect(m.attachments.length).toBeGreaterThan(0);
    }
  });
});

describe('toHtml', () => {
  it('escapes HTML special characters in user content', () => {
    const conv: LinearConversation = {
      id: 'c',
      title: 'T <script>',
      createTime: null,
      updateTime: null,
      messages: [
        msg({
          role: 'user',
          text: '<script>alert(1)</script>',
          contentType: 'text',
          createTime: 1700000010,
        }),
        msg({
          role: 'assistant',
          text: 'safe response',
          contentType: 'text',
          channel: 'final',
          createTime: 1700000020,
        }),
      ],
    };
    const html = toHtml(conv);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('T &lt;script&gt;');
  });

  it('drops Code Interpreter / tool messages from the rendered HTML', () => {
    const html = toHtml(noisyConversation());
    expect(html).not.toContain('from pathlib');
    expect(html).not.toContain('Created: /mnt/data');
    expect(html).not.toContain('About to build');
    expect(html).toContain('Make me a Merge Sort');
    expect(html).toContain('open the visualiser');
  });

  it('emits a complete, parseable HTML document', () => {
    const html = toHtml(noisyConversation());
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<title>Merge Sort</title>');
    expect(html).toContain('<article class="message user">');
    expect(html).toContain('<article class="message assistant">');
    expect(html.trim()).toMatch(/<\/html>$/);
  });

  it('emits timestamps in <time> elements', () => {
    const html = toHtml(noisyConversation());
    expect(html).toMatch(/<time datetime="\d{4}-\d{2}-\d{2}T/);
  });
});
