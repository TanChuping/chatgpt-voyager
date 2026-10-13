/** MAIN/ISOLATED protocol literals are duplicated in pageWorld/fullConversationRequest. */
export function requestFullConversationCapture(convId: string): Promise<boolean> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => finish(false), 35000);
    function finish(ok: boolean): void {
      window.clearTimeout(timeout);
      window.removeEventListener('message', receive);
      resolve(ok);
    }
    function receive(event: MessageEvent): void {
      const payload = event.data?.payload;
      if (
        event.source !== window ||
        event.origin !== location.origin ||
        event.data?.__gvType !== 'gv-conv-full-result'
      )
        return;
      if (payload?.requestId !== requestId || payload?.convId !== convId) return;
      finish(payload.ok === true);
    }
    window.addEventListener('message', receive);
    window.postMessage(
      { __gvType: 'gv-conv-full-request', payload: { convId, requestId } },
      location.origin,
    );
  });
}
