import { describe, expect, it } from 'vitest';

import { buildStarredMessageUrl } from '../starredNavigation';

const messageId = '12345678-1234-1234-1234-123456789abc';

describe('starred message navigation', () => {
  it('loads an old favorite through ChatGPT before positioning the timeline', () => {
    const url = new URL(
      buildStarredMessageUrl('https://chatgpt.com/c/conversation', `u-${messageId}`),
    );
    expect(url.searchParams.get('messageId')).toBe(messageId);
    expect(url.hash).toBe(`#gv-turn-u-${messageId}`);
    expect(url.pathname).toBe('/c/conversation');
  });

  it('preserves project routes and unrelated parameters, replacing stale targets', () => {
    const url = new URL(
      buildStarredMessageUrl(
        'https://chatgpt.com/g/g-project/c/conversation?model=auto&messageId=old#old',
        `u-${messageId}`,
      ),
    );
    expect(url.pathname).toBe('/g/g-project/c/conversation');
    expect(url.searchParams.get('model')).toBe('auto');
    expect(url.searchParams.getAll('messageId')).toEqual([messageId]);
    expect(url.hash).toBe(`#gv-turn-u-${messageId}`);
  });

  it('supports legacy ChatGPT host and raw message UUIDs', () => {
    const url = new URL(buildStarredMessageUrl('https://chat.openai.com/c/conv', messageId));
    expect(url.hostname).toBe('chat.openai.com');
    expect(url.searchParams.get('messageId')).toBe(messageId);
  });

  it('keeps synthetic old turn IDs on the existing fragment path', () => {
    const url = new URL(
      buildStarredMessageUrl('https://chatgpt.com/c/conv?messageId=old', 'u-3-text-hash'),
    );
    expect(url.searchParams.has('messageId')).toBe(false);
    expect(url.hash).toBe('#gv-turn-u-3-text-hash');
  });

  it('does not apply the private-chat loader parameter to shared links or other sites', () => {
    for (const base of ['https://chatgpt.com/share/shared', 'https://example.com/c/conv']) {
      const url = new URL(buildStarredMessageUrl(base, `u-${messageId}`));
      expect(url.searchParams.has('messageId')).toBe(false);
      expect(url.hash).toBe(`#gv-turn-u-${messageId}`);
    }
  });
});
