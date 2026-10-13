import { afterEach, expect, it, vi } from 'vitest';

import { installFullConversationRequest, isCompleteFullPayload } from '../fullConversationRequest';

const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const full = {
  conversation_id: id,
  current_node: 'reply',
  mapping: { root: { parent: null }, user: { parent: 'root' }, reply: { parent: 'user' } },
};
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  window.history.pushState({}, '', '/');
  vi.restoreAllMocks();
});

it('accepts only an unbroken branch belonging to the requested conversation', () => {
  expect(isCompleteFullPayload(full, id)).toBe(true);
  expect(isCompleteFullPayload(full, 'other')).toBe(false);
  expect(isCompleteFullPayload({ ...full, mapping: { reply: { parent: 'missing' } } }, id)).toBe(
    false,
  );
  expect(isCompleteFullPayload({ ...full, mapping: { reply: { parent: 'reply' } } }, id)).toBe(
    false,
  );
  expect(
    isCompleteFullPayload(
      {
        ...full,
        current_node: `paginated-root:${id}`,
        mapping: { [`paginated-root:${id}`]: { parent: null } },
      },
      id,
    ),
  ).toBe(false);
});

it('fetches full history only on a current-chat request and publishes capture before acknowledgement', async () => {
  window.history.pushState({}, '', `/c/${id}`);
  const fetchPage = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: 'test-token' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => full });
  const events: string[] = [];
  const captured = vi.fn(() => events.push('capture'));
  const post = vi.spyOn(window, 'postMessage').mockImplementation((data) => {
    if (data.__gvType === 'gv-conv-full-result') events.push('ack');
  });
  stop = installFullConversationRequest(fetchPage, captured);
  expect(fetchPage).not.toHaveBeenCalled();
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: {
        __gvType: 'gv-conv-full-request',
        payload: { convId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', requestId: 'other' },
      },
    }),
  );
  expect(fetchPage).not.toHaveBeenCalled();
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: { __gvType: 'gv-conv-full-request', payload: { convId: id, requestId: 'current' } },
    }),
  );
  await vi.waitFor(() => expect(captured).toHaveBeenCalledWith(id, full));
  expect(events).toEqual(['capture', 'ack']);
  expect(fetchPage.mock.calls[1][0]).toBe(`/backend-api/conversation/${id}`);
  expect(post).toHaveBeenCalledWith(
    { __gvType: 'gv-conv-full-result', payload: { convId: id, requestId: 'current', ok: true } },
    location.origin,
  );
  expect(JSON.stringify(post.mock.calls)).not.toContain('test-token');
});

it('does not publish a mapping slice as full history', async () => {
  window.history.pushState({}, '', `/c/${id}`);
  const partial = { ...full, mapping: { reply: { parent: 'missing' } } };
  const fetchPage = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: 'test-token' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => partial });
  const captured = vi.fn();
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
  stop = installFullConversationRequest(fetchPage, captured);
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: { __gvType: 'gv-conv-full-request', payload: { convId: id, requestId: 'partial' } },
    }),
  );
  await vi.waitFor(() => expect(post).toHaveBeenCalled());
  expect(captured).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({ payload: { convId: id, requestId: 'partial', ok: false } }),
    location.origin,
  );
});
