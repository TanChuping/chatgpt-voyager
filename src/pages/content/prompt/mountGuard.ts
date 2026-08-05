/**
 * Keep Prompt Manager's two direct body children alive across ChatGPT's late
 * hydration pass. The page occasionally removes extension-owned body children
 * after the content script has mounted them, while leaving the content script
 * and its listeners running.
 *
 * Observe only direct children of <html> and <body>; streaming message DOM is
 * deeper in the tree, so this guard stays idle during normal generation.
 */
export function keepPromptManagerMounted(trigger: HTMLElement, panel: HTMLElement): () => void {
  let stopped = false;
  let observedBody: HTMLElement | null = null;

  const observer = new MutationObserver(() => repairMount());

  const observeCurrentRoots = (): void => {
    const body = document.body;
    if (!body || body === observedBody) return;
    observer.disconnect();
    observer.observe(document.documentElement, { childList: true });
    observer.observe(body, { childList: true });
    observedBody = body;
  };

  const repairMount = (): void => {
    if (stopped || !document.body) return;
    observeCurrentRoots();
    if (!trigger.isConnected) document.body.appendChild(trigger);
    if (!panel.isConnected) document.body.appendChild(panel);
  };

  repairMount();

  return () => {
    stopped = true;
    observer.disconnect();
    observedBody = null;
  };
}
