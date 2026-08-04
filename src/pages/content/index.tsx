import {
  hasValidExtensionContext,
  isExtensionContextInvalidatedError,
} from '@/core/utils/extensionContext';
import { startFormulaCopy, stopFormulaCopy } from '@/features/formulaCopy';
import { initI18n } from '@/utils/i18n';

import {
  type BusinessDemandRouter,
  type BusinessDemandSignal,
  createBusinessDemandRouter,
} from './bootstrap/demand';
import {
  BOOTSTRAP_SETTING_KEYS,
  BUSINESS_DEMAND_FEATURE_IDS,
  PAGE_SIGNAL_FEATURE_IDS,
  createLazyFeatureDefinitions,
} from './bootstrap/features';
import {
  type BootstrapStorageRouter,
  type PageFeatureSignal,
  type PageSignalRouter,
  createBootstrapStorageRouter,
  createIdleScheduler,
  createPageSignalRouter,
} from './bootstrap/router';
import {
  LazyFeatureRuntime,
  type StartedCoreFeatures,
  startCoreFeatures,
} from './bootstrap/runtime';
import { startFolderManager } from './folder/index';
import { startGentleDarkMode } from './gentleDarkMode/index';
import { initKaTeXConfig } from './katexConfig';
import { startPromptManager } from './prompt/index';
import { startTimeline } from './timeline/index';

const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
const CORE_STAGE_DELAY_MS = 50;
const PENDING_TEMP_HANDOFF_KEY = 'gv-pending-temp-regret-handoff';

function isChatGPTSite(): boolean {
  return CHATGPT_HOSTS.has(location.hostname.toLowerCase());
}

function isCurrentCustomWebsite(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const currentHost = location.hostname.toLowerCase().replace(/^www\./, '');
  return value.some((website) => {
    if (typeof website !== 'string') return false;
    const normalizedWebsite = website.toLowerCase().replace(/^www\./, '');
    return currentHost === normalizedWebsite || currentHost.endsWith(`.${normalizedWebsite}`);
  });
}

async function hasPendingTempHandoff(): Promise<boolean> {
  try {
    return sessionStorage.getItem(PENDING_TEMP_HANDOFF_KEY) !== null;
  } catch {
    return false;
  }
}

function reportFeatureError(featureName: string, error: unknown): void {
  if (isExtensionContextInvalidatedError(error)) return;
  console.error(`[GPT-Voyager] ${featureName} failed:`, error);
}

