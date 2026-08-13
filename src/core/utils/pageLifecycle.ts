/**
 * Run cleanup only when the current document is actually being discarded.
 *
 * `beforeunload` is too early for lifecycle teardown: browsers may fire it for
 * a navigation that turns into a download, leaving the original document alive
 * after extension features have destroyed themselves. `pagehide` is emitted
 * once the document really leaves the active session; a persisted page is kept
 * intact so it can resume from the back-forward cache.
 */
export function addPageExitListener(cleanup: () => void): () => void {
  let listening = true;

  const remove = () => {
    if (!listening) return;
    listening = false;
    window.removeEventListener('pagehide', onPageHide);
  };

  const onPageHide = (event: PageTransitionEvent) => {
    if (event.persisted) return;
    remove();
    cleanup();
  };

  window.addEventListener('pagehide', onPageHide);
  return remove;
}
