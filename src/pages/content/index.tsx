import { StorageKeys } from '@/core/types/common';
import {
  hasValidExtensionContext,
  isExtensionContextInvalidatedError,
} from '@/core/utils/extensionContext';
import { startFormulaCopy } from '@/features/formulaCopy';
import { initI18n } from '@/utils/i18n';

import { startAnnouncement } from './announcement/index';
import { startCanvasExport } from './canvasExport/index';
import { startChatFontFamilyAdjuster } from './chatFontFamily/index';
import { startChatFontSizeAdjuster } from './chatFontSize/index';
import { startInputVimMode } from './chatInput/vimMode';
import { startChatWidthAdjuster } from './chatWidth/index';
import { startSingleConversationExport } from './conversationExport/index';
import { startDraftSave } from './draftSave/index';
import { startEditInputWidthAdjuster } from './editInputWidth/index';
import { startExportButton } from './export/index';
import { startFolderManager } from './folder/index';
import { startFolderProject } from './folderProject/index';
import { startFolderSpacingAdjuster } from './folderSpacing/index';
import { isForkFeatureEnabledValue } from './fork/featureFlag';
import { startFork } from './fork/index';
import { startGentleDarkMode } from './gentleDarkMode/index';
import { startInputCollapse } from './inputCollapse/index';
import { initKaTeXConfig } from './katexConfig';
import { startMarkdownPatcher } from './markdownPatcher/index';
import { startMermaid } from './mermaid/index';
import { startPreventAutoScroll } from './preventAutoScroll/index';
import { startPromptManager } from './prompt/index';
import { startQuoteReply } from './quoteReply/index';
import { startSendBehavior } from './sendBehavior/index';
import { startSidebarAutoHide } from './sidebarAutoHide';
import { startSidebarWidthAdjuster } from './sidebarWidth';
import { startTempChatExit } from './tempChatExit/index';
import { startTimeline } from './timeline/index';
import { startUserLatex } from './userLatex/index';

window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
});

const HEAVY_FEATURE_INIT_DELAY = 100;
const LIGHT_FEATURE_INIT_DELAY = 50;
const BACKGROUND_TAB_MIN_DELAY = 3000;
const BACKGROUND_TAB_MAX_DELAY = 8000;

const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);

let initialized = false;
let initializationTimer: number | null = null;
let folderManagerInstance: Awaited<ReturnType<typeof startFolderManager>> | null = null;
let promptManagerInstance: Awaited<ReturnType<typeof startPromptManager>> | null = null;
let quoteReplyCleanup: (() => void) | null = null;
let inputVimModeCleanup: (() => void) | null = null;
let sendBehaviorCleanup: (() => void) | null = null;
let draftSaveCleanup: (() => void) | null = null;
let forkCleanup: (() => void) | null = null;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isChatGPTSite(): boolean {
  return CHATGPT_HOSTS.has(location.hostname.toLowerCase());
}

async function runFeatureStep<T>(
  featureName: string,
  start: () => T | Promise<T>,
  initDelay = LIGHT_FEATURE_INIT_DELAY,
): Promise<T | null> {
  try {
    return await start();
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) return null;
    console.error(`[GPT-Voyager] ${featureName} failed to start:`, error);
    return null;
  } finally {
    if (initDelay > 0) await delay(initDelay);
  }
}

async function isForkFeatureEnabled(): Promise<boolean> {
  try {
    const result = await chrome.storage?.sync?.get({ [StorageKeys.FORK_ENABLED]: false });
    return isForkFeatureEnabledValue(result?.[StorageKeys.FORK_ENABLED]);
  } catch {
    return false;
  }
}

