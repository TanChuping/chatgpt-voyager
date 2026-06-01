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
  /**
   * Master on/off for the right-side timeline. When false, the timeline is
   * never mounted (and is torn down at runtime if already mounted). Distinct
   * from TIMELINE_HIDE_CONTAINER, which only hides the background bar while
   * keeping the dots. Default true. See src/pages/content/timeline/index.ts.
   */
  TIMELINE_ENABLED: 'gptTimelineEnabled',
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
  /**
   * Chat font family. Preset selection + custom-font metadata go in
   * `chrome.storage.sync` so they round-trip across devices. The actual
   * font bytes (`CHAT_CUSTOM_FONT_DATA`) live in `chrome.storage.local`
   * because sync has an 8 KB per-item cap that's far below any usable
   * font size. See `src/pages/content/chatFontFamily/index.ts`.
   */
  CHAT_FONT_FAMILY: 'gvChatFontFamily',
  CHAT_FONT_FAMILY_ENABLED: 'gvChatFontFamilyEnabled',
  CHAT_CUSTOM_FONT_NAME: 'gvChatCustomFontName',
  CHAT_CUSTOM_FONT_FORMAT: 'gvChatCustomFontFormat',
  CHAT_CUSTOM_FONT_DATA: 'gvChatCustomFontData',
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
  /**
   * Move the sidebar folder directory out of the pinned/sticky nav block and
   * mount it as a normal, scrolling sibling positioned BELOW ChatGPT's
   * "Projects" section and ABOVE the "Recent" chat list. When `false`
   * (default) the folder panel keeps its original sticky-at-top position.
   * Only affects sidebar mode (no effect in floating-panel mode).
   * See FolderManager.createFolderUI / findChatGptChatsSectionBlock.
   */
  GV_FOLDER_BELOW_PROJECTS: 'gvFolderBelowProjects',
  GV_FOLDER_FILTER_USER_ONLY: 'gvFolderFilterUserOnly',
  GV_ACCOUNT_ISOLATION_ENABLED: 'gvAccountIsolationEnabled',

  // Fork nodes
  FORK_NODES: 'gvForkNodes',
  FORK_ENABLED: 'gvForkEnabled',

  // Export
  EXPORT_IMAGE_WIDTH: 'gvExportImageWidth',
  /**
   * Single-conversation export format chosen in the popup. Drives the
   * top-bar download button. See `SingleConvExportFormat` in
   * `src/features/singleConvExport/index.ts` for the union.
   */
  SINGLE_CONV_EXPORT_FORMAT: 'gvSingleConvExportFormat',

  // Message timestamps
  GV_SHOW_MESSAGE_TIMESTAMPS: 'gvShowMessageTimestamps',
  GV_MESSAGE_TIMESTAMPS: 'gvMessageTimestamps',

  // Popup section order
  GV_POPUP_SECTION_ORDER: 'gvPopupSectionOrder',

  // Folder as Project
  FOLDER_PROJECT_ENABLED: 'gvFolderProjectEnabled',
  FOLDER_PROJECT_PENDING_FOLDER_ID: 'gvFolderProjectPendingFolderId',

  /**
   * Announcement system (1.6.5+).
   *
   * `SEEN_ID` — last announcement id the user explicitly acknowledged
   *   (clicked × on bubble OR opened the modal). Bubble pops only when
   *   the *current* id is different from this. Lives in storage.local
   *   intentionally — dismissing on one device doesn't silence the bubble
   *   on another, but each device only pops it once.
   *
   * `BUBBLE_SHOWN_FOR` — last announcement id we auto-popped the bubble
   *   for on THIS tab/device. Distinct from SEEN_ID so the bubble pops
   *   exactly once even if the user ignores it (no × click, no detail
   *   click) — without this, every page reload would re-show the bubble
   *   for the same announcement.
   *
   * `CACHE_V1` — lightly throttled cache of the remote JSON payload so
   *   we don't refetch on every tab open. Stored under `local` because
   *   the cache can be larger than sync's per-item cap.
   *
   * `LAST_BUBBLE_AT` — UNIX-ms timestamp of the most recent bubble pop,
   *   id-agnostic. Belt-and-suspenders ceiling on top of the id-based
   *   SEEN_ID / BUBBLE_SHOWN_FOR machinery: even if those flags get
   *   corrupted / out of sync / hit a race, the bubble PHYSICALLY
   *   CANNOT pop more than once per `BUBBLE_HARD_COOLDOWN_MS`
   *   (currently 14 days). This is the failsafe so a buggy detection
   *   path or a publisher mistakenly bumping the id twice can never
   *   spam users.
   *
   * `LAST_SEEN_AT` — UNIX-ms timestamp of the most recent markSeen
   *   (× / detail / megaphone-open). Hard guard for the red dot:
   *   after the user explicitly acknowledges, the dot CANNOT light
   *   up again for `DOT_HARD_COOLDOWN_MS` (currently 24 h), even if
   *   a brand-new announcement id arrives. Pairs with LAST_BUBBLE_AT
   *   so the don't-annoy-the-user contract is upheld at the storage
   *   layer rather than being purely policy code.
   */
  ANNOUNCEMENT_SEEN_ID: 'gvAnnouncementSeenId',
  ANNOUNCEMENT_BUBBLE_SHOWN_FOR: 'gvAnnouncementBubbleShownFor',
  ANNOUNCEMENT_CACHE_V1: 'gvAnnouncementCacheV1',
  ANNOUNCEMENT_LAST_BUBBLE_AT: 'gvAnnouncementLastBubbleAt',
  ANNOUNCEMENT_LAST_SEEN_AT: 'gvAnnouncementLastSeenAt',
} as const;

export type StorageKey = (typeof StorageKeys)[keyof typeof StorageKeys];
