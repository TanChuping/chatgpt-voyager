import { describe, expect, it } from 'vitest';

import { renderContent, walkMapping } from '../conversationParser';
import type { ApiConversation } from '../types';

function nodeMessage(
  id: string,
  role: string,
  text: string,
  opts: {
    create_time?: number;
    hidden?: boolean;
    contentType?: string;
    language?: string;
    parts?: unknown[];
  } = {},
) {
  return {
    id,
    author: { role },
    create_time: opts.create_time ?? 0,
    content: opts.contentType
      ? { content_type: opts.contentType, parts: opts.parts ?? [text], language: opts.language }
      : { content_type: 'text', parts: [text] },
    metadata: opts.hidden ? { is_visually_hidden_from_conversation: true } : {},
  };
}

function buildLinearApi(steps: Array<ReturnType<typeof nodeMessage>>): ApiConversation {
  const mapping: ApiConversation['mapping'] = {};
  let parent: string | null = 'root';
  mapping.root = { id: 'root', message: null, parent: null, children: [] };
  for (const step of steps) {
    mapping[step.id] = {
      id: step.id,
      message: step,
      parent,
      children: [],
    };
    if (parent && mapping[parent]) mapping[parent].children.push(step.id);
    parent = step.id;
  }
  return {
    conversation_id: 'test-conv',
    title: 'Test',
    create_time: 1700000000,
    update_time: 1700001000,
    current_node: steps[steps.length - 1].id,
    mapping,
  };
}

describe('walkMapping', () => {
  it('orders messages from oldest to newest', () => {
    const api = buildLinearApi([
      nodeMessage('a', 'user', 'first'),
      nodeMessage('b', 'assistant', 'second'),
      nodeMessage('c', 'user', 'third'),
    ]);
    const linear = walkMapping(api);
    expect(linear.messages.map((m) => m.text)).toEqual(['first', 'second', 'third']);
  });

  it('skips visually-hidden nodes', () => {
    const api = buildLinearApi([
      nodeMessage('a', 'system', 'hidden bootstrap', { hidden: true }),
      nodeMessage('b', 'user', 'hello'),
      nodeMessage('c', 'assistant', 'hi'),
    ]);
    const linear = walkMapping(api);
    expect(linear.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('skips nodes without message body', () => {
    const api = buildLinearApi([nodeMessage('a', 'user', 'real')]);
    // Insert a null-message node
    api.mapping['orphan'] = { id: 'orphan', message: null, parent: 'a', children: [] };
    api.current_node = 'orphan';
    api.mapping['a'].children.push('orphan');
    const linear = walkMapping(api);
    expect(linear.messages).toHaveLength(1);
    expect(linear.messages[0].text).toBe('real');
  });

  it('prefixes UUID message ids with u-', () => {
    const uuid = '12345678-1234-1234-1234-123456789abc';
    const api = buildLinearApi([nodeMessage(uuid, 'user', 'hi')]);
    const linear = walkMapping(api);
    expect(linear.messages[0].turnId).toBe(`u-${uuid}`);
    expect(linear.messages[0].messageId).toBe(uuid);
  });

  it('handles multimodal text parts: extract text-bearing pieces', () => {
    const node = nodeMessage('a', 'user', '', {
      contentType: 'multimodal_text',
      parts: [
        'hello',
        { content_type: 'image_asset_pointer', asset_pointer: 'file-xxx' },
        { content_type: 'text', text: 'world' },
      ],
    });
    const api = buildLinearApi([node]);
    const linear = walkMapping(api);
    expect(linear.messages[0].text).toContain('hello');
    expect(linear.messages[0].text).toContain('world');
    expect(linear.messages[0].text).not.toContain('image_asset_pointer');
  });

  it('renders code with language fence', () => {
    const api = buildLinearApi([
      nodeMessage('a', 'assistant', 'console.log(1)', {
        contentType: 'code',
        language: 'js',
        parts: [],
      }),
    ]);
    // Code content puts text under .text, not .parts; emulate
    api.mapping['a'].message!.content = {
      content_type: 'code',
      language: 'js',
      text: 'console.log(1)',
    };
    const linear = walkMapping(api);
    expect(linear.messages[0].text.startsWith('```js')).toBe(true);
    expect(linear.messages[0].text).toContain('console.log(1)');
    expect(linear.messages[0].text.endsWith('```')).toBe(true);
  });
});

describe('renderContent', () => {
  it('joins string parts with double newline', () => {
    const rendered = renderContent({
      content_type: 'text',
      parts: ['a', 'b'],
    });
    expect(rendered).toBe('a\n\nb');
  });

  it('returns empty string for unknown content type with no text/parts', () => {
    expect(renderContent({ content_type: 'sandbox_url' })).toBe('');
  });
});