async function isCustomWebsite(): Promise<boolean> {
  try {
    const result = await chrome.storage?.sync?.get({ [StorageKeys.PROMPT_CUSTOM_WEBSITES]: [] });
    const customWebsites = Array.isArray(result?.[StorageKeys.PROMPT_CUSTOM_WEBSITES])
      ? (result[StorageKeys.PROMPT_CUSTOM_WEBSITES] as string[])
      : [];
    const currentHost = location.hostname.toLowerCase().replace(/^www\./, '');

    return customWebsites.some((website: string) => {
      const normalizedWebsite = website.toLowerCase().replace(/^www\./, '');
      return currentHost === normalizedWebsite || currentHost.endsWith(`.${normalizedWebsite}`);
    });
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) return false;
    console.error('[GPT-Voyager] Error checking custom websites:', error);
    return false;
  }
}

async function startPromptManagerOnly(): Promise<void> {
  promptManagerInstance = await startPromptManager();
}

async function startChatGPTFeatures(): Promise<void> {
  await runFeatureStep('Timeline', () => startTimeline(), HEAVY_FEATURE_INIT_DELAY);

  folderManagerInstance =
    (await runFeatureStep('Folder Manager', () => startFolderManager(), 0)) ?? null;
  if (folderManagerInstance) {
    await runFeatureStep(
      'Folder Project',
      () => startFolderProject(folderManagerInstance!),
      HEAVY_FEATURE_INIT_DELAY,
    );
  } else {
    await delay(HEAVY_FEATURE_INIT_DELAY);
  }

  await runFeatureStep('Folder Spacing Adjuster', () => startFolderSpacingAdjuster());
  await runFeatureStep('Chat Width Adjuster', () => startChatWidthAdjuster());
  await runFeatureStep('Chat Font Size Adjuster', () => startChatFontSizeAdjuster());
  await runFeatureStep('Chat Font Family Adjuster', () => startChatFontFamilyAdjuster());
  await runFeatureStep('Edit Input Width Adjuster', () => startEditInputWidthAdjuster());
  await runFeatureStep('Sidebar Width Adjuster', () => startSidebarWidthAdjuster());
  await runFeatureStep('Gentle Dark Mode', () => startGentleDarkMode());
  await runFeatureStep('Sidebar Auto Hide', () => startSidebarAutoHide());
  await runFeatureStep('Input Collapse', () => startInputCollapse());

  inputVimModeCleanup = (await runFeatureStep('Input Vim Mode', () => startInputVimMode())) ?? null;

  await runFeatureStep('Prevent Auto Scroll', () => startPreventAutoScroll());
  await runFeatureStep('Formula Copy', () => startFormulaCopy());

  await runFeatureStep('Quote Reply', async () => {
    const quoteReplyResult = await chrome.storage?.sync?.get({
      [StorageKeys.QUOTE_REPLY_ENABLED]: true,
    });
    if (quoteReplyResult?.[StorageKeys.QUOTE_REPLY_ENABLED] !== false) {
      quoteReplyCleanup = startQuoteReply();
    }
  });

  sendBehaviorCleanup = (await runFeatureStep('Send Behavior', () => startSendBehavior())) ?? null;
  draftSaveCleanup = (await runFeatureStep('Draft Save', () => startDraftSave())) ?? null;

  await runFeatureStep('Markdown Patcher', () => startMarkdownPatcher());
  await runFeatureStep('Export Button', () => startExportButton());
  await runFeatureStep('Canvas Export', () => startCanvasExport());
  await runFeatureStep('Single-Conversation Export', () => startSingleConversationExport());
  await runFeatureStep('Announcement', () => startAnnouncement());
  await runFeatureStep('Temp Chat Regret', () => startTempChatExit());

  await runFeatureStep('Fork', async () => {
    if (await isForkFeatureEnabled()) forkCleanup = startFork();
  });

  promptManagerInstance =
    (await runFeatureStep(
      'Prompt Manager',
      () => startPromptManager(),
      HEAVY_FEATURE_INIT_DELAY,
    )) ?? null;

  await runFeatureStep('Mermaid', () => startMermaid());
  await runFeatureStep('User LaTeX', () => startUserLatex(), 0);
}

async function initializeFeatures(): Promise<void> {
  if (initialized) return;
  initialized = true;

  try {
    if (!hasValidExtensionContext()) return;

    if (isChatGPTSite()) {
      await startChatGPTFeatures();
      return;
    }

    if (await isCustomWebsite()) {
      await startPromptManagerOnly();
    }
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) return;
    console.error('[GPT-Voyager] Initialization error:', error);
  }
}

