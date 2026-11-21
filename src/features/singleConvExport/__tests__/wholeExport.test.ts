import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LinearConversation } from '../../conversationApi/types';
import { exportPreparedConversation } from '../index';

const conversation: LinearConversation = {
  id: 'conv-1',
  title: '试验.v2',
  createTime: 1700000000,
  updateTime: 1700001000,
  messages: [
    {
      turnId: 'turn-1',
      messageId: 'message-1',
      role: 'user',
      authorName: null,
      text: '答案 😀 <example>',
      attachments: [],
      createTime: 1700000000,
      contentType: 'text',
      channel: null,
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('whole conversation downloads', () => {
  it.each([
    ['markdown', 'md', 'text/markdown'],
    ['markdown-simple', 'md', 'text/markdown'],
    ['json', 'json', 'application/json'],
    ['json-simple', 'json', 'application/json'],
    ['html', 'html', 'text/html'],
  ] as const)(
    'downloads %s with the expected extension, MIME and payload',
    async (format, extension, mime) => {
      const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:export');
      const download = vi.fn();
      vi.stubGlobal(
        'URL',
        Object.assign(class extends URL {}, {
          createObjectURL,
          revokeObjectURL: vi.fn(),
        }),
      );
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        download(this.download);
        this.remove();
      });
      await exportPreparedConversation(conversation, format);

      expect(download).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^chatgpt-试验v2-\\d{8}\\.${extension}$`, 'u')),
      );
      const [[blob]] = createObjectURL.mock.calls;
      expect(blob.type).toBe(mime);
      const body = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
      });

      if (extension === 'json') {
        const exported = JSON.parse(body);
        expect(exported.title).toBe(conversation.title);
        expect(exported.messages[0].text).toBe(conversation.messages[0].text);
        expect(exported.messages[0].messageId).toBe(format === 'json' ? 'message-1' : undefined);
      } else if (extension === 'html') {
        const doc = new DOMParser().parseFromString(body, 'text/html');
        expect(doc.title).toBe(conversation.title);
        expect(doc.querySelector('pre.content')?.textContent).toBe(conversation.messages[0].text);
      } else {
        expect(body).toContain(conversation.title);
        expect(body).toContain(conversation.messages[0].text);
      }
    },
  );
});
