/**
 * Channel/content-type matrix observed live on a real reasoning-model
 * conversation with Code Interpreter (see chapter "1.6.0 export bug
 * investigation"). The simplified filter must:
 *   - keep user turns regardless of content_type
 *   - keep assistant `text` / `multimodal_text` on channel null|final
 *   - drop assistant `text` on channel `commentary` (pre-tool narration)
 *   - drop assistant `code` (Code Interpreter source)
 *   - drop assistant `thoughts` / `reasoning_recap` / `model_editable_context`
 *   - drop role `tool` and role `system` entirely
 *   - drop messages that have neither text nor attachments
 *
 * Adding new content types ChatGPT introduces in the future should
 * fail closed (drop) here — assistant messages with an unknown
 * content_type get dropped because the predicate only allows two.
 */
import { describe, expect, it } from 'vitest';

import type { LinearConversation, LinearMessage } from '../../conversationApi/types';
import { filterForSimple, isSimpleVisibleMessage } from '../simpleFilter';

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

describe('isSimpleVisibleMessage', () => {
  it('keeps user messages regardless of content_type', () => {
    expect(isSimpleVisibleMessage(msg({ role: 'user', text: 'hi', contentType: 'text' }))).toBe(true);
    expect(
      isSimpleVisibleMessage(msg({ role: 'user', text: 'hi', contentType: 'multimodal_text' })),
    ).toBe(true);
  });

  it('keeps assistant text on channel final or null', () => {
    expect(
      isSimpleVisibleMessage(msg({ role: 'assistant', text: 'a', contentType: 'text', channel: 'final' })),
    ).toBe(true);
    expect(
      isSimpleVisibleMessage(msg({ role: 'assistant', text: 'a', contentType: 'text', channel: null })),
    ).toBe(true);
    expect(
      isSimpleVisibleMessage(msg({ role: 'assistant', text: 'a', contentType: 'text' })),
    ).toBe(true); // channel undefined → also visible (legacy)
  });

  it('drops assistant pre-tool commentary narration', () => {
    expect(
      isSimpleVisibleMessage(
        msg({ role: 'assistant', text: 'about to do x', contentType: 'text', channel: 'commentary' }),
      ),
    ).toBe(false);
  });

  it('drops assistant code (Code Interpreter source)', () => {
    expect(
      isSimpleVisibleMessage(
        msg({ role: 'assistant', text: 'print(1)', contentType: 'code', channel: 'commentary' }),
      ),
    ).toBe(false);
  });

  it('drops assistant thoughts / reasoning_recap / model_editable_context', () => {
    for (const ct of ['thoughts', 'reasoning_recap', 'model_editable_context'] as const) {
      expect(isSimpleVisibleMessage(msg({ role: 'assistant', text: 'x', contentType: ct }))).toBe(false);
    }
  });

  it('drops tool and system roles', () => {
    expect(
      isSimpleVisibleMessage(
        msg({ role: 'tool', text: 'Created: /mnt/data/file.html', contentType: 'execution_output' }),
      ),
    ).toBe(false);
    expect(isSimpleVisibleMessage(msg({ role: 'system', text: 'noise' }))).toBe(false);
  });

  it('fails closed on unknown assistant content types', () => {
    expect(
      isSimpleVisibleMessage(msg({ role: 'assistant', text: 'x', contentType: 'some_new_type' })),
    ).toBe(false);
  });
});

describe('filterForSimple', () => {
  function conv(messages: LinearMessage[]): LinearConversation {
    return { id: 'c', title: 'T', createTime: 1700000000, updateTime: null, messages };
  }

  it('produces a new LinearConversation without mutating the input', () => {
    const input = conv([
      msg({ role: 'user', text: 'hi' }),
      msg({ role: 'assistant', text: 'noise', contentType: 'code', channel: 'commentary' }),
    ]);
    const original = input.messages.length;
    const out = filterForSimple(input);
    expect(input.messages.length).toBe(original);
    expect(out).not.toBe(input);
    expect(out.messages.length).toBe(1);
    expect(out.messages[0].role).toBe('user');
  });

  it('matches the observed live distribution', () => {
    // 9 user, 8 assistant final, 1 assistant null channel, 2 assistant commentary,
    // 1 assistant code, 1 tool execution_output, 8 thoughts, 8 reasoning_recap,
    // 2 model_editable_context, 15 hidden system (already pre-stripped by parser).
    const live: LinearMessage[] = [];
    for (let i = 0; i < 9; i++) live.push(msg({ role: 'user', text: `u${i}`, contentType: 'text' }));
    for (let i = 0; i < 8; i++)
      live.push(msg({ role: 'assistant', text: `a${i}`, contentType: 'text', channel: 'final' }));
    live.push(msg({ role: 'assistant', text: 'legacy', contentType: 'text', channel: null }));
    for (let i = 0; i < 2; i++)
      live.push(
        msg({ role: 'assistant', text: 'pre-tool', contentType: 'text', channel: 'commentary' }),
      );
    live.push(msg({ role: 'assistant', text: 'CODE', contentType: 'code', channel: 'commentary' }));
    live.push(
      msg({ role: 'tool', text: 'Created: /mnt/data/x.html', contentType: 'execution_output' }),
    );
    for (let i = 0; i < 8; i++) live.push(msg({ role: 'assistant', text: 't', contentType: 'thoughts' }));
    for (let i = 0; i < 8; i++) live.push(msg({ role: 'assistant', text: 'r', contentType: 'reasoning_recap' }));
    for (let i = 0; i < 2; i++) live.push(msg({ role: 'assistant', text: 'm', contentType: 'model_editable_context' }));
    const out = filterForSimple(conv(live));
    expect(out.messages.length).toBe(9 + 8 + 1);
    const roles = out.messages.map((m) => m.role);
    expect(roles.filter((r) => r === 'user').length).toBe(9);
    expect(roles.filter((r) => r === 'assistant').length).toBe(9);
  });

  it('drops messages with no text and no attachments after channel filter', () => {
    const out = filterForSimple(
      conv([
        msg({ role: 'user', text: '   ', attachments: [] }),
        msg({ role: 'assistant', text: '', contentType: 'text', channel: 'final', attachments: [] }),
      ]),
    );
    expect(out.messages.length).toBe(0);
  });

  it('keeps user messages with attachments even when text is empty', () => {
    const out = filterForSimple(
      conv([msg({ role: 'user', text: '', attachments: [{ name: 'paper.pdf' }] })]),
    );
    expect(out.messages.length).toBe(1);
    expect(out.messages[0].attachments[0].name).toBe('paper.pdf');
  });
});