function getInitializationDelay(): number {
  if (document.visibilityState === 'visible') return 0;
  const randomRange = BACKGROUND_TAB_MAX_DELAY - BACKGROUND_TAB_MIN_DELAY;
  return BACKGROUND_TAB_MIN_DELAY + Math.random() * randomRange;
}

function handleVisibilityChange(): void {
  if (document.visibilityState === 'visible' && !initialized) {
    if (initializationTimer !== null) {
      clearTimeout(initializationTimer);
      initializationTimer = null;
    }
    void initializeFeatures();
  }
}

(function () {
  try {
    if (!hasValidExtensionContext()) return;

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isExtensionContextInvalidatedError(event.reason)) {
        event.preventDefault();
      }
    };
    const onWindowError = (event: ErrorEvent) => {
      if (isExtensionContextInvalidatedError(event.error ?? event.message)) {
        event.preventDefault();
      }
    };
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    window.addEventListener('error', onWindowError);

    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'sync' || !isChatGPTSite()) return;

      const forkSetting = changes[StorageKeys.FORK_ENABLED];
      if (!forkSetting) return;

      const enabled = isForkFeatureEnabledValue(forkSetting.newValue);
      if (enabled) {
        if (!forkCleanup) forkCleanup = startFork();
      } else if (forkCleanup) {
        forkCleanup();
        forkCleanup = null;
      }
    };

    const hostname = location.hostname.toLowerCase();
    const isSupportedSite = CHATGPT_HOSTS.has(hostname);

    if (isSupportedSite) {
      initKaTeXConfig();
      initI18n().catch((error) => console.error('[GPT-Voyager] i18n init error:', error));
    }

    if (!isSupportedSite) {
      chrome.storage?.sync?.get({ [StorageKeys.PROMPT_CUSTOM_WEBSITES]: [] }, (result) => {
        const customWebsites = Array.isArray(result?.[StorageKeys.PROMPT_CUSTOM_WEBSITES])
          ? (result[StorageKeys.PROMPT_CUSTOM_WEBSITES] as string[])
          : [];
        const currentHost = hostname.replace(/^www\./, '');
        const isCustomSite = customWebsites.some((website: string) => {
          const normalizedWebsite = website.toLowerCase().replace(/^www\./, '');
          return currentHost === normalizedWebsite || currentHost.endsWith(`.${normalizedWebsite}`);
        });

        if (isCustomSite) void initializeFeatures();
      });
      return;
    }

    chrome.storage?.onChanged?.addListener(onStorageChanged);

    const initDelay = isSupportedSite ? 0 : getInitializationDelay();
    if (initDelay === 0) {
      void initializeFeatures();
    } else {
      initializationTimer = window.setTimeout(() => {
        initializationTimer = null;
        void initializeFeatures();
      }, initDelay);
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    window.addEventListener('beforeunload', () => {
      try {
        window.removeEventListener('unhandledrejection', onUnhandledRejection);
        window.removeEventListener('error', onWindowError);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        chrome.storage?.onChanged?.removeListener(onStorageChanged);

        folderManagerInstance?.destroy();
        folderManagerInstance = null;
        promptManagerInstance?.destroy();
        promptManagerInstance = null;
        quoteReplyCleanup?.();
        quoteReplyCleanup = null;
        inputVimModeCleanup?.();
        inputVimModeCleanup = null;
        sendBehaviorCleanup?.();
        sendBehaviorCleanup = null;
        draftSaveCleanup?.();
        draftSaveCleanup = null;
        forkCleanup?.();
        forkCleanup = null;
      } catch (error) {
        if (isExtensionContextInvalidatedError(error)) return;
        console.error('[GPT-Voyager] Cleanup error:', error);
      }
    });
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) return;
    console.error('[GPT-Voyager] Fatal initialization error:', error);
  }
})();
