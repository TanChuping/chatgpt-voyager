import { findCanvasSurface, isCanvasInteractionTarget } from '../chatgptDom';
import type { BootstrapSettings, IdleScheduler } from './runtime';

export interface StorageRouterOptions {
  keys: readonly string[];
  onSnapshot: (settings: BootstrapSettings, initial: boolean) => void;
  onError?: (error: unknown) => void;
}

export interface BootstrapStorageRouter {
  start: () => Promise<BootstrapSettings>;
  stop: () => void;
}

/** One snapshot read and one change listener for every lazy feature gate. */
export function createBootstrapStorageRouter(
  options: StorageRouterOptions,
): BootstrapStorageRouter {
  const keys = new Set(options.keys);
  const pendingChanges = new Map<string, unknown>();
  let settings: Record<string, unknown> = {};
  let ready = false;
  let closed = false;
  let listening = false;
  let startPromise: Promise<BootstrapSettings> | null = null;

  const onStorageChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (closed || areaName !== 'sync') return;
    let touched = false;

    for (const [key, change] of Object.entries(changes)) {
      if (!keys.has(key)) continue;
      touched = true;
      if (!ready) {
        pendingChanges.set(key, change.newValue);
      } else if (change.newValue === undefined) {
        delete settings[key];
      } else {
        settings[key] = change.newValue;
      }
    }

    if (ready && touched) options.onSnapshot({ ...settings }, false);
  };

  return {
    start: () => {
      if (startPromise) return startPromise;

      startPromise = (async () => {
        try {
          chrome.storage?.onChanged?.addListener(onStorageChanged);
          listening = true;
          const initial = (await chrome.storage?.sync?.get(options.keys as string[])) ?? {};
          settings = { ...initial };

          for (const [key, value] of pendingChanges) {
            if (value === undefined) delete settings[key];
            else settings[key] = value;
          }
          pendingChanges.clear();
          ready = true;

          if (!closed) options.onSnapshot({ ...settings }, true);
          return { ...settings };
        } catch (error) {
          options.onError?.(error);
          ready = true;
          if (!closed) options.onSnapshot({}, true);
          return {};
        }
      })();

      return startPromise;
    },
    stop: () => {
      if (closed) return;
      closed = true;
      if (listening) {
        try {
          chrome.storage?.onChanged?.removeListener(onStorageChanged);
        } catch {
          // The extension context may already be gone during page teardown.
        }
      }
      listening = false;
    },
  };
}

type IdleCapableWindow = Window &
  typeof globalThis & {
    requestIdleCallback?: (
      callback: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void,
      options?: { timeout: number },
    ) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

export function createIdleScheduler(
  targetWindow: Window & typeof globalThis = window,
): IdleScheduler {
  const idleWindow = targetWindow as IdleCapableWindow;

  return (callback) => {
    let cancelled = false;
    if (typeof idleWindow.requestIdleCallback === 'function') {
      const handle = idleWindow.requestIdleCallback(
        () => {
          if (!cancelled) callback();
        },
        { timeout: 2_000 },
      );
      return {
        cancel: () => {
          cancelled = true;
          idleWindow.cancelIdleCallback?.(handle);
        },
      };
    }

    const handle = targetWindow.setTimeout(() => {
      if (!cancelled) callback();
    }, 100);
    return {
      cancel: () => {
        cancelled = true;
        targetWindow.clearTimeout(handle);
      },
    };
  };
}

const TEMP_CHAT_ACTIVE_SELECTOR =
  '[data-testid="temporary-chat-toggle"][aria-pressed="true"], button[aria-label*="关闭临时聊天"], button[aria-label*="close temporary chat" i], button[aria-label*="turn off temporary chat" i]';
const TEMP_CHAT_INTERACTION_SELECTOR =
  '[data-testid="temporary-chat-toggle"], button[aria-label*="临时聊天"], button[aria-label*="temporary chat" i]';

export type PageFeatureSignal = 'canvas' | 'temp-chat';

export interface PageSignalRouter {
  start: () => void;
  stop: () => void;
}

function hasTempChatRouteOrPendingState(): boolean {
  try {
    return new URLSearchParams(location.search).get('temporary-chat') === 'true';
  } catch {
    return false;
  }
}

function hasCanvasRoute(): boolean {
  return /(?:^|\/)(?:canvas|artifact)(?:\/|$)/i.test(location.pathname);
}

/**
 * A zero-observer event bridge discovers both route-only modules. Heavy
 * feature observers do not exist until an initial surface, route, or user
 * click asks for their chunk.
 */
export function createPageSignalRouter(
  onSignal: (signal: PageFeatureSignal) => void,
  getPendingState: () => Promise<boolean> = async () => false,
): PageSignalRouter {
  let started = false;
  let generation = 0;
  const emitted = new Set<PageFeatureSignal>();

  const emit = (signal: PageFeatureSignal) => {
    if (!started || emitted.has(signal)) return;
    emitted.add(signal);
    onSignal(signal);
  };

  const inspectLocation = () => {
    if (hasCanvasRoute()) emit('canvas');
    if (hasTempChatRouteOrPendingState()) emit('temp-chat');
  };

  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (isCanvasInteractionTarget(target)) emit('canvas');
    const routeLink = target.closest<HTMLAnchorElement>('a[href]');
    if (routeLink) {
      try {
        if (/(?:^|\/)(?:canvas|artifact)(?:\/|$)/i.test(new URL(routeLink.href).pathname)) {
          emit('canvas');
        }
      } catch {
        // Ignore malformed host-page links.
      }
    }
    if (target.closest(TEMP_CHAT_INTERACTION_SELECTOR)) emit('temp-chat');
  };

  const onRouteEvent = () => inspectLocation();

  return {
    start: () => {
      if (started) return;
      started = true;
      generation += 1;
      const activeGeneration = generation;

      inspectLocation();
      void getPendingState()
        .then((hasPending) => {
          if (started && generation === activeGeneration && hasPending) emit('temp-chat');
        })
        .catch(() => undefined);
      if (findCanvasSurface()) emit('canvas');
      if (document.querySelector(TEMP_CHAT_ACTIVE_SELECTOR)) emit('temp-chat');

      document.addEventListener('click', onClick, true);
      window.addEventListener('popstate', onRouteEvent);
      window.addEventListener('hashchange', onRouteEvent);
    },
    stop: () => {
      if (!started) return;
      started = false;
      generation += 1;
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onRouteEvent);
      window.removeEventListener('hashchange', onRouteEvent);
    },
  };
}
