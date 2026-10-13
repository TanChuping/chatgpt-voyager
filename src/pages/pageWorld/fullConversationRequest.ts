/** User-triggered full export reads; credentials stay in the page's own world. */
const CONVERSATION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const REQUEST = 'gv-conv-full-request';
const RESULT = 'gv-conv-full-result';

// Keep the branch check in sync with conversationParser.hasCompleteConversationMapping.
// MAIN world must not import content-script modules: that breaks its entry bundle.
export function isCompleteFullPayload(value: unknown, convId: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const api = value as {
    conversation_id?: string;
    id?: string;
    current_node?: string;
    mapping?: Record<string, { parent?: unknown }>;
  };
  if (
    String(api.conversation_id || api.id || '') !== convId ||
    !api.mapping ||
    Array.isArray(api.mapping)
  )
    return false;
  const visited = new Set<string>();
  let cursor = api.current_node;
  while (cursor && !visited.has(cursor)) {
    if (cursor.startsWith('paginated-root:')) return false;
    visited.add(cursor);
    const node = api.mapping[cursor];
    if (!node) return false;
    if (node.parent === null) return true;
    if (typeof node.parent !== 'string') return false;
    cursor = node.parent;
  }
  return false;
}

export function installFullConversationRequest(
  fetchPage: typeof fetch,
  captured: (convId: string, data: unknown) => void,
): () => void {
  let pending: { convId: string; result: Promise<boolean> } | null = null;
  async function load(convId: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    try {
      const sessionResponse = await fetchPage('/api/auth/session', {
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (!sessionResponse.ok) return false;
      const session = (await sessionResponse.json()) as { accessToken?: unknown };
      if (typeof session.accessToken !== 'string' || !session.accessToken) return false;
      // Existing exporter implementations use this full mapping endpoint. Unlike
      // scroll-driven paging it also works when earlier rows are not mounted.
      const response = await fetchPage(`/backend-api/conversation/${convId}`, {
        method: 'GET',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          'X-Authorization': `Bearer ${session.accessToken}`,
        },
      });
      if (!response.ok) return false;
      const data: unknown = await response.json();
      if (!isCompleteFullPayload(data, convId)) return false;
      captured(convId, data);
      return true;
    } catch {
      return false;
    } finally {
      window.clearTimeout(timeout);
    }
  }
  const receive = (event: MessageEvent) => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || data?.__gvType !== REQUEST)
      return;
    const payload = data.payload;
    const convId: unknown = payload?.convId;
    const requestId: unknown = payload?.requestId;
    const current = location.pathname.match(/\/c\/([a-f0-9-]{36})(?:\/|$)/i)?.[1];
    if (
      typeof convId !== 'string' ||
      !CONVERSATION_ID.test(convId) ||
      current !== convId ||
      typeof requestId !== 'string' ||
      requestId.length > 64
    )
      return;
    if (!pending || pending.convId !== convId) {
      const result = load(convId);
      pending = { convId, result };
      void result.finally(() => {
        if (pending?.result === result) pending = null;
      });
    }
    void pending.result.then((ok) =>
      window.postMessage({ __gvType: RESULT, payload: { convId, requestId, ok } }, location.origin),
    );
  };
  window.addEventListener('message', receive);
  return () => window.removeEventListener('message', receive);
}
