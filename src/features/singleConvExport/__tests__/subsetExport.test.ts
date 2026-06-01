import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationCaptureService } from '../../conversationApi/ConversationCaptureService';
import type { LinearConversation, LinearMessage } from '../../conversationApi/types';
import { downloadBlob } from '../downloadFile';
import { exportConversationSubset } from '../index';

vi.mock('../downloadFile', () => ({ downloadBlob: vi.fn() }));

const downloadBlobMock = vi.mocked(downloadBlob);

function msg(id: string, role: LinearMessage['role'], text: string): LinearMessage {
  return {
    turnId: `t-${id}`,
    messageId: id,
    role,
    authorName: null,
    text,
    attachments: [],
    createTime: 1700000000,
    contentType: 'text',
    channel: role === 'assistant' ? 'final' : null,
  };
}

function makeLinear(): LinearConversation {
  return {
    id: 'conv-1',
    title: 'My chat',
    createTime: 1700000000,
    updateTime: 1700001000,
    messages: [
      msg('a', 'user', 'first question'),
      msg('b', 'assistant', 'first answer'),
      msg('c', 'user', 'second question'),
      msg('d', 'assistant', 'second answer'),
    ],
  };
}

function fakeCapture(linear: LinearConversation | null): ConversationCaptureService {
  return { getLatest: () => linear } as unknown as ConversationCaptureService;
}

describe('exportConversationSubset', () => {
  beforeEach(() => downloadBlobMock.mockClear());

  it('returns "empty" for an empty selection and does not download', () => {
    const result = exportConversationSubset('conv-1', 'markdown', new Set(), {
      captureService: fakeCapture(makeLinear()),
    });
    expect(result).toBe('empty');
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });

  it('returns "not-captured" when the conversation is not in the capture cache', () => {
    const result = exportConversationSubset('conv-1', 'markdown', new Set(['a']), {
      captureService: fakeCapture(null),
    });
    expect(result).toBe('not-captured');
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });

  it('returns "empty" when selected ids match no message', () => {
    const result = exportConversationSubset('conv-1', 'markdown', new Set(['zzz']), {
      captureService: fakeCapture(makeLinear()),
    });
    expect(result).toBe('empty');
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });

  it('exports only the selected messages, preserving original order', () => {
    const result = exportConversationSubset('conv-1', 'markdown', new Set(['c', 'b']), {
      captureService: fakeCapture(makeLinear()),
    });
    expect(result).toBe('ok');
    expect(downloadBlobMock).toHaveBeenCalledTimes(1);

    const [body, filename, mime] = downloadBlobMock.mock.calls[0];
    expect(mime).toBe('text/markdown');
    expect(filename).toMatch(/^chatgpt-My-chat-\d{8}\.md$/);
    // Selected content is present...
    expect(body).toContain('first answer');
    expect(body).toContain('second question');
    // ...unselected content is absent.
    expect(body).not.toContain('first question');
    expect(body).not.toContain('second answer');
    // Original order preserved: b (answer) precedes c (question).
    expect(body.indexOf('first answer')).toBeLessThan(body.indexOf('second question'));
  });

  it('does not mutate the cached conversation', () => {
    const linear = makeLinear();
    exportConversationSubset('conv-1', 'json', new Set(['a']), {
      captureService: fakeCapture(linear),
    });
    expect(linear.messages).toHaveLength(4);
  });
});
