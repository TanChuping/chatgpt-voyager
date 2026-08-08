import { StorageKeys } from '@/core/types/common';

import type { BusinessDemandSignal } from './demand';
import type { BootstrapSettings, LazyFeatureDefinition } from './runtime';

export const CORE_FEATURE_IDS = ['timeline', 'folder', 'gentle-dark', 'prompt'] as const;

export const BOOTSTRAP_SETTING_KEYS = [
  StorageKeys.CHAT_WIDTH,
  StorageKeys.CHAT_WIDTH_ENABLED,
  StorageKeys.CHAT_FONT_SIZE_ENABLED,
  StorageKeys.CODE_FONT_SIZE_ENABLED,
  StorageKeys.LONG_CODE_BLOCK_COLLAPSE_ENABLED,
  StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED,
  StorageKeys.CHAT_LINE_HEIGHT_ENABLED,
  StorageKeys.CHAT_PARAGRAPH_SPACING_ENABLED,
  StorageKeys.CHAT_FONT_FAMILY_ENABLED,
  StorageKeys.EDIT_INPUT_WIDTH,
  StorageKeys.EDIT_INPUT_WIDTH_ENABLED,
  StorageKeys.SIDEBAR_WIDTH,
  StorageKeys.GV_SIDEBAR_AUTO_HIDE,
  StorageKeys.GV_SIDEBAR_FULL_HIDE,
  StorageKeys.GV_FOLDER_SPACING,
  StorageKeys.GV_FOLDER_ITEM_FONT_SIZE,
  StorageKeys.CTRL_ENTER_SEND,
  StorageKeys.SAFARI_ENTER_FIX,
  StorageKeys.INPUT_COLLAPSE_ENABLED,
  StorageKeys.INPUT_VIM_MODE,
  StorageKeys.DRAFT_AUTO_SAVE,
  StorageKeys.PREVENT_AUTO_SCROLL_ENABLED,
  StorageKeys.QUOTE_REPLY_ENABLED,
  StorageKeys.MERMAID_ENABLED,
  StorageKeys.FORK_ENABLED,
  StorageKeys.FOLDER_PROJECT_ENABLED,
  StorageKeys.FOLDER_HEADER_BUTTON_ENABLED,
  StorageKeys.PROMPT_CUSTOM_WEBSITES,
] as const;

export const PAGE_SIGNAL_FEATURE_IDS = {
  canvas: 'canvas-export',
  tempChat: 'temp-chat-exit',
} as const;

export const BUSINESS_DEMAND_FEATURE_IDS: Readonly<
  Record<BusinessDemandSignal, readonly string[]>
> = {
  'quote-selection': ['quote-reply'],
  'mermaid-code': ['mermaid'],
  'broken-markdown': ['markdown-patcher'],
  'user-message-latex': ['user-latex'],
  'conversation-route': ['conversation-export'],
  'export-menu-interaction': ['export-button'],
  'pending-export': ['export-button', 'conversation-export'],
  'announcement-interaction': ['announcement'],
};

export interface LazyFeatureDependencies {
  getFolderManager: () => Promise<unknown | null>;
}

function isTrue(settings: BootstrapSettings, key: string): boolean {
  return settings[key] === true;
}

function isDefaultTrue(settings: BootstrapSettings, key: string): boolean {
  return settings[key] !== false;
}

function normalizeLegacyPercent(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const percent = value > 100 ? (value / 1200) * 100 : value;
  return Math.min(100, Math.max(30, Math.round(percent)));
}

function isEnabledWithLegacyPercent(
  settings: BootstrapSettings,
  enabledKey: string,
  valueKey: string,
  defaultPercent: number,
): boolean {
  const enabled = settings[enabledKey];
  if (enabled !== undefined) return enabled === true;
  const stored = settings[valueKey];
  return (
    typeof stored === 'number' &&
    Number.isFinite(stored) &&
    normalizeLegacyPercent(stored, defaultPercent) !== defaultPercent
  );
}

