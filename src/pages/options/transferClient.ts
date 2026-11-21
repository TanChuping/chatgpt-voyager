import type { LocalBackup } from '@/features/localTransfer/model';
import { TRANSFER_PORT } from '@/features/localTransfer/port';

export function connectTransfer(tabId: number, onLost?: () => void) {
  const port = chrome.tabs.connect(tabId, { name: TRANSFER_PORT, frameId: 0 });
  let serial = 0,
    disconnected = false;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (error: Error) => void }>();
  port.onMessage.addListener((result) => {
    const task = pending.get(result.id);
    if (!task) return;
    pending.delete(result.id);
    if (result.ok) task.resolve(result.value);
    else task.reject(new Error(result.error));
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    disconnected = true;
    for (const task of pending.values()) task.reject(new Error('connection'));
    pending.clear();
    onLost?.();
  });
  return {
    request<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
      if (disconnected) return Promise.reject(new Error('connection'));
      return new Promise((resolve, reject) => {
        const id = ++serial;
        pending.set(id, { resolve, reject });
        try {
          port.postMessage({ id, action, ...args });
        } catch {
          pending.delete(id);
          reject(new Error('connection'));
        }
      });
    },
    close() {
      port.disconnect();
    },
  };
}

// A replacement must have a durable recovery copy before the content adapter can mutate anything.
export async function recoveryCopy(save?: LocalBackup): Promise<LocalBackup | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('gpt-voyager-local-transfer', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('recovery');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('backup'));
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('recovery', save ? 'readwrite' : 'readonly');
      const store = tx.objectStore('recovery');
      const req = save ? store.put(save, 'before-replace') : store.get('before-replace');
      tx.oncomplete = () => resolve(save ?? (req.result as LocalBackup | undefined));
      tx.onerror = tx.onabort = () => reject(new Error('backup'));
    });
  } finally {
    db.close();
  }
}
