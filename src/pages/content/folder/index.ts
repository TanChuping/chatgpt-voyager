import { FolderManager } from './manager';

export async function startFolderManager(signal?: AbortSignal): Promise<FolderManager | null> {
  const manager = new FolderManager();
  let aborted = signal?.aborted === true;
  let resolveAbort!: () => void;
  const abortPromise = new Promise<'aborted'>((resolve) => {
    resolveAbort = () => resolve('aborted');
  });
  const abort = () => {
    aborted = true;
    manager.destroy();
    resolveAbort();
  };

  if (aborted) {
    abort();
    return null;
  }

  signal?.addEventListener('abort', abort, { once: true });
  try {
    const initPromise = manager.init();
    const outcome = await Promise.race([
      initPromise.then(() => 'initialized' as const),
      abortPromise,
    ]);
    if (outcome === 'aborted') {
      // The underlying storage promise cannot be cancelled. Consume its late
      // settlement and sweep again so it cannot revive listeners or DOM.
      void initPromise.then(
        () => manager.destroy(),
        () => manager.destroy(),
      );
      return null;
    }
    return manager;
  } catch (error) {
    if (!aborted) {
      manager.destroy();
      console.error('[FolderManager] Start error:', error);
    }
    return null;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