function isExplicitNonDefaultFolderSpacing(settings: BootstrapSettings): boolean {
  const stored = settings[StorageKeys.GV_FOLDER_SPACING];
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return false;
  return Math.min(16, Math.max(0, Math.round(stored))) !== 2;
}

function isExplicitNonDefaultFolderItemFontSize(settings: BootstrapSettings): boolean {
  const stored = settings[StorageKeys.GV_FOLDER_ITEM_FONT_SIZE];
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return false;
  return Math.min(18, Math.max(12, Math.round(stored))) !== 13;
}

function isExplicitNonDefaultSidebarWidth(settings: BootstrapSettings): boolean {
  const stored = settings[StorageKeys.SIDEBAR_WIDTH];
  if (stored === undefined || stored === null || stored === '') return false;
  const numeric = Number(stored);
  if (!Number.isFinite(numeric)) return false;
  const pixels =
    numeric <= 45
      ? Math.min(600, Math.max(240, Math.round((numeric / 100) * 1200)))
      : Math.min(600, Math.max(240, Math.round(numeric)));
  return pixels !== 280;
}

/** Literal import paths are intentional: Vite emits one or more lazy chunks. */
export function createLazyFeatureDefinitions(
  dependencies: LazyFeatureDependencies,
): LazyFeatureDefinition[] {
  return [
    {
      id: 'chat-width',
      initial: 'immediate',
      isEnabled: (settings) =>
        isEnabledWithLegacyPercent(
          settings,
          StorageKeys.CHAT_WIDTH_ENABLED,
          StorageKeys.CHAT_WIDTH,
          70,
        ),
      load: async () => {
        const module = await import('../chatWidth/index');
        return {
          start: module.startChatWidthAdjuster,
          stop: module.stopChatWidthAdjuster,
        };
      },
    },
    {
      id: 'chat-font-size',
      initial: 'immediate',
      isEnabled: (settings) =>
        isTrue(settings, StorageKeys.CHAT_FONT_SIZE_ENABLED) ||
        isTrue(settings, StorageKeys.CODE_FONT_SIZE_ENABLED),
      load: async () => {
        const module = await import('../chatFontSize/index');
        return {
          start: module.startChatFontSizeAdjuster,
          stop: module.stopChatFontSizeAdjuster,
        };
      },
    },
    {
      id: 'chat-spacing',
      initial: 'immediate',
      isEnabled: (settings) =>
        isTrue(settings, StorageKeys.CHAT_LINE_HEIGHT_ENABLED) ||
        isTrue(settings, StorageKeys.CHAT_PARAGRAPH_SPACING_ENABLED),
      load: async () => {
        const module = await import('../chatSpacing/index');
        return {
          start: module.startChatSpacingAdjuster,
          stop: module.stopChatSpacingAdjuster,
        };
      },
    },
    {
      id: 'long-code-block-collapse',
      initial: 'immediate',
      isEnabled: (settings) => isTrue(settings, StorageKeys.LONG_CODE_BLOCK_COLLAPSE_ENABLED),
      load: async () => {
        const module = await import('../codeBlockCollapse/index');
        return {
          start: module.startCodeBlockCollapse,
          stop: module.stopCodeBlockCollapse,
        };
      },
    },
    {
      id: 'response-complete-notification',
      initial: 'immediate',
      isEnabled: (settings) =>
        isDefaultTrue(settings, StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED),
      load: async () => {
        const module = await import('../responseNotification/index');
        return {
          start: module.startResponseNotification,
          stop: module.stopResponseNotification,
        };
      },
    },
    {
      id: 'chat-font-family',
      initial: 'immediate',
      isEnabled: (settings) => isTrue(settings, StorageKeys.CHAT_FONT_FAMILY_ENABLED),
      load: async () => {
        const module = await import('../chatFontFamily/index');
        return {
          start: module.startChatFontFamilyAdjuster,
          stop: module.stopChatFontFamilyAdjuster,
        };
      },
    },
    {
      id: 'edit-input-width',
      initial: 'immediate',
      isEnabled: (settings) =>
        isEnabledWithLegacyPercent(
          settings,
          StorageKeys.EDIT_INPUT_WIDTH_ENABLED,
          StorageKeys.EDIT_INPUT_WIDTH,
          60,
        ),
      load: async () => {
        const module = await import('../editInputWidth/index');
        return {
          start: module.startEditInputWidthAdjuster,
          stop: module.stopEditInputWidthAdjuster,
        };
      },
    },
    {
      id: 'sidebar-auto-hide',
      initial: 'immediate',
      isEnabled: (settings) =>
        isTrue(settings, StorageKeys.GV_SIDEBAR_AUTO_HIDE) ||
        isTrue(settings, StorageKeys.GV_SIDEBAR_FULL_HIDE),
      load: async () => {
        const module = await import('../sidebarAutoHide/index');
        return {
          start: () => {
            module.startSidebarAutoHide();
            return () => module.stopSidebarAutoHide(false);
          },
          stop: () => module.stopSidebarAutoHide(false),
          persistentSettingBridge: true,
        };
      },
    },
    {
      id: 'input-collapse',
      initial: 'immediate',
      isEnabled: (settings) => isTrue(settings, StorageKeys.INPUT_COLLAPSE_ENABLED),
      load: async () => {
        const module = await import('../inputCollapse/index');
        return { start: module.startInputCollapse, stop: module.cleanup };
      },
    },
    {
      id: 'input-vim-mode',
      initial: 'immediate',
      isEnabled: (settings) => isTrue(settings, StorageKeys.INPUT_VIM_MODE),
      load: async () => {
        const module = await import('../chatInput/vimMode');
        return { start: module.startInputVimMode, stop: module.stopInputVimMode };
      },
    },
    {
      id: 'draft-save',
      initial: 'immediate',
      isEnabled: (settings) => isTrue(settings, StorageKeys.DRAFT_AUTO_SAVE),
      load: async () => {
        const module = await import('../draftSave/index');
        return { start: module.startDraftSave, stop: module.stopDraftSave };
      },
    },
    {
      id: 'prevent-auto-scroll',
      initial: 'immediate',
      isEnabled: (settings) => isTrue(settings, StorageKeys.PREVENT_AUTO_SCROLL_ENABLED),
      load: async () => {
        const module = await import('../preventAutoScroll/index');
        return {
          start: module.startPreventAutoScroll,
          stop: module.stopPreventAutoScroll,
        };
      },
    },
    {
      id: 'fork',
      initial: 'immediate',
      isEnabled: (settings) => isTrue(settings, StorageKeys.FORK_ENABLED),
      load: async () => {
        const module = await import('../fork/index');
        return { start: module.startFork };
      },
    },
    {
      id: 'folder-project',
      initial: 'immediate',
      isEnabled: (settings) => isTrue(settings, StorageKeys.FOLDER_PROJECT_ENABLED),
      load: async () => {
        const module = await import('../folderProject/index');
        let generation = 0;
        return {
          start: async () => {
            const currentGeneration = ++generation;
            const manager = await dependencies.getFolderManager();
            if (!manager || currentGeneration !== generation) return;
            return module.startFolderProject(
              manager as Parameters<typeof module.startFolderProject>[0],
            );
          },
          stop: () => {
            generation += 1;
            module.stopFolderProject();
          },
          persistentSettingBridge: true,
        };
      },
    },
    {
      // Opt-in second entry point for "add to folder" (issue #8). Off by
      // default, so the module is never imported unless the user asks for it.
      id: 'folder-header-button',
      initial: 'immediate',
      isEnabled: (settings) => isTrue(settings, StorageKeys.FOLDER_HEADER_BUTTON_ENABLED),
      load: async () => {
        const module = await import('../folderHeaderButton/index');
        let generation = 0;
        return {
          start: async () => {
            const currentGeneration = ++generation;
            const manager = await dependencies.getFolderManager();
            if (!manager || currentGeneration !== generation) return;
            return module.startFolderHeaderButton(
              manager as Parameters<typeof module.startFolderHeaderButton>[0],
            );
          },
          stop: () => {
            generation += 1;
            module.stopFolderHeaderButton();
          },
        };
      },
    },
    {
      id: 'send-behavior',
      initial: 'immediate',
      isEnabled: (settings) =>
        isTrue(settings, StorageKeys.CTRL_ENTER_SEND) ||
        isTrue(settings, StorageKeys.SAFARI_ENTER_FIX),
      load: async () => {
        const module = await import('../sendBehavior/index');
        return { start: module.startSendBehavior, stop: module.stopSendBehavior };
      },
    },
    {
      id: 'quote-reply',
      activation: 'setting-and-event',
      initial: 'immediate',
      isEnabled: (settings) => isDefaultTrue(settings, StorageKeys.QUOTE_REPLY_ENABLED),
      load: async () => {
        const module = await import('../quoteReply/index');
        return { start: module.startQuoteReply };
      },
    },
    {
      id: 'mermaid',
      activation: 'setting-and-event',
      initial: 'immediate',
      isEnabled: (settings) => isDefaultTrue(settings, StorageKeys.MERMAID_ENABLED),
      load: async () => {
        const module = await import('../mermaid/index');
        return {
          start: module.startMermaid,
          stop: module.stopMermaid,
        };
      },
    },
    {
      id: 'folder-spacing',
      initial: 'immediate',
      isEnabled: isExplicitNonDefaultFolderSpacing,
      load: async () => {
        const module = await import('../folderSpacing/index');
        return {
          start: module.startFolderSpacingAdjuster,
          stop: module.stopFolderSpacingAdjuster,
        };
      },
    },
    {
      id: 'folder-item-font-size',
      initial: 'immediate',
      isEnabled: isExplicitNonDefaultFolderItemFontSize,
      load: async () => {
        const module = await import('../folderItemFontSize/index');
        return {
          start: module.startFolderItemFontSizeAdjuster,
          stop: module.stopFolderItemFontSizeAdjuster,
        };
      },
    },
    {
      id: 'sidebar-width',
      initial: 'immediate',
      isEnabled: isExplicitNonDefaultSidebarWidth,
      load: async () => {
        const module = await import('../sidebarWidth/index');
        return {
          start: module.startSidebarWidthAdjuster,
          stop: module.stopSidebarWidthAdjuster,
        };
      },
    },
    {
      id: 'markdown-patcher',
      activation: 'event',
      initial: 'immediate',
      load: async () => {
        const module = await import('../markdownPatcher/index');
        return { start: module.startMarkdownPatcher };
      },
    },
    {
      id: 'export-button',
      activation: 'event',
      initial: 'immediate',
      load: async () => {
        const module = await import('../export/index');
        return { start: module.startExportButton, stop: module.stopExportButton };
      },
    },
    {
      id: 'conversation-export',
      activation: 'event',
      initial: 'immediate',
      load: async () => {
        const module = await import('../conversationExport/index');
        const lifecycleModule = module as typeof module & {
          stopSingleConversationExport?: () => void;
        };
        return {
          start: module.startSingleConversationExport,
          stop: lifecycleModule.stopSingleConversationExport,
        };
      },
    },
    {
      id: 'announcement',
      activation: 'event',
      initial: 'immediate',
      load: async () => {
        const module = await import('../announcement/index');
        return { start: module.startAnnouncement, stop: module.stopAnnouncement };
      },
    },
    {
      id: 'user-latex',
      activation: 'event',
      initial: 'immediate',
      load: async () => {
        const module = await import('../userLatex/index');
        return {
          start: module.startUserLatex,
          stop: module.stopUserLatex,
        };
      },
    },
    {
      id: PAGE_SIGNAL_FEATURE_IDS.canvas,
      activation: 'event',
      initial: 'immediate',
      load: async () => {
        const module = await import('../canvasExport/index');
        return { start: module.startCanvasExport, stop: module.stopCanvasExport };
      },
    },
    {
      id: PAGE_SIGNAL_FEATURE_IDS.tempChat,
      activation: 'event',
      initial: 'immediate',
      load: async () => {
        const module = await import('../tempChatExit/index');
        return { start: module.startTempChatExit, stop: module.stopTempChatExit };
      },
    },
  ];
}
