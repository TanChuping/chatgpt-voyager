import { takeFile } from './pickedFile';

export const TRANSFER_PORT = 'gv.localTransfer.v1';
export const TRANSFER_PAGE = 'src/pages/options/index.html';

export function registerTransferPort(foldersReady: () => Promise<boolean>) {
  const connect = (port: chrome.runtime.Port) => {
    if (
      port.name !== TRANSFER_PORT ||
      port.sender?.id !== chrome.runtime.id ||
      port.sender?.url?.split(/[?#]/, 1)[0] !== chrome.runtime.getURL(TRANSFER_PAGE)
    )
      return;
    // Install the message listener synchronously. Loading the adapter cannot lose the first request.
    let connection:
      | Promise<ReturnType<(typeof import('./host'))['createTransferHost']>>
      | undefined;
    let open = true;
    let queue = Promise.resolve();
    port.onDisconnect.addListener(() => {
      open = false;
      void connection?.then((host) => host.dispose()).catch(() => {});
    });
    port.onMessage.addListener((msg) => {
      queue = queue
        .then(async () => {
          if (!open) return;
          try {
            if (msg.action === 'ping') {
              port.postMessage({ id: msg.id, ok: true });
              return;
            }
            if (msg.action === 'folders-ready') {
              const ready = await foldersReady();
              if (open) port.postMessage({ id: msg.id, ok: true, value: ready });
              return;
            }
            connection ??= import('./host').then((module) => module.createTransferHost(port));
            const host = await connection;
            let value;
            if (msg.action === 'preview-picked') {
              const file = takeFile(msg.ticket);
              const preview = await host.run({
                action: 'preview',
                file: JSON.parse(await file.text()),
              });
              value = { preview, filename: file.name };
            } else {
              value = await host.run(msg);
            }
            if (open) port.postMessage({ id: msg.id, ok: true, value });
          } catch (error) {
            const e = error as { code?: string; message?: string };
            if (open)
              port.postMessage({
                id: msg.id,
                ok: false,
                error: e?.code || e?.message || 'invalid',
              });
          }
        })
        .catch(() => {});
    });
  };
  chrome.runtime.onConnect.addListener(connect);
  return () => chrome.runtime.onConnect.removeListener(connect);
}
