import { StorageKeys } from '@/core/types/common';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';

const GV_BRIDGE_ID = 'gv-prevent-auto-scroll-bridge';
const GV_SCRIPT_ID = 'gv-prevent-auto-scroll-script';

let started = false;
let lifecycleGeneration = 0;
let storageChangeHandler:
  | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
  | null = null;
let injectedScript: HTMLScriptElement | null = null;

function isActiveGeneration(generation: number): boolean {
  return started && generation === lifecycleGeneration;
}

function getBridgeElement(): HTMLElement {
  let bridge = document.getElementById(GV_BRIDGE_ID);
  if (!bridge) {
    bridge = document.createElement('div');
    bridge.id = GV_BRIDGE_ID;
    bridge.style.display = 'none';
    document.documentElement.appendChild(bridge);
  }
  return bridge;
}

function notifyScript(enabled: boolean): void {
  const bridge = getBridgeElement();
  bridge.dataset.enabled = String(enabled);
}

function injectScript(): void {
  const existing = document.getElementById(GV_SCRIPT_ID);
  if (existing) {
    injectedScript = existing as HTMLScriptElement;
    return;
  }

  const script = document.createElement('script');
  script.id = GV_SCRIPT_ID;
  script.src = chrome.runtime.getURL('prevent-auto-scroll.js');
  const removeLoadedScript = () => {
    if (injectedScript === script) injectedScript = null;
    script.remove();
  };
  script.addEventListener('load', removeLoadedScript, { once: true });
  script.addEventListener('error', removeLoadedScript, { once: true });
  injectedScript = script;
  (document.head || document.documentElement).appendChild(script);
}

export function stopPreventAutoScroll(): void {
  started = false;
  lifecycleGeneration += 1;

  if (storageChangeHandler) {
    try {
      chrome.storage?.onChanged?.removeListener(storageChangeHandler);
    } catch {}
    storageChangeHandler = null;
  }

  injectedScript?.remove();
  injectedScript = null;
  document.getElementById(GV_SCRIPT_ID)?.remove();
  document.getElementById(GV_BRIDGE_ID)?.remove();
}

export async function startPreventAutoScroll(): Promise<() => void> {
  if (started) return stopPreventAutoScroll;
  started = true;
  const generation = ++lifecycleGeneration;

  try {
    const result = await chrome.storage?.sync?.get({
      [StorageKeys.PREVENT_AUTO_SCROLL_ENABLED]: false,
    });
    if (!isActiveGeneration(generation)) return stopPreventAutoScroll;

    notifyScript(result?.[StorageKeys.PREVENT_AUTO_SCROLL_ENABLED] === true);
    injectScript();

    storageChangeHandler = (changes, areaName) => {
      if (!isActiveGeneration(generation) || areaName !== 'sync') return;
      const change = changes[StorageKeys.PREVENT_AUTO_SCROLL_ENABLED];
      if (!change) return;
      notifyScript(change.newValue === true);
    };
    chrome.storage?.onChanged?.addListener(storageChangeHandler);

    console.log('[GPT-Voyager] Prevent auto scroll initialized');
  } catch (error) {
    const wasActive = isActiveGeneration(generation);
    if (wasActive) stopPreventAutoScroll();
    if (wasActive && !isExtensionContextInvalidatedError(error)) {
      console.error('[GPT-Voyager] Prevent auto scroll initialization failed:', error);
    }
  }

  return stopPreventAutoScroll;
}
