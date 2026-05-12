/**
 * Common types used throughout the application
 * Following strict type safety principles
 */

export type Result<T, E = Error> = { success: true; data: T } | { success: false; error: E };

export interface IDisposable {
  dispose(): void;
}

export interface ILogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;
export type Maybe<T> = T | null | undefined;

/**
 * Brand type for type-safe IDs
 */
export type Brand<K, T> = K & { __brand: T };

export type ConversationId = Brand<string, 'ConversationId'>;
export type FolderId = Brand<string, 'FolderId'>;
export type TurnId = Brand<string, 'TurnId'>;

/**
 * Storage keys - centralized for type safety
 */
export const StorageKeys = {
  // Folder system
  FOLDER_DATA: 'gvFolderData',
  FOLDER_ENABLED: 'gptFolderEnabled',
  FOLDER_HIDE_ARCHIVED_CONVERSATIONS: 'gptFolderHideArchivedConversations',
  FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN: 'gptFolderHideArchivedNudgeShown',
  FOLDER_FLOATING_MODE_ENABLED: 'gptFolderFloatingModeEnabled',
  FOLDER_FLOATING_NUDGE_SHOWN: 'gptFolderFloatingNudgeShown',
  FOLDER_FLOATING_POS: 'gptFolderFloatingPos',
  FOLDER_FLOATING_FAB_POS: 'gptFolderFloatingFabPos',
  FOLDER_FLOATING_SIZE: 'gptFolderFloatingSize',

  // Timeline
  TIMELINE_SCROLL_MODE: 'gptTimelineScrollMode',
  TIMELINE_HIDE_CONTAINER: 'gptTimelineHideContainer',
  TIMELINE_BAR_WIDTH: 'gptTimelineBarWidth',
  TIMELINE_DRAGGABLE: 'gptTimelineDraggable',
  TIMELINE_POSITION: 'gptTimelinePosition',
  TIMELINE_PREVIEW_PINNED: 'gptTimelinePreviewPinned',
  TIMELINE_MARKER_LEVEL: 'gptTimelineMarkerLevel',
  TIMELINE_STARRED_MESSAGES: 'gptTimelineStarredMessages',
  TIMELINE_HIERARCHY: 'gptTimelineHierarchy',
  TIMELINE_SHORTCUTS: 'gptTimelineShortcuts',

  // UI customization
  CHAT_WIDTH: 'gptChatWidth',
  CHAT_WIDTH_ENABLED: 'gvChatWidthEnabled',
  CHAT_FONT_SIZE: 'gvChatFontSize',
  CHAT_FONT_SIZE_ENABLED: 'gvChatFontSizeEnabled',
  CODE_FONT_SIZE: 'gvCodeFontSize',
  CODE_FONT_SIZE_ENABLED: 'gvCodeFontSizeEnabled',
  EDIT_INPUT_WIDTH: 'gptEditInputWidth',
  EDIT_INPUT_WIDTH_ENABLED: 'gvEditInputWidthEnabled',
  SIDEBAR_WIDTH: 'gptSidebarWidth',
  SIDEBAR_WIDTH_ENABLED: 'gvSidebarWidthEnabled',

  // Prompt Manager
  PROMPT_ITEMS: 'gvPromptItems',
  PROMPT_PANEL_LOCKED: 'gvPromptPanelLocked',
  PROMPT_PANEL_POSITION: 'gvPromptPanelPosition',
  PROMPT_TRIGGER_POSITION: 'gvPromptTriggerPosition',
  PROMPT_CUSTOM_WEBSITES: 'gvPromptCustomWebsites',
  PROMPT_THEME: 'gvPromptTheme',
  PROMPT_INSERT_ON_CLICK: 'gvPromptInsertOnClick',
  PROMPT_VIEW_MODE: 'gvPromptViewMode',

  // Global settings
  LANGUAGE: 'language',
  FORMULA_COPY_FORMAT: 'gvFormulaCopyFormat',
  HIDE_PROMPT_MANAGER: 'gvHidePromptManager',
  MERMAID_ENABLED: 'gvMermaidEnabled',
  QUOTE_REPLY_ENABLED: 'gvQuoteReplyEnabled',

  // Input behavior
  CTRL_ENTER_SEND: 'gvCtrlEnterSend',
  SAFARI_ENTER_FIX: 'gvSafariEnterFix',
  INPUT_COLLAPSE_ENABLED: 'gvInputCollapseEnabled',
  INPUT_COLLAPSE_WHEN_NOT_EMPTY: 'gvInputCollapseWhenNotEmpty',
  INPUT_VIM_MODE: 'gvInputVimMode',
  DRAFT_AUTO_SAVE: 'gvDraftAutoSave',
  PREVENT_AUTO_SCROLL_ENABLED: 'gvPreventAutoScrollEnabled',

  // Sidebar behavior
  GV_SIDEBAR_AUTO_HIDE: 'gvSidebarAutoHide',
  GV_SIDEBAR_FULL_HIDE: 'gvSidebarFullHide',

  // Folder spacing
  GV_FOLDER_SPACING: 'gvFolderSpacing',
  GV_FOLDER_TREE_INDENT: 'gvFolderTreeIndent',
  GV_FOLDER_FILTER_USER_ONLY: 'gvFolderFilterUserOnly',
  GV_ACCOUNT_ISOLATION_ENABLED: 'gvAccountIsolationEnabled',

  // Fork nodes
  FORK_NODES: 'gvForkNodes',
  FORK_ENABLED: 'gvForkEnabled',

  // Export
  EXPORT_IMAGE_WIDTH: 'gvExportImageWidth',

  // Message timestamps
  GV_SHOW_MESSAGE_TIMESTAMPS: 'gvShowMessageTimestamps',
  GV_MESSAGE_TIMESTAMPS: 'gvMessageTimestamps',

  // Popup section order
  GV_POPUP_SECTION_ORDER: 'gvPopupSectionOrder',

  // Folder as Project
  FOLDER_PROJECT_ENABLED: 'gvFolderProjectEnabled',
  FOLDER_PROJECT_PENDING_FOLDER_ID: 'gvFolderProjectPendingFolderId',
} as const;

export type StorageKey = (typeof StorageKeys)[keyof typeof StorageKeys];