function bootstrapContentScript(): void {
  if (!hasValidExtensionContext()) return;

  let closed = false;
  let core: StartedCoreFeatures | null = null;
  let lazyRuntime: LazyFeatureRuntime | null = null;
  let storageRouter: BootstrapStorageRouter | null = null;
  let pageRouter: PageSignalRouter | null = null;
  let businessDemandRouter: BusinessDemandRouter | null = null;
  const coreDelayResolvers = new Map<number, () => void>();

  const onPreloadError = (event: Event) => event.preventDefault();
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    if (isExtensionContextInvalidatedError(event.reason)) event.preventDefault();
  };
  const onWindowError = (event: ErrorEvent) => {
    if (isExtensionContextInvalidatedError(event.error ?? event.message)) event.preventDefault();
  };

  const yieldBetweenCoreFeatures = () =>
    new Promise<void>((resolve) => {
      if (closed) {
        resolve();
        return;
      }
      const handle = window.setTimeout(() => {
        coreDelayResolvers.delete(handle);
        resolve();
      }, CORE_STAGE_DELAY_MS);
      coreDelayResolvers.set(handle, resolve);
    });

  const cancelCoreDelays = () => {
    for (const [handle, resolve] of coreDelayResolvers) {
      window.clearTimeout(handle);
      resolve();
    }
    coreDelayResolvers.clear();
  };

  const startChatGptBootstrap = () => {
    initKaTeXConfig();
    void initI18n().catch((error) => reportFeatureError('i18n', error));

    core = startCoreFeatures(
      [
        {
          id: 'formula-copy',
          start: () => {
            startFormulaCopy();
            return stopFormulaCopy;
          },
        },
        { id: 'timeline', start: startTimeline },
        { id: 'folder', start: startFolderManager },
        { id: 'gentle-dark', start: startGentleDarkMode },
        { id: 'prompt', start: startPromptManager },
      ],
      {
        onError: reportFeatureError,
        yieldBetween: yieldBetweenCoreFeatures,
      },
    );

    const activeCore = core;
    lazyRuntime = new LazyFeatureRuntime({
      features: createLazyFeatureDefinitions({
        getFolderManager: () => activeCore.getResult('folder'),
      }),
      scheduleIdle: createIdleScheduler(),
      onError: reportFeatureError,
    });
    const activeRuntime = lazyRuntime;

    let latestSettings: Readonly<Record<string, unknown>> | null = null;
    let initialSettingsApplied = false;
    let coreReady = false;

    const triggerBusinessDemand = (signal: BusinessDemandSignal) => {
      for (const featureId of BUSINESS_DEMAND_FEATURE_IDS[signal]) {
        activeRuntime.trigger(featureId);
      }
    };

    const releaseLazyWork = () => {
      if (closed || !coreReady) return;
      if (latestSettings) {
        if (initialSettingsApplied) activeRuntime.updateSettings(latestSettings);
        else {
          activeRuntime.applyInitialSettings(latestSettings);
          initialSettingsApplied = true;
        }
      }
    };

    void activeCore.ready.then(() => {
      coreReady = true;
      activeRuntime.trigger('announcement');
      releaseLazyWork();
    });

    storageRouter = createBootstrapStorageRouter({
      keys: BOOTSTRAP_SETTING_KEYS,
      onSnapshot: (settings) => {
        latestSettings = settings;
        releaseLazyWork();
      },
      onError: (error) => reportFeatureError('settings bootstrap', error),
    });

    pageRouter = createPageSignalRouter(
      (signal) => {
        activeRuntime.trigger(
          signal === 'canvas' ? PAGE_SIGNAL_FEATURE_IDS.canvas : PAGE_SIGNAL_FEATURE_IDS.tempChat,
        );
      },
      hasPendingTempHandoff,
    );

    businessDemandRouter = createBusinessDemandRouter(
      triggerBusinessDemand,
      hasPendingTempHandoff,
    );

    pageRouter.start();
    businessDemandRouter.start();
    void storageRouter.start();
  };

  const startCustomWebsiteBootstrap = () => {
    storageRouter = createBootstrapStorageRouter({
      keys: BOOTSTRAP_SETTING_KEYS,
      onSnapshot: (settings, initial) => {
        if (
          !initial ||
          closed ||
          core ||
          !isCurrentCustomWebsite(settings.gvPromptCustomWebsites)
        ) {
          return;
        }
        core = startCoreFeatures([{ id: 'prompt', start: startPromptManager }], {
          onError: reportFeatureError,
        });
      },
      onError: (error) => reportFeatureError('custom website settings bootstrap', error),
    });
    void storageRouter.start();
  };

  const shutdown = () => {
    if (closed) return;
    closed = true;
    businessDemandRouter?.stop();
    pageRouter?.stop();
    storageRouter?.stop();

    // Mark runtimes closed before resolving their staged timers/imports.
    const lazyShutdown = lazyRuntime?.shutdown();
    const coreShutdown = core?.shutdown();
    cancelCoreDelays();
    void lazyShutdown;
    void coreShutdown;

    window.removeEventListener('vite:preloadError', onPreloadError);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
    window.removeEventListener('error', onWindowError);
    window.removeEventListener('beforeunload', shutdown);
  };

  window.addEventListener('vite:preloadError', onPreloadError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  window.addEventListener('error', onWindowError);
  window.addEventListener('beforeunload', shutdown, { once: true });

  if (isChatGPTSite()) startChatGptBootstrap();
  else startCustomWebsiteBootstrap();
}

try {
  bootstrapContentScript();
} catch (error) {
  if (!isExtensionContextInvalidatedError(error)) {
    console.error('[GPT-Voyager] Fatal initialization error:', error);
  }
}
