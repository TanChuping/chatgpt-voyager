import browser from 'webextension-polyfill';

import {
  createChevronDownIcon,
  createChevronRightIcon,
  createEyeIcon,
  createEyeOffIcon,
  createFolderIcon,
  createPlusIcon,
  createSettingsIcon,
} from '@/core/icons/folderIcons';
import {
  type AccountScope,
  accountIsolationService,
  buildScopedFolderStorageKey,
  detectAccountContextFromDocument,
} from '@/core/services/AccountIsolationService';
import { DataBackupService } from '@/core/services/DataBackupService';
import { StorageKeys } from '@/core/types/common';
import type { SyncAccountScope } from '@/core/types/sync';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';
import { FolderImportExportService } from '@/features/folder/services/FolderImportExportService';
import {
  type ImportStrategy,
  type ValidationError,
  ValidationErrorType,
} from '@/features/folder/types/import-export';
import { sanitizeFolderConversationUrl } from '@/features/folder/utils/conversationUrlSecurity';
import { getTranslationSync, getTranslationSyncUnsafe, initI18n } from '@/utils/i18n';

import {
  extractChatGptConversationIdFromUrl,
  findChatGptHistoryContainer,
  findChatGptSidebar,
  getChatGptConversationElements,
  getChatGptConversationId,
  getChatGptConversationTitle,
  getChatGptConversationUrl,
  normalizeChatGptConversationId,
} from '../chatgptDom';
import { type ConversationSortMode, sortConversationsByPriority } from './conversationSort';
import { type FloatingFabPos, mountFloatingFab, unmountFloatingFab } from './floatingModeFab';
import { unmountFloatingModeNudge } from './floatingModeNudge';
import {
  type FloatingPanelHandle,
  type FloatingPanelPos,
  type FloatingPanelSize,
  mountFloatingPanel,
} from './floatingPanel';
import { FOLDER_COLORS, getFolderColor, isDarkMode } from './folderColors';
import { createFolderSvgIcon } from './folderIcon';
import { DEFAULT_CONVERSATION_ICON } from './gptConfig';
import {
  mountHideArchivedNudge,
  shouldShowHideArchivedNudge,
  unmountHideArchivedNudge,
} from './hideArchivedNudge';
import { createMoveToFolderMenuItem } from './moveToFolderMenuItem';
import {
  type NativeConversationContext,
  type NativeMenuOwnershipSnapshot,
  clearNativeMenuOwnership,
  closeNativeConversationMenu,
  closeNativeDeleteDialog,
  createNativeMenuOwnershipSnapshot,
  findConversationOptionsButton,
  findConversationOptionsTrigger,
  findDeleteConversationConfirmButton,
  findDeleteConversationMenuItem,
  findNativeConversationMenusInNode,
  findNativeDeleteDialogsInNode,
  getNativeConversationMenus,
  getNativeDeleteDialogs,
  isElementOpen,
  isHeaderConversationOptionsTrigger,
  isNativeConversationMenuBoundToTrigger,
  isOwnedNativeConversationMenu,
  isOwnedNativeDeleteDialog,
  resolveSidebarConversationContext,
} from './nativeConversationBridge';
import {
  type IFolderStorageAdapter,
  createFolderStorageAdapter,
  isValidFolderData,
} from './storage/FolderStorageAdapter';
import type { ConversationReference, DragData, Folder, FolderData } from './types';

const STORAGE_KEY = 'gvFolderData';
export const SESSION_BACKUP_KEY = 'gvFolderBackup';
export const SESSION_BACKUP_TIMESTAMP_KEY = 'gvFolderBackupTimestamp';
const IS_DEBUG = false; // Set to true to enable debug logging
const ROOT_CONVERSATIONS_ID = '__root_conversations__'; // Special ID for root-level conversations
const NOTIFICATION_TIMEOUT_MS = 10000; // Duration to show data loss notification
const FOLDER_TREE_INDENT_MIN = -8;
const FOLDER_TREE_INDENT_MAX = 32;
const FOLDER_TREE_INDENT_DEFAULT = -8;
// Max folder nesting depth 鈥?matches the floating panel's MAX_FOLDER_DEPTH.
// root = 0, subfolder = 1, and that's the limit. Pre-existing data deeper
// than this stays intact (we never destroy user data); the cap only gates
// *new* creation. Moves remain unconstrained for the same reason.
const MAX_FOLDER_DEPTH = 1;
const FOLDER_NAME_SINGLE_CLICK_DELAY_MS = 220;
const FOLDER_NAVIGATION_CONFIRM_DELAY_MS = 300;
const FOLDER_SEARCH_DEBOUNCE_MS = 200;

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

export function clampFolderTreeIndent(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return FOLDER_TREE_INDENT_DEFAULT;
  return Math.min(FOLDER_TREE_INDENT_MAX, Math.max(FOLDER_TREE_INDENT_MIN, Math.round(numeric)));
}

export function calculateFolderHeaderPaddingLeft(level: number, indent: number): number {
  return Math.max(0, level * indent + 8);
}

export function calculateFolderConversationPaddingLeft(level: number, indent: number): number {
  return Math.max(0, level * indent + 24);
}

type FolderSearchCriteria = { mode: 'all' | 'folder'; query: string };

function normalizeFolderSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().trim();
}

function parseFolderSearchCriteria(value: string): FolderSearchCriteria {
  const normalized = normalizeFolderSearchText(value);
  const folderOnly = normalized.match(/^(?:f|folder)\s*:\s*(.*)$/i);
  return folderOnly
    ? { mode: 'folder', query: normalizeFolderSearchText(folderOnly[1] ?? '') }
    : { mode: 'all', query: normalized };
}

// Move-to-folder dialog renders a flat list (no DOM nesting), so it needs its
// own positive per-level indent. The sidebar's `folderTreeIndent` (which can
// be negative to compact the nested tree view) doesn't apply here 鈥?using it
// directly inverts the hierarchy in the dialog.
const FOLDER_DIALOG_INDENT_PER_LEVEL = 16;
export function calculateFolderDialogPaddingLeft(level: number): number {
  return level * FOLDER_DIALOG_INDENT_PER_LEVEL + 12;
}

type PendingNativeMenuWatch = {
  snapshot: NativeMenuOwnershipSnapshot;
  candidates: Set<HTMLElement>;
  timeoutId: number;
  finish: (menu: HTMLElement | null) => void;
};

type PendingNativeDialogWatch = {
  deleteItem: HTMLElement;
  token: string;
  expectedId: string;
  existingDialogs: ReadonlySet<HTMLElement>;
  timeoutId: number;
  finish: (dialog: HTMLElement | null) => void;
};

type NativeRemovalWatch = {
  targetRow: HTMLElement;
  expectedId: string;
  historyContainer: HTMLElement;
  historyParent: Node | null;
  sidebarContainer: HTMLElement;
  scrollContainer: HTMLElement;
  initialScrollTop: number;
  initialScrollLeft: number;
  rowRemovalObserved: boolean;
  ambiguousRemoval: boolean;
  scrollChanged: boolean;
  observer: MutationObserver;
  scrollListener: () => void;
};

type FolderRuntimeMessageListener = (
  message: unknown,
  sender: browser.Runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => true | void;

export class FolderManager {
  private debug(...args: unknown[]): void {
    if (this.isDebugEnabled()) {
      console.log('[FolderManager]', ...args);
    }
  }

  private debugWarn(...args: unknown[]): void {
    if (this.isDebugEnabled()) {
      console.warn('[FolderManager]', ...args);
    }
  }
  private isDebugEnabled(): boolean {
    try {
      // Enable by setting localStorage.gvFolderDebug = '1'
      return IS_DEBUG || localStorage.getItem('gvFolderDebug') === '1';
    } catch {
      // Ignore - localStorage may not be available in some contexts (e.g. incognito mode)
      return IS_DEBUG;
    }
  }
  private storage: IFolderStorageAdapter; // Storage adapter (Strategy Pattern)
  private backupService: DataBackupService<FolderData>; // Multi-layer backup system
  private data: FolderData = { folders: [], folderContents: {} };
  private containerElement: HTMLElement | null = null;
  private sidebarContainer: HTMLElement | null = null;
  private recentSection: HTMLElement | null = null;
  private tooltipElement: HTMLElement | null = null;
  private tooltipTimeout: number | null = null;
  private sideNavObserver: MutationObserver | null = null;
  private conversationObserver: MutationObserver | null = null; // Observer for conversation additions/removals
  private importInProgress: boolean = false; // Lock to prevent concurrent imports
  private exportInProgress: boolean = false; // Lock to prevent concurrent exports
  private selectedConversations: Set<string> = new Set(); // For multi-select support
  /**
   * Snapshot of every conversation currently in the multi-select set, keyed by
   * conversationId. Populated at selection time (long-press, click toggle, or
   * the dragstart's "auto-select self" branch) so the dragstart handler can
   * build the drag payload from cached data instead of re-querying the
   * sidebar DOM. ChatGPT's sidebar virtualises off-screen conversations and
   * recycles their DOM nodes — without this cache, `findConversationElement`
   * returns null for any selected conversation that the user has since
   * scrolled out of view, and the multi-select drag silently drops only the
   * visible subset. Kept in lockstep with `selectedConversations`: every
   * insertion/removal/clear touches both. Folder conversations skip this
   * cache (we read their data from `data.folderContents` directly).
   */
  private selectedConversationData: Map<string, ConversationReference> = new Map();
  private isMultiSelectMode: boolean = false; // Multi-select mode state
  private multiSelectSource: 'folder' | 'native' | null = null; // Track where multi-select was initiated
  private multiSelectFolderId: string | null = null; // Track which folder multi-select was initiated from
  private longPressTimeout: number | null = null; // For long-press detection
  private folderNameClickTimeout: number | null = null; // Distinguish single-click toggle from double-click rename
  private longPressThreshold: number = 500; // Long-press duration in ms
  private folderEnabled: boolean = true; // Whether folder feature is enabled
  private folderProjectEnabled: boolean = false; // Whether Folder-as-Project feature is enabled
  private folderBelowProjects: boolean = false; // Mount folder panel below Projects / above Recent (non-sticky) instead of pinned at top
  private belowProjectsRelocateTries: number = 0; // Bounded-retry counter for relocating below Projects while the Recent list streams in
  private hideArchivedConversations: boolean = false; // Whether to hide conversations in folders
  private hideArchivedNudgeShown: boolean = false; // Whether the first-archive nudge has been shown/dismissed
  private folderTreeIndent: number = FOLDER_TREE_INDENT_DEFAULT; // Tree indentation width (px)
  private foldersCollapsed: boolean = false;
  private foldersHidden: boolean = false;
  private folderSearchQuery: string = '';
  private folderSearchDebounceTimer: number | null = null;
  private conversationSortMode: ConversationSortMode = 'manual';
  private accountIsolationEnabled: boolean = false; // Whether hard account isolation is enabled
  private accountScope: AccountScope | null = null; // Resolved account scope for current page
  private activeStorageKey: string = STORAGE_KEY; // Storage key currently used for folder data
  private navPoller: number | null = null;
  private lastPathname: string | null = null;
  // Debounced "container still attached?" check (set up in initializeFolderUI).
  // Stored on the instance so the route-change listener can invoke it too:
  // ChatGPT's 2026-07 redesign re-renders the whole sidebar when entering
  // routes like /library, detaching the folder container AND every observer
  // bound to the old DOM — without a route-driven check the panel stayed dead
  // until a window resize.
  private domRecoveryCheck: (() => void) | null = null;
  private savePromise: Promise<boolean> | null = null;
  private saveRequested = false;
  private saveDirty = false;
  private saveRevision = 0;
  private pendingSaveSnapshot: {
    key: string;
    data: FolderData;
    revision: number;
  } | null = null;
  private pendingTitleUpdates: Map<string, string> = new Map(); // Buffer title updates during render
  private pendingRemovals: Map<string, number> = new Map(); // Pending conversation removals with timer IDs
  private removalCheckDelay: number = 300; // Delay (ms) before confirming conversation deletion
  private isDestroyed: boolean = false; // Flag to prevent callbacks after destruction
  private sidebarWaitTimer: number | null = null;
  private sidebarWaitCancel: (() => void) | null = null;
  private reinitializePromise: Promise<void> | null = null; // Prevent duplicate reinitialization cascades
  private activeColorPicker: HTMLElement | null = null; // Currently open color picker dialog
  private activeColorPickerFolderId: string | null = null; // Folder ID of currently open color picker
  private activeColorPickerCloseHandler: ((e: MouseEvent) => void) | null = null; // Event handler for closing color picker

  // Track active UI elements to prevent duplicate creation
  private activeFolderInput: HTMLElement | null = null; // Currently open folder name input
  private activeImportExportMenu: HTMLElement | null = null; // Currently open import/export menu
  private activeImportDialog: HTMLElement | null = null; // Currently open import dialog
  private activeImportExportMenuCloseHandler: ((e: MouseEvent) => void) | null = null;
  private activeImportExportMenuListenerTimeout: number | null = null;
  /** Currently-open per-folder actions menu (the "..." popover). Tracked
   *  to prevent duplicate menus stacking when the user re-clicks the "..."
   *  button — stopPropagation on the trigger kept the outside-click
   *  closer from firing, so each click silently appended another menu. */
  private activeFolderActionsMenu: HTMLElement | null = null;
  private activeFolderActionsMenuFolderId: string | null = null;
  private activeFolderActionsMenuCleanup: (() => void) | null = null;

  // Cleanup references
  private routeChangeCleanup: (() => void) | null = null;
  private sidebarClickListener: ((e: Event) => void) | null = null;
  private conversationMenuClickListener: ((event: Event) => void) | null = null;
  private storageChangeListener:
    | ((changes: Record<string, browser.Storage.StorageChange>, areaName: string) => void)
    | null = null;
  private runtimeMessageListener: FolderRuntimeMessageListener | null = null;
  private nativeMenuObserver: MutationObserver | null = null;
  private nativeDialogObserver: MutationObserver | null = null;
  private pendingNativeMenuWatch: PendingNativeMenuWatch | null = null;
  private pendingNativeDialogWatch: PendingNativeDialogWatch | null = null;
  private suppressedConversationMenuTrigger: HTMLElement | null = null;
  private activeNativeRemovalWatch: NativeRemovalWatch | null = null;
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null; // For exiting multi-select on outside click

  // Batch delete related properties
  private readonly MAX_BATCH_DELETE_COUNT = 50; // Maximum number of conversations to delete at once
  private batchDeleteInProgress = false; // Lock to prevent concurrent batch deletes
  private batchDeleteProgressElement: HTMLElement | null = null; // Progress indicator element

  // Batch delete timing configuration (in milliseconds)
  private readonly BATCH_DELETE_CONFIG = {
    MENU_WAIT_TIME: 3000,
    DIALOG_WAIT_TIME: 3000,
    REMOVAL_WAIT_TIME: 5000,
    CHECK_INTERVAL: 50,
  } as const;

  private cleanupTasks: (() => void)[] = [];

  // Floating-mode state 鈥?an opt-in "always use a floating window for folders"
  // switch exposed in the popup. When on, we never attempt to inject the
  // folder panel into ChatGPT's sidebar; we mount the body-level floating
  // panel + native 鈰?menu observer and call it a day. When off, normal
  // sidebar injection; a failure is a silent no-op.
  private floatingPanelHandle: FloatingPanelHandle | null = null;
  private floatingModeEnabled: boolean = false;
  private floatingModeActive: boolean = false;

  constructor() {
    // Create storage adapter based on browser (Factory Pattern)
    this.storage = createFolderStorageAdapter();
    this.debug(`Using storage backend: ${this.storage.getBackendName()}`);

    // Initialize extension-private recovery backups.
    this.backupService = new DataBackupService<FolderData>('gpt-folders', isValidFolderData);

    // Note: Data loading moved to init() for async support
    // This allows Safari to use async browser.storage API
    this.createTooltip();

    // Initialize i18n system
    initI18n().catch((e) => {
      this.debugWarn('Failed to initialize i18n:', e);
    });
  }

  async init(): Promise<void> {
    try {
      // Initialize storage adapter (handles migration for Safari automatically)
      await this.storage.init(STORAGE_KEY);
      if (this.isDestroyed) return;

      // Migrate older host-origin recovery copies into extension-private storage.
      // Backup availability is best-effort; authoritative folder storage above
      // remains the gate for mounting the feature.
      await this.backupService.init();
      if (this.isDestroyed) return;

      // Load account isolation setting/scope before reading folder data.
      await this.loadAccountIsolationSetting();
      if (this.isDestroyed) return;
      await this.refreshAccountScope();
      if (this.isDestroyed) return;

      // Load folder data (async, works for both Safari and non-Safari)
      await this.loadData();
      if (this.isDestroyed) return;

      // Load folder enabled setting
      await this.loadFolderEnabledSetting();
      if (this.isDestroyed) return;

      // Load the opt-in "always use floating window" mode. Off by default 鈥?      // users flip it from the popup when they want to skip sidebar injection
      // entirely and work with folders in a floating panel.
      await this.loadFloatingModeSetting();
      if (this.isDestroyed) return;

      // Load hide-archived onboarding nudge flag first, so loadHideArchivedSetting
      // can mark it "shown" if the user already has the feature enabled.
      await this.loadHideArchivedNudgeShownSetting();
      if (this.isDestroyed) return;

      // Load hide archived setting
      await this.loadHideArchivedSetting();
      if (this.isDestroyed) return;

      await this.loadFoldersCollapsedSetting();
      if (this.isDestroyed) return;
      await this.loadFolderTreeIndentSetting();
      if (this.isDestroyed) return;
      await this.loadFolderProjectEnabledSetting();
      if (this.isDestroyed) return;
      await this.loadConversationSortModeSetting();
      if (this.isDestroyed) return;
      await this.loadFolderBelowProjectsSetting();
      if (this.isDestroyed) return;

      // Set up storage change listener (always needed to respond to setting changes)
      this.setupStorageListener();
      if (this.isDestroyed) return;

      // Set up message listener (for popup communication)
      this.setupMessageListener();
      if (this.isDestroyed) return;

      // If folder feature is disabled, skip initialization
      if (!this.folderEnabled) {
        this.debug('Folder feature is disabled, skipping initialization');
        return;
      }

      // Two mounting strategies:
      //  - Floating mode (opt-in): body-level floating panel, skip sidebar.
      //  - Default: inject the folder panel into ChatGPT's sidebar.
      if (this.floatingModeEnabled) {
        await this.startFloatingMode();
      } else {
        await this.initializeFolderUI();
      }
      if (this.isDestroyed) return;

      this.debug('Initialized successfully');
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        return;
      }
      console.error('[FolderManager] Initialization error:', error);
    }
  }

  /**
   * Cleanup method to prevent memory leaks
   * Clears all pending deletion timers and observers
   */
  destroy(): void {
    this.debug('Destroying FolderManager - cleaning up resources');
    this.isDestroyed = true;
    this.cancelSidebarWait();
    this.backupService.destroy();

    // Clear all pending removal timers
    let clearedCount = 0;
    this.pendingRemovals.forEach((timerId, conversationId) => {
      clearTimeout(timerId);
      clearedCount++;
      this.debug(`Cleared pending removal timer for ${conversationId}`);
    });
    this.pendingRemovals.clear();

    if (clearedCount > 0) {
      this.debug(`Cleared ${clearedCount} pending removal timer(s)`);
    }

    // Clear other timers
    if (this.longPressTimeout) {
      clearTimeout(this.longPressTimeout);
      this.longPressTimeout = null;
    }

    if (this.folderNameClickTimeout !== null) {
      clearTimeout(this.folderNameClickTimeout);
      this.folderNameClickTimeout = null;
    }
    this.clearFolderSearchDebounceTimer();

    if (this.tooltipTimeout) {
      clearTimeout(this.tooltipTimeout);
      this.tooltipTimeout = null;
    }

    if (this.navPoller) {
      clearInterval(this.navPoller);
      this.navPoller = null;
    }

    // Disconnect mutation observers
    if (this.sideNavObserver) {
      this.sideNavObserver.disconnect();
      this.sideNavObserver = null;
    }

    if (this.conversationObserver) {
      this.conversationObserver.disconnect();
      this.conversationObserver = null;
    }

    this.cancelNativeMenuWatch();
    this.cancelNativeDialogWatch();
    this.cleanupNativeRemovalWatch();
    this.suppressedConversationMenuTrigger = null;

    // Tear down floating-mode UI if it was surfaced.
    unmountFloatingModeNudge();
    unmountFloatingFab();
    if (this.floatingPanelHandle) {
      this.floatingPanelHandle.destroy();
      this.floatingPanelHandle = null;
    }

    // Remove event listeners
    if (this.routeChangeCleanup) {
      this.routeChangeCleanup();
      this.routeChangeCleanup = null;
    }

    if (this.sidebarClickListener && this.sidebarContainer) {
      try {
        this.sidebarContainer.removeEventListener('click', this.sidebarClickListener, true);
      } catch {
        // Ignore
      }
      this.sidebarClickListener = null;
    }

    if (this.conversationMenuClickListener) {
      document.removeEventListener('click', this.conversationMenuClickListener, true);
      this.conversationMenuClickListener = null;
    }

    if (this.storageChangeListener) {
      browser.storage.onChanged.removeListener(this.storageChangeListener);
      this.storageChangeListener = null;
    }

    if (this.runtimeMessageListener) {
      browser.runtime.onMessage.removeListener(
        this.runtimeMessageListener as browser.Runtime.OnMessageListener,
      );
      this.runtimeMessageListener = null;
    }

    document
      .querySelectorAll<HTMLElement>('.gv-move-to-folder-btn')
      .forEach((menuItem) => menuItem.remove());
    this.hideBatchDeleteProgress();
    document.getElementById('gv-batch-delete-styles')?.remove();

    // Remove outside click handler for multi-select
    this.removeOutsideClickHandler();

    // Remove tooltip
    if (this.tooltipElement) {
      this.tooltipElement.remove();
      this.tooltipElement = null;
    }

    // Remove active color picker
    if (this.activeColorPicker) {
      this.activeColorPicker.remove();
      if (this.activeColorPickerCloseHandler) {
        document.removeEventListener('click', this.activeColorPickerCloseHandler);
        this.activeColorPickerCloseHandler = null;
      }
      this.activeColorPicker = null;
      this.activeColorPickerFolderId = null;
    }

    this.closeActiveImportExportMenu();
    this.closeActiveImportDialog();
    this.clearActiveFolderInput();

    // Remove container
    if (this.containerElement) {
      this.containerElement.remove();
      this.containerElement = null;
    }

    // Execute custom cleanup tasks
    this.cleanupTasks.forEach((task) => task());
    this.cleanupTasks = [];

    this.debug('Cleanup complete');
  }

  private addCleanupTask(task: () => void): void {
    this.cleanupTasks.push(task);
  }

  private clearActiveFolderInput(): void {
    this.activeFolderInput = null;
  }

  private closeActiveImportDialog(): void {
    if (this.activeImportDialog) {
      this.activeImportDialog.remove();
      this.activeImportDialog = null;
    }
  }

  private removeActiveImportExportMenuCloseHandler(): void {
    if (this.activeImportExportMenuListenerTimeout !== null) {
      clearTimeout(this.activeImportExportMenuListenerTimeout);
      this.activeImportExportMenuListenerTimeout = null;
    }

    if (this.activeImportExportMenuCloseHandler) {
      document.removeEventListener('click', this.activeImportExportMenuCloseHandler);
      this.activeImportExportMenuCloseHandler = null;
    }
  }

  private closeActiveImportExportMenu(): void {
    if (this.activeImportExportMenu) {
      this.activeImportExportMenu.remove();
      this.activeImportExportMenu = null;
    }

    this.removeActiveImportExportMenuCloseHandler();
  }

  private async initializeFolderUI(): Promise<void> {
    // Wait for sidebar to be available (with a hard timeout so a DOM change on
    // ChatGPT's side doesn't silently hang the folder feature forever).
    const sidebarFound = await this.waitForSidebar();
    if (this.isDestroyed) return;
    if (!sidebarFound) {
      this.debugWarn('Sidebar anchor never appeared 鈥?folder panel unavailable');
      return;
    }

    // Find the Recent section
    this.findRecentSection();

    if (!this.recentSection) {
      this.debugWarn('Could not find Recent section 鈥?folder panel unavailable');
      return;
    }

    // Create and inject folder UI
    this.createFolderUI();

    // Make conversations draggable
    this.makeConversationsDraggable();

    // Set up mutation observer to handle dynamically added conversations
    this.setupMutationObserver();

    // Set up sidebar visibility observer
    this.setupSideNavObserver();

    // Initial visibility check
    this.updateVisibilityBasedOnSideNav();

    // Set up native conversation menu injection
    this.setupConversationClickTracking();
    this.setupNativeConversationMenuObserver();

    // 鈹€鈹€鈹€ DOM recovery (resize / print) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    // ChatGPT may re-render the sidebar DOM during window resize or
    // window.print(), detaching the folder container.  The sideNavObserver
    // (watching `side-nav-open` on #app-root) CANNOT catch all cases because
    // when the sidebar closes AND the DOM is rebuilt simultaneously, the
    // observer fires with isSideNavOpen=false and skips reinitialization.
    // A debounced resize listener provides a reliable fallback.
    let domRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

    const domRecoveryCheck = () => {
      if (domRecoveryTimer !== null) clearTimeout(domRecoveryTimer);
      domRecoveryTimer = setTimeout(() => {
        domRecoveryTimer = null;
        if (this.isDestroyed) return;
        // Codex has no folder panel by design (see createFolderUI) — a missing
        // container there is expected, not a loss to recover from.
        if (location.pathname.startsWith('/codex')) return;
        this.updateVisibilityBasedOnSideNav();
        if (
          this.containerElement &&
          document.body.contains(this.containerElement) &&
          this.sidebarContainer &&
          document.body.contains(this.sidebarContainer)
        ) {
          return; // Everything still attached 鈥?nothing to do.
        }
        // Only reinitialize if the sidebar is currently visible (open).
        // If it is closed, the sideNavObserver will trigger reinitialization
        // when it reopens.
        const appRoot = document.querySelector('#app-root');
        if (appRoot && !appRoot.classList.contains('side-nav-open')) {
          this.debug('DOM recovery: container lost but sidebar closed, deferring');
          return;
        }
        this.debug('DOM recovery: folder UI lost from DOM, reinitializing');
        this.reinitializeFolderUI();
      }, 800);
    };

    window.addEventListener('resize', domRecoveryCheck);
    window.addEventListener('gv-print-cleanup', domRecoveryCheck);
    window.addEventListener('afterprint', domRecoveryCheck);
    // Expose to the route-change listener (installRouteChangeListener) so SPA
    // navigations run the same recovery pass — the debounce + attached-check
    // make repeated calls cheap and idempotent.
    this.domRecoveryCheck = domRecoveryCheck;

    this.addCleanupTask(() => {
      if (domRecoveryTimer !== null) clearTimeout(domRecoveryTimer);
      this.domRecoveryCheck = null;
      window.removeEventListener('resize', domRecoveryCheck);
      window.removeEventListener('gv-print-cleanup', domRecoveryCheck);
      window.removeEventListener('afterprint', domRecoveryCheck);
    });
  }

  private isElementActuallyVisible(element: HTMLElement | null): boolean {
    if (!element || !document.body.contains(element)) return false;
    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0' ||
      element.hidden ||
      element.getAttribute('aria-hidden') === 'true'
    ) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return (
      rect.width > 24 &&
      rect.height > 24 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.top < window.innerHeight
    );
  }

  private shouldShowEmbeddedFolderContainer(): boolean {
    if (!this.folderEnabled) return false;

    const sidebarVisible = this.isElementActuallyVisible(this.sidebarContainer);
    if (sidebarVisible) return true;

    const appRoot = document.querySelector('#app-root');
    const appRootClass = appRoot?.getAttribute('class') || '';
    const appRootHasSideNavState = /\bside-nav-/.test(appRootClass);
    const appRootAllowsSidebar =
      !appRootHasSideNavState || appRoot?.classList.contains('side-nav-open') === true;

    return appRootAllowsSidebar && sidebarVisible;
  }

  /**
   * Polls for the ChatGPT sidebar anchor. Resolves true when found, false if the
   * configurable timeout elapses first. The timeout path lets the caller surface
   * a floating-mode fallback UI instead of spinning forever when Google changes
   * the sidebar DOM.
   *
   * Users can force the failure path for testing by setting
   * `localStorage['gv-force-folder-fail'] = '1'` in the ChatGPT page and
   * reloading.
   */
  private async waitForSidebar(timeoutMs: number = 10000): Promise<boolean> {
    if (this.isDestroyed) return false;
    this.cancelSidebarWait();
    try {
      if (localStorage.getItem('gv-force-folder-fail') === '1') {
        console.warn('[FolderManager] gv-force-folder-fail is set 鈥?simulating sidebar failure');
        return false;
      }
    } catch {}
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      let settled = false;
      const finish = (found: boolean) => {
        if (settled) return;
        settled = true;
        if (this.sidebarWaitTimer !== null) {
          window.clearTimeout(this.sidebarWaitTimer);
          this.sidebarWaitTimer = null;
        }
        if (this.sidebarWaitCancel === cancel) this.sidebarWaitCancel = null;
        resolve(found);
      };
      const cancel = () => finish(false);
      const checkSidebar = () => {
        this.sidebarWaitTimer = null;
        if (this.isDestroyed) {
          finish(false);
          return;
        }
        const container = findChatGptSidebar();
        if (container) {
          this.sidebarContainer = container as HTMLElement;
          finish(true);
          return;
        }
        if (Date.now() >= deadline) {
          finish(false);
          return;
        }
        this.sidebarWaitTimer = window.setTimeout(checkSidebar, 500);
      };
      this.sidebarWaitCancel = cancel;
      checkSidebar();
    });
  }

  private cancelSidebarWait(): void {
    const cancel = this.sidebarWaitCancel;
    this.sidebarWaitCancel = null;
    cancel?.();
    if (this.sidebarWaitTimer !== null) {
      window.clearTimeout(this.sidebarWaitTimer);
      this.sidebarWaitTimer = null;
    }
  }

  /**
   * Sidebar injection failed 鈥?surface a one-time nudge letting the user pop
   * the folder panel out as a floating window. If they've already dismissed the
   * nudge or already have the floating panel open, skip straight to mounting it.
   *
   * @param reason free-form debug label (anchor-missing, recent-section-missing, etc.)
   */
  /**
   * Enter "always floating" mode. User has explicitly flipped the popup
   * toggle, so we skip the onboarding nudge entirely and drop the panel
   * straight onto the page. The native 鈰?鈫?"Move to folder" observers are
   * wired up here too so users can file conversations without the panel
   * being open.
   */
  private async startFloatingMode(): Promise<void> {
    if (this.floatingModeActive) return;
    this.floatingModeActive = true;
    this.debug('Entering floating mode');

    this.setupConversationClickTracking();
    this.setupNativeConversationMenuObserver();

    await this.openFloatingPanel();
  }

  /**
   * Leave floating mode 鈥?tear down the body-level UI. Safe to call when
   * floating mode was never entered.
   */
  private stopFloatingMode(): void {
    this.floatingModeActive = false;
    unmountFloatingModeNudge();
    unmountFloatingFab();
    if (this.floatingPanelHandle) {
      this.floatingPanelHandle.destroy();
      this.floatingPanelHandle = null;
    }
  }

  /**
   * Mounts the small persistent FAB button in the corner. Safe to call multiple
   * times 鈥?the module is idempotent. Hydrates and persists position via
   * chrome.storage.sync so the user's chosen spot sticks across reloads.
   */
  private showFloatingFab(): void {
    // Fire-and-forget position read 鈥?worst case the FAB lands in its default
    // bottom-right spot for a frame before we re-place it.
    void browser.storage.sync
      .get({ [StorageKeys.FOLDER_FLOATING_FAB_POS]: null })
      .then((raw) => {
        const candidate = raw[StorageKeys.FOLDER_FLOATING_FAB_POS] as unknown;
        let storedPos: FloatingFabPos | null = null;
        if (
          candidate &&
          typeof candidate === 'object' &&
          typeof (candidate as FloatingFabPos).x === 'number' &&
          typeof (candidate as FloatingFabPos).y === 'number'
        ) {
          storedPos = candidate as FloatingFabPos;
        }
        mountFloatingFab({
          storedPos,
          onClick: () => {
            void this.openFloatingPanel();
          },
          onPosChange: (pos) => {
            void browser.storage.sync
              .set({ [StorageKeys.FOLDER_FLOATING_FAB_POS]: pos })
              .catch((error) => {
                if (!isExtensionContextInvalidatedError(error)) {
                  this.debugWarn('Failed to persist floating FAB position:', error);
                }
              });
          },
        });
      })
      .catch((error) => {
        if (isExtensionContextInvalidatedError(error)) return;
        this.debugWarn('Failed to read floating FAB position:', error);
        // Still mount at default position so feature degrades gracefully.
        mountFloatingFab({
          onClick: () => {
            void this.openFloatingPanel();
          },
        });
      });
  }

  private async openFloatingPanel(): Promise<void> {
    if (this.floatingPanelHandle) return;
    unmountFloatingModeNudge();
    // Only one entry point visible at a time 鈥?FAB hides when the panel is up.
    unmountFloatingFab();

    let storedPos: FloatingPanelPos | null = null;
    let storedSize: FloatingPanelSize | null = null;
    try {
      const raw = await browser.storage.sync.get({
        [StorageKeys.FOLDER_FLOATING_POS]: null,
        [StorageKeys.FOLDER_FLOATING_SIZE]: null,
      });
      const posCandidate = raw[StorageKeys.FOLDER_FLOATING_POS] as unknown;
      if (
        posCandidate &&
        typeof posCandidate === 'object' &&
        typeof (posCandidate as FloatingPanelPos).x === 'number' &&
        typeof (posCandidate as FloatingPanelPos).y === 'number'
      ) {
        storedPos = posCandidate as FloatingPanelPos;
      }
      const sizeCandidate = raw[StorageKeys.FOLDER_FLOATING_SIZE] as unknown;
      if (
        sizeCandidate &&
        typeof sizeCandidate === 'object' &&
        typeof (sizeCandidate as FloatingPanelSize).w === 'number' &&
        typeof (sizeCandidate as FloatingPanelSize).h === 'number'
      ) {
        storedSize = sizeCandidate as FloatingPanelSize;
      }
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) return;
      this.debugWarn('Failed to read floating-mode position/size:', error);
    }

    // All mutation callbacks share the same tail: persist to storage and push
    // a fresh snapshot into the floating panel. Factored out so each callback
    // body stays a single expression of intent.
    const afterMutation = (): void => {
      void this.saveData();
      this.floatingPanelHandle?.update(this.data);
    };

    this.floatingPanelHandle = mountFloatingPanel({
      data: this.data,
      storedPos,
      storedSize,
      onPosChange: (pos) => {
        void browser.storage.sync.set({ [StorageKeys.FOLDER_FLOATING_POS]: pos }).catch((error) => {
          if (!isExtensionContextInvalidatedError(error)) {
            this.debugWarn('Failed to persist floating-mode position:', error);
          }
        });
      },
      // Fires once, 300ms after the last resize observed by the panel, so
      // storage.sync isn't spammed with every intermediate size during a drag.
      onSizeChange: (size) => {
        void browser.storage.sync
          .set({ [StorageKeys.FOLDER_FLOATING_SIZE]: size })
          .catch((error) => {
            if (!isExtensionContextInvalidatedError(error)) {
              this.debugWarn('Failed to persist floating-mode size:', error);
            }
          });
      },
      onClose: () => {
        this.floatingPanelHandle = null;
        // Panel is gone 鈥?bring the FAB back so the user can re-open later.
        this.showFloatingFab();
      },
      onNavigate: (conv) => {
        this.navigateToConversation(conv.url, conv);
      },
      onCreateFolder: (name, parentId) => {
        const maxSortIndex = this.data.folders
          .filter((f) => f.parentId === parentId)
          .reduce((max, f) => Math.max(max, f.sortIndex ?? -1), -1);
        const folder: Folder = {
          id: this.generateId(),
          name,
          parentId,
          isExpanded: true,
          sortIndex: maxSortIndex + 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        this.data.folders.push(folder);
        this.data.folderContents[folder.id] = [];
        afterMutation();
      },
      onRenameFolder: (folderId, newName) => {
        const folder = this.data.folders.find((f) => f.id === folderId);
        if (!folder) return;
        folder.name = newName;
        folder.updatedAt = Date.now();
        afterMutation();
      },
      onDeleteFolder: (folderId) => {
        const foldersToDelete = this.getFolderAndDescendants(folderId);
        this.data.folders = this.data.folders.filter((f) => !foldersToDelete.includes(f.id));
        foldersToDelete.forEach((id) => {
          delete this.data.folderContents[id];
        });
        afterMutation();
      },
      onRemoveConversation: (folderId, conversationId) => {
        // Reuse the existing data-only removal path; it already calls saveData
        // + refresh (sidebar refresh is a no-op when the sidebar isn't mounted).
        this.removeConversationFromFolder(folderId, conversationId);
        this.floatingPanelHandle?.update(this.data);
      },
      onToggleStar: (folderId, conversationId) => {
        this.toggleConversationStar(folderId, conversationId);
        this.floatingPanelHandle?.update(this.data);
      },
      onToggleFolderPinned: (folderId) => {
        this.togglePinFolder(folderId);
        this.floatingPanelHandle?.update(this.data);
      },
      // Intra-panel conversation move: user dragged a conversation row from
      // folder A to folder B inside the floating panel. Cross-document drag
      // (native ChatGPT row 鈫?panel) is intentionally NOT wired 鈥?that path
      // proved unreliable; the user files new conversations via the native
      // 鈰?鈫?"Move to folder" menu instead.
      onMoveConversation: (conversationId, fromFolderId, toFolderId) => {
        const conv = this.data.folderContents[fromFolderId]?.find(
          (c) => c.conversationId === conversationId,
        );
        if (!conv) return;
        this.moveConversationToFolder(fromFolderId, toFolderId, conv);
      },
      onSetFolderColor: (folderId, color) => {
        this.changeFolderColor(folderId, color);
        this.floatingPanelHandle?.update(this.data);
      },
    });
  }

  private findRecentSection(): void {
    if (!this.sidebarContainer) return;

    const conversationsList = findChatGptHistoryContainer(this.sidebarContainer);

    if (conversationsList) {
      this.recentSection = conversationsList as HTMLElement;
    } else {
      this.debugWarn('Could not find Recent section - will retry');
      // Retry after a delay
      setTimeout(() => {
        this.findRecentSection();
        if (this.recentSection && !this.containerElement) {
          this.createFolderUI();
          this.makeConversationsDraggable();
          this.setupMutationObserver();
        }
      }, 2000);
    }
  }

  private createFolderUI(): void {
    // Folders organize the sidebar's ChatGPT conversations (its `/c/…` links).
    // The Codex section (chatgpt.com/codex/*) has no such list — its layout is
    // entirely different — so the anchor search latches onto the wrong element
    // and drops an empty "No folders yet" panel into Codex's own UI (issue #4).
    // Skip building the panel on `/codex` pages. The surrounding observers stay
    // active, so folders still appear the moment the user navigates back to a
    // real chat page (createFolderUI runs again there with the guard cleared).
    if (location.pathname.startsWith('/codex')) return;

    if (!this.recentSection) return;

    // Create folder container
    this.containerElement = document.createElement('div');
    this.containerElement.className = 'gv-folder-container';

    // Create multi-select mode indicator
    const indicator = this.createMultiSelectIndicator();
    this.containerElement.appendChild(indicator);

    // Create header
    const header = this.createHeader();
    this.containerElement.appendChild(header);

    // Search is part of Folder's default frontend; its query stays in memory.
    this.containerElement.appendChild(this.createFolderSearch());

    // Create folders list
    const foldersList = this.createFoldersList();
    this.containerElement.appendChild(foldersList);

    // Gemini Voyager's historical section hider restores a fully hidden
    // section through a slim peek bar. Keep the bar inside the Folder root so
    // ChatGPT sidebar relocations cannot orphan it from the panel.
    this.containerElement.appendChild(this.createFolderPeekBar());

    // Mount strategy: the user wants folders to share the sticky region with
    // ChatGPT's 新聊天/搜索聊天/Codex block — that block is a single sticky
    // <div> containing a <ul> of nav items. Appending folders INSIDE that
    // block makes them part of the same sticky unit, so on scroll the whole
    // group stays pinned and history rows pass beneath without ever covering
    // the native nav items above. Fall back to the previous sidebar-header
    // approach when the new layout isn't found (older / variant ChatGPT
    // builds).
    const navBlock = this.findChatGptSidebarNavBlock();
    if (navBlock) {
      navBlock.classList.add('gv-sidebar-nav-block');
      navBlock.appendChild(this.containerElement);
      this.containerElement.classList.add('gv-folder-container--in-nav-block');
    } else {
      const chatGptSidebarHeader =
        this.sidebarContainer?.querySelector<HTMLElement>('#sidebar-header');
      const chatGptHeaderSection =
        chatGptSidebarHeader?.closest<HTMLElement>('.sticky') || chatGptSidebarHeader;
      if (chatGptHeaderSection) {
        chatGptHeaderSection.classList.add('gv-folder-sticky-host');
        chatGptHeaderSection.appendChild(this.containerElement);
      } else {
        this.recentSection.parentElement?.insertBefore(this.containerElement, this.recentSection);
      }
    }

    // Opt-in alternate layout: relocate the folder panel out of the pinned nav
    // block into the normal scroll flow, just above the "Recent" chat list
    // (which sits directly below ChatGPT's "Projects" section). The Recent list
    // streams in asynchronously, so this can't run reliably at first mount —
    // tryRelocateBelowProjects() retries until the chats section appears. When
    // the list is already present (e.g. a settings-toggle reinit) it relocates
    // synchronously with no visible flash.
    if (this.folderBelowProjects) {
      this.belowProjectsRelocateTries = 0;
      this.tryRelocateBelowProjects();
    }

    // Initial active conversation highlight and route listeners
    this.highlightActiveConversationInFolders();
    this.installRouteChangeListener();
    this.installSidebarClickListener();
    this.installSidebarDragAutoScroll();

    // Apply initial folder enabled setting
    this.applyFolderEnabledSetting();
    this.applyFoldersCollapsedState();
    this.applyFoldersHiddenState();
  }

  /**
   * Locate the ChatGPT sidebar's sticky nav block — the <div> that contains
   * the 新聊天/搜索聊天/Codex <ul> and whose own `tall:sticky tall:top-header-height`
   * classes keep it pinned at the top of the scroll-port. Folder UI gets
   * appended INSIDE this element so it inherits the same sticky region
   * (folders never cover the nav items above them, they just extend the
   * pinned area downward). Returns null on older / variant ChatGPT layouts
   * — callers fall back to the legacy sidebar-header mount.
   */
  private findChatGptSidebarNavBlock(): HTMLElement | null {
    const sidebar = this.sidebarContainer;
    if (!sidebar) return null;

    // The expanded-sidebar "new chat" link is an anchor with href="/" wrapped
    // in <li>→<ul>→<div class="pt-(--sidebar-section-first-margin-top) … tall:sticky">.
    // We disambiguate from the collapsed tiny-bar's copy of the same link by
    // requiring (a) a <ul> ancestor (the rail uses a different structure)
    // and (b) the ancestor div has position:sticky in computed style.
    const links = Array.from(sidebar.querySelectorAll<HTMLAnchorElement>('a[href="/"]'));
    for (const link of links) {
      const ul = link.closest('ul');
      if (!ul) continue;
      const candidate = ul.parentElement as HTMLElement | null;
      if (!candidate) continue;
      const position = getComputedStyle(candidate).position;
      // `tall:sticky` only applies above a height breakpoint; if the viewport
      // is short the block falls back to `relative`. We still want to mount
      // there — the sticky behaviour will kick in once the viewport grows.
      if (position === 'sticky' || position === 'relative') return candidate;
    }
    return null;
  }

  /**
   * Locate the "Recent" chat-list section block — the direct child of the
   * sidebar scrollport <nav> that holds the conversation links. ChatGPT lays
   * the sidebar out as a flat list of sibling sections inside that nav:
   * …  → [Projects expando] → [Recent expando (conversation links)] → spacer.
   * We climb from the first `/c/<id>` conversation link until its parent is
   * the <nav>; that ancestor IS the Recent section. Inserting our folder
   * panel immediately before it places folders below Projects and above
   * Recent, in normal (non-sticky) scroll flow. Returns null on layouts where
   * no conversation link / nav ancestor exists (empty history, variant
   * builds) — callers fall back to the default sticky mount.
   */
  private findChatGptChatsSectionBlock(): HTMLElement | null {
    const sidebar = this.sidebarContainer;
    if (!sidebar) return null;

    const convLink = sidebar.querySelector<HTMLAnchorElement>('a[href*="/c/"]');
    if (!convLink) return null;

    let node: HTMLElement = convLink;
    let parentEl: HTMLElement | null = node.parentElement;
    while (parentEl) {
      if (parentEl.tagName === 'NAV') {
        return node;
      }
      // Don't escape the sidebar root if the nav is somehow absent.
      if (parentEl === sidebar) break;
      node = parentEl;
      parentEl = node.parentElement;
    }
    return null;
  }

  /**
   * Move the (already-mounted) folder container into the normal scroll flow,
   * immediately above the Recent chat list — i.e. below the Projects section.
   * The Recent list streams in after the sidebar shell, so the chats section
   * may not exist on the first call; we retry on a short interval (bounded so
   * a missing/variant layout can't loop forever) and bail quietly if it never
   * appears, leaving the default sticky mount in place. Idempotent: if the
   * container is already correctly placed it only normalizes its classes.
   */
  private tryRelocateBelowProjects(): void {
    if (!this.folderBelowProjects || !this.containerElement) return;

    const chatsBlock = this.findChatGptChatsSectionBlock();
    if (!chatsBlock?.parentElement) {
      if (this.belowProjectsRelocateTries < 12) {
        this.belowProjectsRelocateTries++;
        setTimeout(() => {
          if (this.isDestroyed) return;
          this.tryRelocateBelowProjects();
        }, 500);
      } else {
        this.debug('below-projects relocate gave up — chats section never appeared');
      }
      return;
    }

    const alreadyPlaced =
      this.containerElement.parentElement === chatsBlock.parentElement &&
      this.containerElement.nextElementSibling === chatsBlock;

    if (!alreadyPlaced) {
      chatsBlock.parentElement.insertBefore(this.containerElement, chatsBlock);
    }
    this.containerElement.classList.add('gv-folder-container--below-projects');
    this.containerElement.classList.remove('gv-folder-container--in-nav-block');
  }

  private findSidebarScrollContainer(): HTMLElement | null {
    if (!this.sidebarContainer) return null;

    const isScrollable = (element: HTMLElement): boolean => {
      const style = getComputedStyle(element);
      return (
        element.scrollHeight > element.clientHeight + 8 &&
        /(auto|scroll|overlay)/.test(style.overflowY)
      );
    };

    if (isScrollable(this.sidebarContainer)) return this.sidebarContainer;

    const candidates = Array.from(this.sidebarContainer.querySelectorAll<HTMLElement>('*'));
    return candidates.find(isScrollable) || this.sidebarContainer;
  }

  private installSidebarDragAutoScroll(): void {
    if (!this.sidebarContainer) return;

    const edgeSize = 72;
    const maxStep = 28;
    const handleDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('application/json')) return;

      const scrollContainer = this.findSidebarScrollContainer();
      if (!scrollContainer) return;

      const rect = scrollContainer.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) {
        return;
      }

      const topDistance = event.clientY - rect.top;
      const bottomDistance = rect.bottom - event.clientY;
      let delta = 0;

      if (topDistance < edgeSize) {
        delta = -Math.ceil(((edgeSize - topDistance) / edgeSize) * maxStep);
      } else if (bottomDistance < edgeSize) {
        delta = Math.ceil(((edgeSize - bottomDistance) / edgeSize) * maxStep);
      }

      if (delta !== 0) {
        scrollContainer.scrollTop += delta;
      }
    };

    this.sidebarContainer.addEventListener('dragover', handleDragOver, true);
    this.addCleanupTask(() => {
      this.sidebarContainer?.removeEventListener('dragover', handleDragOver, true);
    });
  }

  private createMultiSelectIndicator(): HTMLElement {
    const indicator = document.createElement('div');
    indicator.className = 'gv-multi-select-indicator';
    indicator.dataset.multiSelectIndicator = 'true';

    // Apply floating styles
    Object.assign(indicator.style, {
      position: 'fixed',
      bottom: '24px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '9999', // Ensure it's above everything
      boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
      cursor: 'move', // Indicate it's draggable
      transition: 'opacity 0.2s ease, transform 0.1s ease', // Only animate non-position props for performance
      // Prevent text selection while dragging
      userSelect: 'none',
      // Ensure it has a background so IT covers content behind it
      backgroundColor: 'var(--gem-sys-color-surface-container, #f0f4f9)', // Fallback color
      borderRadius: '24px',
      padding: '8px 16px',
      alignItems: 'center',
      gap: '12px',
      border: '1px solid var(--gem-sys-color-outline-variant, rgba(0,0,0,0.1))',
    });

    // --- Draggable Logic Start ---
    let isDragging = false;
    let currentX: number;
    let currentY: number;
    let initialX: number;
    let initialY: number;
    let xOffset = 0;
    let yOffset = 0;

    const dragStart = (e: MouseEvent) => {
      // Ignore if clicking buttons inside the indicator
      if ((e.target as HTMLElement).closest('button')) return;

      initialX = e.clientX - xOffset;
      initialY = e.clientY - yOffset;

      if (e.target === indicator || indicator.contains(e.target as Node)) {
        isDragging = true;
        indicator.style.cursor = 'grabbing';
      }
    };

    const dragEnd = () => {
      isDragging = false;
      indicator.style.cursor = 'move';
    };

    const drag = (e: MouseEvent) => {
      if (isDragging) {
        e.preventDefault();
        currentX = e.clientX - initialX;
        currentY = e.clientY - initialY;

        xOffset = currentX;
        yOffset = currentY;

        setTranslate(currentX, currentY, indicator);
      }
    };

    const setTranslate = (xPos: number, yPos: number, el: HTMLElement) => {
      el.style.transform = `translate3d(calc(-50% + ${xPos}px), ${yPos}px, 0)`;
    };

    indicator.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);

    // Cleanup listeners when destroyed (adding to a cleanup list if possible, or attaching to element)
    // Since we attach to document, we MUST clean this up in destroy()
    // We'll wrap these in a cleanup function and store it
    this.addCleanupTask(() => {
      indicator.removeEventListener('mousedown', dragStart);
      document.removeEventListener('mousemove', drag);
      document.removeEventListener('mouseup', dragEnd);
    });
    // --- Draggable Logic End ---

    const content = document.createElement('div');
    content.className = 'gv-multi-select-indicator-content';
    // Ensure content (text/icon) doesn't capture drag events aggressively
    content.style.pointerEvents = 'none';

    const icon = document.createElement('mat-icon');
    icon.className = 'mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color';
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'check_circle';

    const text = document.createElement('span');
    text.className = 'gv-multi-select-indicator-text';
    text.textContent = this.t('multi_select_count').replace('{count}', '0');
    text.dataset.selectionCount = 'true';

    content.appendChild(icon);
    content.appendChild(text);
    indicator.appendChild(content);

    // Actions container (will be populated dynamically)
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'gv-multi-select-actions';
    actionsContainer.dataset.multiSelectActions = 'true';
    // Re-enable pointer events for buttons
    actionsContainer.style.pointerEvents = 'auto';
    indicator.appendChild(actionsContainer);

    return indicator;
  }

  private createHeader(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'gv-folder-header';

    const titleContainer = document.createElement('div');
    titleContainer.className = 'title-container';

    const collapseButton = document.createElement('button');
    collapseButton.className = 'gv-folder-section-toggle';
    collapseButton.type = 'button';
    collapseButton.addEventListener('click', (event) => {
      event.stopPropagation();
      event.preventDefault();
      void this.toggleFoldersCollapsed();
    });

    const title = document.createElement('h1');
    title.className = 'title gds-label-l';
    title.textContent = this.t('folder_title');
    title.style.visibility = 'visible';

    titleContainer.append(collapseButton, title);

    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'gv-folder-header-actions';

    const visibilityButton = document.createElement('button');
    visibilityButton.className = 'gv-folder-action-btn gv-folder-visibility-toggle';
    visibilityButton.type = 'button';
    visibilityButton.addEventListener('click', () => void this.toggleFoldersHidden());

    const importExportButton = document.createElement('button');
    importExportButton.className = 'gv-folder-action-btn gv-folder-import-export-btn';
    importExportButton.type = 'button';
    importExportButton.replaceChildren(createFolderIcon(18));
    importExportButton.title = this.t('folder_import_export');
    importExportButton.setAttribute('aria-label', this.t('folder_import_export'));
    importExportButton.addEventListener('click', (e) => this.showImportExportMenu(e));

    const settingsButton = document.createElement('button');
    settingsButton.className = 'gv-folder-action-btn gv-folder-settings-btn';
    settingsButton.type = 'button';
    settingsButton.replaceChildren(createSettingsIcon(18));
    settingsButton.title = this.t('folder_settings');
    settingsButton.setAttribute('aria-label', this.t('folder_settings'));
    settingsButton.addEventListener('click', (event) => this.showFolderSettingsMenu(event));

    const addButton = document.createElement('button');
    addButton.className = 'gv-folder-add-btn';
    addButton.type = 'button';
    addButton.replaceChildren(createPlusIcon(18));
    addButton.title = this.t('folder_create');
    addButton.setAttribute('aria-label', this.t('folder_create'));
    addButton.addEventListener('click', () => this.createFolder());

    actionsContainer.append(
      visibilityButton,
      importExportButton,
      settingsButton,
      addButton,
    );

    header.appendChild(titleContainer);
    header.appendChild(actionsContainer);

    // Setup root drop zone on header
    this.setupRootDropZone(header);

    return header;
  }

  private createFolderPeekBar(): HTMLButtonElement {
    const bar = document.createElement('button');
    bar.className = 'gv-folder-peek-bar';
    bar.type = 'button';
    bar.addEventListener('click', (event) => {
      event.stopPropagation();
      event.preventDefault();
      void this.toggleFoldersHidden();
    });
    return bar;
  }

  private createFolderSearch(): HTMLElement {
    const searchContainer = document.createElement('div');
    searchContainer.className = 'gv-folder-search';

    const input = document.createElement('input');
    input.className = 'gv-folder-search-input';
    input.type = 'search';
    input.value = this.folderSearchQuery;

    const modeBadge = document.createElement('span');
    modeBadge.className = 'gv-folder-search-mode-badge';
    modeBadge.setAttribute('aria-hidden', 'true');

    input.addEventListener('input', () => {
      this.folderSearchQuery = input.value;
      this.updateFolderSearchInputState(searchContainer, input, modeBadge);
      this.clearFolderSearchDebounceTimer();
      this.folderSearchDebounceTimer = window.setTimeout(() => {
        this.folderSearchDebounceTimer = null;
        this.refresh();
      }, FOLDER_SEARCH_DEBOUNCE_MS);
    });

    searchContainer.append(input, modeBadge);
    this.updateFolderSearchInputState(searchContainer, input, modeBadge);
    return searchContainer;
  }

  private updateFolderSearchInputState(
    searchContainer: HTMLElement,
    input: HTMLInputElement,
    modeBadge: HTMLElement,
  ): void {
    const folderOnlyMode = this.isFolderOnlySearchActive();
    const baseLabel = this.t('folder_search_placeholder');
    const modeLabel = this.t('folder_search_mode_folder');
    searchContainer.classList.toggle('gv-folder-search-folder-mode', folderOnlyMode);
    modeBadge.hidden = !folderOnlyMode;
    modeBadge.textContent = modeLabel;
    input.placeholder = `${baseLabel} · f: ${modeLabel}`;
    input.setAttribute('aria-label', folderOnlyMode ? `${baseLabel}: ${modeLabel}` : baseLabel);
  }

  private clearFolderSearchDebounceTimer(): void {
    if (this.folderSearchDebounceTimer === null) return;
    window.clearTimeout(this.folderSearchDebounceTimer);
    this.folderSearchDebounceTimer = null;
  }

  private createFoldersList(): HTMLElement {
    const list = document.createElement('div');
    list.className = 'gv-folder-list';
    const isSearchActive = this.isFolderSearchActive();
    let renderedItems = 0;

    // Setup root-level drop zone for dragging folders and conversations to root
    this.setupRootDropZone(list);

    // Render root-level conversations (favorites/pinned conversations)
    const rootConversations = this.data.folderContents[ROOT_CONVERSATIONS_ID] || [];
    const visibleRootConversations = this.filterVisibleConversations(rootConversations);
    if (visibleRootConversations.length > 0) {
      const sortedRootConversations = this.sortConversations(visibleRootConversations);
      sortedRootConversations.forEach((conv, i) => {
        const convEl = this.createConversationElement(conv, ROOT_CONVERSATIONS_ID, 0);
        if (!isSearchActive && this.conversationSortMode === 'manual') {
          this.setupConversationReorderZone(convEl, ROOT_CONVERSATIONS_ID, i);
        }
        list.appendChild(convEl);
        renderedItems++;
      });
    }

    // Render root level folders (sorted)
    const rootFolders = this.data.folders.filter((f) => f.parentId === null);
    const sortedRootFolders = this.sortFolders(rootFolders);
    let rootFolderIndex = 0;
    if (!isSearchActive) list.appendChild(this.createReorderGap('__root__', 'folder', 0));
    sortedRootFolders.forEach((folder) => {
      if (isSearchActive && !this.matchesFolderSearchTree(folder.id)) {
        return;
      }
      const folderElement = this.createFolderElement(folder);
      list.appendChild(folderElement);
      renderedItems++;
      rootFolderIndex++;
      if (!isSearchActive) {
        list.appendChild(this.createReorderGap('__root__', 'folder', rootFolderIndex));
      }
    });

    // If no folders and no root conversations, show empty state placeholder
    if (renderedItems === 0) {
      const emptyState = document.createElement('div');
      emptyState.className = 'gv-folder-empty';
      emptyState.textContent = this.t(isSearchActive ? 'folder_search_empty' : 'folder_empty');
      list.appendChild(emptyState);
    }

    return list;
  }

  private createFolderElement(folder: Folder, level = 0, includeEntireSubtree = false): HTMLElement {
    const isSearchActive = this.isFolderSearchActive();
    const includeFolderSubtree =
      includeEntireSubtree ||
      (this.isFolderOnlySearchActive() && this.matchesFolderSearchText(folder.name));
    const isExpanded = folder.isExpanded || isSearchActive;
    const folderEl = document.createElement('div');
    folderEl.className = 'gv-folder-item';
    folderEl.dataset.folderId = folder.id;
    folderEl.dataset.level = level.toString();

    // Folder header
    const folderHeader = document.createElement('div');
    folderHeader.className = 'gv-folder-item-header';
    folderHeader.style.paddingLeft = `${calculateFolderHeaderPaddingLeft(level, this.folderTreeIndent)}px`;

    // Expand/collapse button
    const expandBtn = document.createElement('button');
    expandBtn.className = 'gv-folder-expand-btn';
    expandBtn.innerHTML = isExpanded
      ? '<span class="google-symbols">expand_more</span>'
      : '<span class="google-symbols">chevron_right</span>';
    expandBtn.addEventListener('click', () => this.toggleFolder(folder.id));

    // Folder icon
    const folderIcon = document.createElement('span');
    folderIcon.className = 'gv-folder-icon google-symbols';
    folderIcon.textContent = 'folder';
    folderIcon.style.cursor = 'pointer';
    folderIcon.style.userSelect = 'none';
    folderIcon.style.color = getFolderColor(folder.color, isDarkMode());

    folderIcon.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent bubbling issues
      this.showColorPicker(folder.id, e, true); // Allow toggle behavior
    });

    // Folder name
    const folderName = document.createElement('span');
    folderName.className = 'gv-folder-name gds-label-l';
    folderName.textContent = folder.name;
    folderName.style.cursor = 'pointer';
    folderName.addEventListener('click', (event) => this.handleFolderNameClick(folder.id, event));
    folderName.addEventListener('dblclick', () => this.handleFolderNameDoubleClick(folder.id));

    // Add tooltip event listeners
    folderName.addEventListener('mouseenter', () => this.showTooltip(folderName, folder.name));
    folderName.addEventListener('mouseleave', () => this.hideTooltip());

    // Pin button
    const pinBtn = document.createElement('button');
    pinBtn.className = 'gv-folder-pin-btn';
    const pinIcon = document.createElement('span');
    pinIcon.className = 'google-symbols';
    pinIcon.textContent = 'push_pin';
    // Add filled style for pinned folders
    if (folder.pinned) {
      pinIcon.style.fontVariationSettings = "'FILL' 1";
    }
    pinBtn.appendChild(pinIcon);
    pinBtn.title = folder.pinned ? this.t('folder_unpin') : this.t('folder_pin');
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePinFolder(folder.id);
    });

    // Actions menu
    const actionsBtn = document.createElement('button');
    actionsBtn.className = 'gv-folder-actions-btn';
    actionsBtn.innerHTML = '<span class="google-symbols">more_vert</span>';
    actionsBtn.addEventListener('click', (e) => this.showFolderMenu(e, folder.id));

    folderHeader.appendChild(expandBtn);
    folderHeader.appendChild(folderIcon);
    folderHeader.appendChild(folderName);
    folderHeader.appendChild(pinBtn);
    folderHeader.appendChild(actionsBtn);

    // Setup drop zone for conversations and folders
    this.setupDropZone(folderHeader, folder.id);

    folderEl.appendChild(folderHeader);

    // Apply draggable behavior dynamically based on current state
    // This ensures draggability is always in sync with folder structure
    this.applyFolderDraggableBehavior(folderHeader, folder);

    // Folder content (conversations and subfolders)
    if (isExpanded) {
      const content = document.createElement('div');
      content.className = 'gv-folder-content';
      // Fix: Allow dropping into the content area of the folder (not just the header)
      this.setupDropZone(content, folder.id);

      // Render conversations in this folder (sorted: starred first)
      const conversations = this.data.folderContents[folder.id] || [];
      const filteredConversations = this.filterVisibleConversations(
        conversations,
        includeFolderSubtree,
      );
      const sortedConversations = this.sortConversations(filteredConversations);
      sortedConversations.forEach((conv, i) => {
        const convEl = this.createConversationElement(conv, folder.id, level + 1);
        if (!isSearchActive && this.conversationSortMode === 'manual') {
          this.setupConversationReorderZone(convEl, folder.id, i);
        }
        content.appendChild(convEl);
      });

      // Render subfolders (sorted)
      const subfolders = this.data.folders.filter((f) => f.parentId === folder.id);
      const sortedSubfolders = this.sortFolders(subfolders);
      const visibleSubfolders = sortedSubfolders.filter((subfolder) =>
        isSearchActive
          ? includeFolderSubtree
            ? true
            : this.matchesFolderSearchTree(subfolder.id)
          : true,
      );
      let subfolderIndex = 0;
      if (!isSearchActive && visibleSubfolders.length > 0) {
        content.appendChild(this.createReorderGap(folder.id, 'folder', 0));
      }
      visibleSubfolders.forEach((subfolder) => {
        const subfolderEl = this.createFolderElement(
          subfolder,
          level + 1,
          includeFolderSubtree,
        );
        content.appendChild(subfolderEl);
        subfolderIndex++;
        if (!isSearchActive) {
          content.appendChild(this.createReorderGap(folder.id, 'folder', subfolderIndex));
        }
      });

      folderEl.appendChild(content);
    }

    return folderEl;
  }

  private clearPendingFolderNameClick(): void {
    if (this.folderNameClickTimeout === null) return;
    clearTimeout(this.folderNameClickTimeout);
    this.folderNameClickTimeout = null;
  }

  private handleFolderNameClick(folderId: string, event: MouseEvent): void {
    // Double-click dispatches a second click with detail > 1; skip toggle for that sequence.
    if (event.detail > 1) {
      this.clearPendingFolderNameClick();
      return;
    }

    this.clearPendingFolderNameClick();
    this.folderNameClickTimeout = window.setTimeout(() => {
      this.folderNameClickTimeout = null;
      this.toggleFolder(folderId);
    }, FOLDER_NAME_SINGLE_CLICK_DELAY_MS);
  }

  private handleFolderNameDoubleClick(folderId: string): void {
    this.clearPendingFolderNameClick();
    this.renameFolder(folderId);
  }

  private createConversationElement(
    conv: ConversationReference,
    folderId: string,
    level: number,
  ): HTMLElement {
    const convEl = document.createElement('div');
    convEl.className = conv.starred
      ? 'gv-folder-conversation gv-starred'
      : 'gv-folder-conversation';
    convEl.dataset.conversationId = conv.conversationId;
    convEl.dataset.folderId = folderId;
    // Increase indentation for conversations under folders
    convEl.style.paddingLeft = `${calculateFolderConversationPaddingLeft(level, this.folderTreeIndent)}px`; // More indentation for tree structure

    // Try to sync title from native conversation
    // Decide what title to display, respecting manual renames and hidden native list
    let displayTitle = conv.title;
    if (!conv.customTitle && !this.hideArchivedConversations) {
      const syncedTitle = this.syncConversationTitleFromNative(conv.conversationId);
      if (syncedTitle && syncedTitle !== conv.title) {
        conv.title = syncedTitle;
        displayTitle = syncedTitle;
        // Buffer title updates during render to avoid multiple rapid saves
        this.pendingTitleUpdates.set(conv.conversationId, syncedTitle);
        this.debug('Buffered title update for:', conv.conversationId);
      }
    }

    // Make conversation draggable within folders
    convEl.draggable = true;
    convEl.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      this.setReorderDropZonesExpanded(true);

      // If this conversation is not selected, select it exclusively
      if (!this.selectedConversations.has(conv.conversationId)) {
        this.clearSelection();
        this.selectConversation(conv.conversationId);
        this.updateConversationSelectionUI();
      }

      // Cancel long press if drag starts
      if (this.longPressTimeout) {
        clearTimeout(this.longPressTimeout);
        this.longPressTimeout = null;
      }

      // Include all selected conversations in the drag data
      const selectedConvs = this.getSelectedConversationsData(folderId);
      const dragData = {
        type: 'conversation',
        conversations: selectedConvs,
        sourceFolderId: folderId, // Track where they're being dragged from
      };
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('application/json', JSON.stringify(dragData));

      // Apply opacity to all selected conversations
      this.selectedConversations.forEach((id) => {
        const el = this.containerElement?.querySelector(
          `[data-conversation-id="${id}"]`,
        ) as HTMLElement;
        if (el) el.style.opacity = '0.5';
      });
    });

    convEl.addEventListener('dragend', () => {
      this.setReorderDropZonesExpanded(false);
      // Restore opacity for all selected conversations
      this.selectedConversations.forEach((id) => {
        const el = this.containerElement?.querySelector(
          `[data-conversation-id="${id}"]`,
        ) as HTMLElement;
        if (el) el.style.opacity = '1';
      });

      // If we are not in multi-select mode, clear the temporary selection
      if (!this.isMultiSelectMode) {
        this.clearSelection();
        this.cleanupSelectionArtifacts();
      }
    });

    // ChatGPT conversations use one stable, lightweight icon. Legacy Gemini
    // metadata may remain in imported backups but is never interpreted here.
    const icon = document.createElement('mat-icon');
    icon.className =
      'mat-icon notranslate gv-conversation-icon google-symbols mat-ligature-font mat-icon-no-color';
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-hidden', 'true');

    const iconName = DEFAULT_CONVERSATION_ICON;
    icon.setAttribute('fonticon', iconName);
    icon.textContent = iconName;

    // Conversation title
    const title = document.createElement('span');
    title.className = 'gv-conversation-title gds-label-l';
    title.textContent = displayTitle;

    // Add tooltip event listeners
    title.addEventListener('mouseenter', () => this.showTooltip(title, displayTitle));
    title.addEventListener('mouseleave', () => this.hideTooltip());

    // Actions container for buttons
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'gv-conversation-actions';

    // Star button
    const starBtn = document.createElement('button');
    starBtn.className = conv.starred
      ? 'gv-conversation-star-btn starred'
      : 'gv-conversation-star-btn';
    const starIcon = conv.starred ? 'star' : 'star_outline';
    starBtn.innerHTML = `<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">${starIcon}</mat-icon>`;
    starBtn.title = conv.starred ? this.t('conversation_unstar') : this.t('conversation_star');
    starBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleConversationStar(folderId, conv.conversationId);
    });

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'gv-conversation-remove-btn';
    removeBtn.innerHTML =
      '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">close</mat-icon>';
    removeBtn.title = this.t('folder_remove_conversation');
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.confirmRemoveConversation(folderId, conv.conversationId, displayTitle, e);
    });

    actionsContainer.appendChild(starBtn);
    actionsContainer.appendChild(removeBtn);

    // Long-press detection for entering multi-select mode
    let longPressTriggered = false;

    convEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // Only left mouse button
      longPressTriggered = false;

      this.longPressTimeout = window.setTimeout(() => {
        longPressTriggered = true;
        this.enterMultiSelectMode(conv.conversationId, 'folder', folderId);
      }, this.longPressThreshold);
    });

    convEl.addEventListener('mouseup', () => {
      if (this.longPressTimeout) {
        clearTimeout(this.longPressTimeout);
        this.longPressTimeout = null;
      }
    });

    convEl.addEventListener('mouseleave', () => {
      if (this.longPressTimeout) {
        clearTimeout(this.longPressTimeout);
        this.longPressTimeout = null;
      }
    });

    // Click to navigate or toggle selection based on mode
    convEl.addEventListener('click', (e) => {
      // Prevent navigation if long-press was triggered
      if (longPressTriggered) {
        longPressTriggered = false;
        return;
      }

      if (this.isMultiSelectMode) {
        // Multi-select mode: validate folder before toggling selection
        e.preventDefault();
        e.stopPropagation();

        // Prevent cross-folder selection
        if (
          this.multiSelectSource === 'folder' &&
          this.multiSelectFolderId &&
          this.multiSelectFolderId !== folderId
        ) {
          // Provide visual feedback for invalid selection attempt
          this.showInvalidSelectionFeedback(convEl);
          return;
        }

        this.toggleConversationSelection(conv.conversationId);
        this.updateConversationSelectionUI();
      } else {
        // Normal mode: navigate to conversation
        this.navigateToConversationById(folderId, conv.conversationId);
      }
    });

    // Double-click to rename
    title.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.renameConversation(folderId, conv.conversationId, title);
    });

    convEl.appendChild(icon);
    convEl.appendChild(title);
    convEl.appendChild(actionsContainer);

    return convEl;
  }

  private setupDropZone(element: HTMLElement, folderId: string): void {
    element.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation(); // Prevent root drop zone from also highlighting
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      element.classList.add('gv-folder-dragover');
    });

    element.addEventListener('dragleave', (e) => {
      // Only remove highlight when cursor truly leaves the element (not just entering a child)
      const rect = element.getBoundingClientRect();
      const x = (e as DragEvent).clientX;
      const y = (e as DragEvent).clientY;

      if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
        element.classList.remove('gv-folder-dragover');
      }
    });

    element.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation(); // CRITICAL: Prevent event bubbling to root drop zone
      element.classList.remove('gv-folder-dragover');

      const data = e.dataTransfer?.getData('application/json');
      if (!data) return;

      try {
        const dragData: DragData = JSON.parse(data);

        // Pre-cleanup: Restore opacity immediately before processing drop
        // This prevents visual artifacts if dragend doesn't fire properly
        this.selectedConversations.forEach((id) => {
          const el = this.findConversationElement(id);
          if (el) el.style.opacity = '1';
        });

        // Handle different drag types
        if (dragData.type === 'folder') {
          // Handle folder drop
          this.debug('Dropping folder into folder:', dragData.title, '->', folderId);
          this.addFolderToFolder(folderId, dragData);
        } else {
          // Handle conversation drop - supports both single and multiple conversations
          if (dragData.conversations && dragData.conversations.length > 0) {
            // Multi-select drag
            this.debug('Dropping multiple conversations:', dragData.conversations.length);
            this.addConversationsToFolder(
              folderId,
              dragData.conversations,
              dragData.sourceFolderId,
            );
          } else {
            // Legacy single conversation drag (backward compatibility)
            this.addConversationToFolder(folderId, dragData);
          }
        }

        // Clear selection and exit multi-select mode after successful drop
        this.exitMultiSelectMode();
      } catch (error) {
        console.error('[FolderManager] Drop error:', error);
      }
    });
  }

  private setupRootDropZone(element: HTMLElement): void {
    element.addEventListener('dragover', (e) => {
      // Allow both folder and conversation drops on the root zone
      const data = e.dataTransfer?.types.includes('application/json');
      if (!data) return;

      e.preventDefault();
      e.stopPropagation(); // Prevent parent handlers from firing
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      element.classList.add('gv-folder-list-dragover');
    });

    element.addEventListener('dragleave', (e) => {
      // Check if we're leaving this element (not just entering a child)
      const rect = element.getBoundingClientRect();
      const x = (e as DragEvent).clientX;
      const y = (e as DragEvent).clientY;

      if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
        element.classList.remove('gv-folder-list-dragover');
      }
    });

    element.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation(); // Prevent parent handlers from firing
      element.classList.remove('gv-folder-list-dragover');

      const data = e.dataTransfer?.getData('application/json');
      if (!data) return;

      try {
        const dragData: DragData = JSON.parse(data);

        // Pre-cleanup: Restore opacity immediately before processing drop
        // This prevents visual artifacts if dragend doesn't fire properly
        this.selectedConversations.forEach((id) => {
          const el = this.findConversationElement(id);
          if (el) el.style.opacity = '1';
        });

        // Handle different drag types at root level
        if (dragData.type === 'folder') {
          this.moveFolderToRoot(dragData);
        } else {
          // Handle conversation drop - supports both single and multiple conversations
          if (dragData.conversations && dragData.conversations.length > 0) {
            // Multi-select drag
            this.debug(
              'Adding multiple conversations to root level:',
              dragData.conversations.length,
            );
            this.addConversationsToFolder(
              ROOT_CONVERSATIONS_ID,
              dragData.conversations,
              dragData.sourceFolderId,
            );
          } else {
            // Legacy single conversation drag (backward compatibility)
            this.debug('Adding conversation to root level:', dragData.title);
            this.addConversationToFolder(ROOT_CONVERSATIONS_ID, dragData);
          }
        }

        // Clear selection and exit multi-select mode after successful drop
        this.exitMultiSelectMode();
      } catch (error) {
        console.error('[FolderManager] Root drop error:', error);
      }
    });
  }

  private makeConversationsDraggable(): void {
    if (!this.sidebarContainer) return;

    const conversations = getChatGptConversationElements(this.sidebarContainer);
    conversations.forEach((conv) => {
      this.makeConversationDraggable(conv);

      // Apply hide archived setting
      const convId = this.extractConversationId(conv);
      const isArchived = this.isConversationInFolders(convId);

      if (this.hideArchivedConversations && isArchived) {
        conv.classList.add('gv-conversation-archived');
      } else {
        conv.classList.remove('gv-conversation-archived');
      }
    });
  }

  /**
   * Pinned folders are fixed in place and cannot be dragged.
   * Non-pinned folders can be moved even when they have descendants.
   */
  private canFolderBeDragged(folder: Folder): boolean {
    return !folder.pinned;
  }

  private setReorderDropZonesExpanded(expanded: boolean): void {
    const container = this.containerElement;
    if (!container) return;

    container.classList.toggle('gv-folder-reorder-active', expanded);
    if (!expanded) {
      container
        .querySelectorAll('.gv-reorder-gap-active')
        .forEach((gap) => gap.classList.remove('gv-reorder-gap-active'));
    }
  }

  /**
   * Strategy Pattern: Apply or remove draggable behavior based on folder state
   * Open/Closed Principle: Easy to extend with new draggable conditions
   *
   * This method ensures that folder draggability is always in sync with the current state.
   * It will enable dragging if conditions are met, or disable it if not.
   *
   * @param element - The folder header element
   * @param folder - The folder data object
   */
  private applyFolderDraggableBehavior(element: HTMLElement, folder: Folder): void {
    if (this.canFolderBeDragged(folder)) {
      this.enableFolderDragging(element, folder);
    } else {
      this.disableFolderDragging(element);
    }
  }

  /**
   * Enable dragging for a folder element
   * Encapsulates all logic needed to make a folder draggable
   *
   * Uses a data attribute to track drag listeners and prevent duplicates.
   * This ensures event listeners are only added once per element lifecycle.
   *
   * @param element - The folder header element
   * @param folder - The folder data object
   */
  private enableFolderDragging(element: HTMLElement, folder: Folder): void {
    // Mark element as draggable
    element.draggable = true;
    element.style.cursor = 'grab';

    // Check if drag listeners are already attached
    if (element.dataset.dragListenersAttached === 'true') {
      this.debug('Drag listeners already attached for folder:', folder.name);
      return;
    }

    // Create named event handler functions for proper cleanup
    const handleDragStart = (e: Event) => {
      e.stopPropagation(); // Prevent parent folder from being dragged
      this.setReorderDropZonesExpanded(true);

      const dragData: DragData = {
        type: 'folder',
        folderId: folder.id,
        title: folder.name,
      };

      const dt = (e as DragEvent).dataTransfer;
      if (dt) dt.effectAllowed = 'move';
      dt?.setData('application/json', JSON.stringify(dragData));
      element.style.opacity = '0.5';

      this.debug(
        'Folder drag start:',
        folder.name,
        'canBeDragged:',
        this.canFolderBeDragged(folder),
      );
    };

    const handleDragEnd = () => {
      this.setReorderDropZonesExpanded(false);
      element.style.opacity = '1';
    };

    // Store references for potential cleanup
    type DragEl = Element & {
      _dragStartHandler?: (e: Event) => void;
      _dragEndHandler?: () => void;
    };
    (element as DragEl)._dragStartHandler = handleDragStart;
    (element as DragEl)._dragEndHandler = handleDragEnd;

    // Add drag event listeners
    element.addEventListener('dragstart', handleDragStart);
    element.addEventListener('dragend', handleDragEnd);

    // Mark that listeners are attached
    element.dataset.dragListenersAttached = 'true';
  }

  /**
   * Disable dragging for a folder element
   * Ensures folder cannot be dragged when it has subfolders
   *
   * Properly removes event listeners to prevent memory leaks.
   *
   * @param element - The folder header element
   */
  private disableFolderDragging(element: HTMLElement): void {
    element.draggable = false;
    element.style.cursor = '';

    // Remove drag event listeners if they exist
    if (element.dataset.dragListenersAttached === 'true') {
      type DragEl = Element & {
        _dragStartHandler?: (e: Event) => void;
        _dragEndHandler?: () => void;
      };
      const dragStartHandler = (element as DragEl)._dragStartHandler;
      const dragEndHandler = (element as DragEl)._dragEndHandler;

      if (dragStartHandler) {
        element.removeEventListener('dragstart', dragStartHandler);
        delete (element as DragEl)._dragStartHandler;
      }

      if (dragEndHandler) {
        element.removeEventListener('dragend', dragEndHandler);
        delete (element as DragEl)._dragEndHandler;
      }

      delete element.dataset.dragListenersAttached;
    }
  }

  private makeConversationDraggable(element: HTMLElement): void {
    // Idempotency guard 鈥?the method can legitimately be called more than once
    // per element (e.g. sidebar success path + document sweep on fallback,
    // MutationObserver re-entry, route change re-scans). Without this guard
    // we'd stack duplicate mousedown / dragstart listeners on every call.
    if (element.dataset.gvConvDragAttached === 'true') return;
    element.dataset.gvConvDragAttached = 'true';

    element.draggable = true;
    element.style.cursor = 'grab';

    // Long-press detection for entering multi-select mode
    let longPressTriggered = false;
    let longPressTimeoutId: number | null = null;
    // The row actually picked up in the most recent dragstart (resolved from the
    // event target), so dragend can un-dim the right element when this listener
    // is attached to a container rather than a single row.
    let lastDragSourceEl: HTMLElement | null = null;

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // Only left mouse button
      longPressTriggered = false;

      const conversationId = this.extractConversationId(element);
      // Capture the full conversation snapshot NOW, while the element is
      // still mounted and refers to the conversation the user is touching.
      // ChatGPT virtualises off-screen sidebar entries, and once the user
      // scrolls past this row, the DOM node may be recycled to display a
      // different conversation. Without this snapshot the dragstart handler
      // can't find the original conversation any more.
      const snapshot = this.captureNativeConversationSnapshot(element);

      longPressTimeoutId = window.setTimeout(() => {
        longPressTriggered = true;
        this.enterMultiSelectMode(conversationId, 'native');
        if (snapshot) this.selectedConversationData.set(conversationId, snapshot);
        // Add visual feedback to this element
        element.classList.add('gv-conversation-selected');
      }, this.longPressThreshold);
    };

    const handleMouseUp = () => {
      if (longPressTimeoutId) {
        clearTimeout(longPressTimeoutId);
        longPressTimeoutId = null;
      }
    };

    const handleMouseLeave = () => {
      if (longPressTimeoutId) {
        clearTimeout(longPressTimeoutId);
        longPressTimeoutId = null;
      }
    };

    // Add event listeners
    element.addEventListener('mousedown', handleMouseDown);
    element.addEventListener('mouseup', handleMouseUp);
    element.addEventListener('mouseleave', handleMouseLeave);

    // Click handler for multi-select mode
    element.addEventListener(
      'click',
      (e) => {
        // Prevent navigation if long-press was triggered
        if (longPressTriggered) {
          e.preventDefault();
          e.stopPropagation();
          longPressTriggered = false;
          return;
        }

        if (this.isMultiSelectMode) {
          // Multi-select mode: toggle selection
          e.preventDefault();
          e.stopPropagation();
          const conversationId = this.extractConversationId(element);
          // Snapshot the conversation BEFORE the toggle so virtualisation
          // can't recycle the row out from under us — same reasoning as
          // the long-press path.
          const snapshot = this.captureNativeConversationSnapshot(element);
          this.toggleConversationSelection(conversationId, snapshot ?? undefined);

          // Update visual state
          if (this.selectedConversations.has(conversationId)) {
            element.classList.add('gv-conversation-selected');
          } else {
            element.classList.remove('gv-conversation-selected');
          }

          this.updateConversationSelectionUI();
          return;
        }
      },
      true,
    ); // Use capture phase to intercept before navigation

    element.addEventListener('dragstart', (e) => {
      this.setReorderDropZonesExpanded(true);
      // Resolve the conversation from the ACTUAL drag target, not the closed-over
      // `element`. This listener can also be attached to a *container* (the
      // sidebar MutationObserver makes wrapper nodes draggable, and the event
      // bubbles up to them), whose first link is always the topmost conversation
      // — so using `element` here dragged the topmost row no matter which one the
      // user grabbed. `e.target` is the row the user actually picked up.
      const dragEl = this.resolveDragSourceElement(e) ?? element;
      lastDragSourceEl = dragEl;

      const title = this.extractConversationTitleForDrag(dragEl);
      const conversationId = this.extractConversationId(dragEl);

      // Extract URL and conversation metadata together
      const conversationData = this.extractConversationData(dragEl);

      // Restrict to move-only to prevent Chrome from triggering split-screen/tab tiling
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';

      // If this conversation is not selected, decide how to fold it in:
      //   - Multi-select mode active → EXTEND the existing selection. ChatGPT
      //     recycles sidebar DOM nodes during scroll, so the user may be
      //     grabbing a row that wasn't part of the original multi-select.
      //     Clearing here would silently throw away every other selection.
      //   - Not in multi-select mode → exclusive single-select.
      if (!this.selectedConversations.has(conversationId)) {
        const snapshot = this.captureNativeConversationSnapshot(dragEl);
        if (!this.isMultiSelectMode) {
          this.clearSelection();
        }
        this.selectConversation(conversationId, snapshot ?? undefined);
        dragEl.classList.add('gv-conversation-selected');
        this.updateConversationSelectionUI();
      }

      // Cancel long press if drag starts
      if (longPressTimeoutId) {
        clearTimeout(longPressTimeoutId);
        longPressTimeoutId = null;
      }

      // Check if we have multiple selections
      if (this.selectedConversations.size > 1) {
        // Multi-select drag — build the payload from snapshots captured
        // at selection time. We do NOT re-query the sidebar DOM here:
        // ChatGPT virtualises off-screen entries, so any selected
        // conversation the user has since scrolled out of view would
        // return null from `findConversationElement` and silently fall
        // out of the drag. The snapshot Map is populated whenever a
        // conversation enters the selection (long-press, click toggle,
        // dragstart self-select).
        const selectedConvs: ConversationReference[] = [];
        this.selectedConversations.forEach((id) => {
          const cached = this.selectedConversationData.get(id);
          if (cached) {
            selectedConvs.push({ ...cached, addedAt: Date.now() });
            return;
          }
          // No cached snapshot (legacy selection from before this fix, or
          // a selection that pre-dated the cache wiring). Fall back to a
          // DOM lookup — works only for currently-mounted rows.
          const convEl = this.findConversationElement(id);
          if (convEl) {
            const fallbackSnapshot = this.captureNativeConversationSnapshot(convEl);
            if (fallbackSnapshot) {
              selectedConvs.push(fallbackSnapshot);
              this.selectedConversationData.set(id, fallbackSnapshot);
            }
          }
        });

        const dragData: DragData = {
          type: 'conversation',
          title: `${selectedConvs.length} conversations`,
          conversations: selectedConvs,
        };

        e.dataTransfer?.setData('application/json', JSON.stringify(dragData));

        // Apply opacity to whatever selected rows ARE currently mounted —
        // virtualised ones can't be visibly dimmed; that's fine.
        this.selectedConversations.forEach((id) => {
          const el = this.findConversationElement(id);
          if (el) el.style.opacity = '0.5';
        });
      } else {
        // Single conversation drag (legacy behavior)
        this.debug('Drag start:', {
          title,
          url: conversationData.url,
        });

        const dragData: DragData = {
          type: 'conversation',
          conversationId,
          title,
          url: conversationData.url,
        };

        e.dataTransfer?.setData('application/json', JSON.stringify(dragData));
        dragEl.style.opacity = '0.5';
      }
    });

    element.addEventListener('dragend', () => {
      this.setReorderDropZonesExpanded(false);
      // Restore opacity for all selected conversations
      if (this.selectedConversations.size > 1) {
        this.selectedConversations.forEach((id) => {
          const el = this.findConversationElement(id);
          if (el) el.style.opacity = '1';
        });
      } else {
        // Restore the row we actually dimmed (may differ from `element` when the
        // listener fired on a container — see dragstart's resolveDragSourceElement).
        (lastDragSourceEl ?? element).style.opacity = '1';
      }
      lastDragSourceEl = null;

      // If we are not in multi-select mode, clear the temporary selection
      if (!this.isMultiSelectMode) {
        this.clearSelection();
        this.cleanupSelectionArtifacts();
      }
    });
  }

  /**
   * Resolve the conversation row the user actually grabbed for a drag, from the
   * event target — NOT from the listener's closed-over element. A dragstart
   * listener may sit on a container (the sidebar observer makes wrapper nodes
   * draggable and the event bubbles up), and a container's first `/c/` link is
   * always the topmost conversation, so the closed-over element would drag the
   * wrong row. Returns the nearest single-conversation row to `e.target`, or
   * null (caller falls back to its own element) when the target isn't a
   * recognisable single-conversation row.
   */
  private resolveDragSourceElement(e: DragEvent): HTMLElement | null {
    const target = e.target as HTMLElement | null;
    if (!target?.closest) return null;
    const row = target.closest<HTMLElement>(
      'li, [data-testid*="history" i], [data-testid="conversation"], [role="listitem"], [role="treeitem"]',
    );
    // Trust the row only when it holds exactly one conversation link — i.e. it's
    // a real row, not a multi-conversation container.
    if (row && row.querySelectorAll('a[href*="/c/"]').length === 1) return row;
    return null;
  }

  // Helper method to find conversation element by ID
  private findConversationElement(conversationId: string): HTMLElement | null {
    const normalizedId = this.normalizeConversationId(conversationId);
    const folderSelectors = [`[data-conversation-id="${conversationId}"]`];
    if (normalizedId) {
      folderSelectors.push(
        `[data-conversation-id="${normalizedId}"]`,
        `[data-conversation-id="c_${normalizedId}"]`,
      );
    }

    // Check in folder conversations
    const folderConv = this.containerElement?.querySelector(
      folderSelectors.join(', '),
    ) as HTMLElement;
    if (folderConv) return folderConv;

    const nativeConvs = this.sidebarContainer
      ? getChatGptConversationElements(this.sidebarContainer)
      : [];
    for (const conv of nativeConvs) {
      const id = this.normalizeConversationId(this.extractConversationId(conv));
      if (id && id === normalizedId) {
        return conv;
      }
    }

    return null;
  }

  private extractConversationTitleForDrag(element: HTMLElement): string {
    return (
      this.extractNativeConversationTitle(element) ||
      getChatGptConversationTitle(element) ||
      element.querySelector('.gv-conversation-title')?.textContent?.trim() ||
      element.querySelector('.conversation-title')?.textContent?.trim() ||
      'Untitled'
    );
  }

  private isUntitledPlaceholder(title: string | null | undefined): boolean {
    return !title || title.trim() === '' || /^untitled$/i.test(title.trim());
  }

  private resolveConversationTitle(
    conversationId: string,
    title: string | null | undefined,
  ): string {
    const trimmed = title?.trim() || '';
    if (!this.isUntitledPlaceholder(trimmed)) return trimmed;
    return this.syncConversationTitleFromNative(conversationId) || trimmed || 'Untitled';
  }

  /** Current ChatGPT can expose an internal c_ id while a sidebar row is
   * transiently detached. Keep this bounded fallback in one place; live href
   * parsing always goes through the shared /c/:id adapter first. */
  private extractConversationIdFromJslog(scope: Element): string | null {
    const parse = (value: string | null): string | null => {
      const match = value?.match(/\bc_([a-z0-9_-]{8,})\b/i);
      return normalizeChatGptConversationId(match?.[1]);
    };

    const direct = parse(scope.getAttribute('jslog'));
    if (direct) return direct;

    for (const node of Array.from(scope.querySelectorAll('[jslog]'))) {
      const nested = parse(node.getAttribute('jslog'));
      if (nested) return nested;
    }
    return null;
  }

  private extractConversationId(element: HTMLElement): string {
    const conversationId =
      getChatGptConversationId(element) ?? this.extractConversationIdFromJslog(element);
    if (conversationId) return conversationId;

    // Fallback: generate unique ID from element attributes
    // Use multiple attributes to ensure uniqueness
    const title = this.extractConversationTitleForDrag(element);
    const index = Array.from(element.parentElement?.children || []).indexOf(element);

    // Generate unique ID combining title, index, random, and timestamp
    const uniqueString = `${title}_${index}_${Math.random()}_${Date.now()}`;
    const fallbackId = `conv_${this.hashString(uniqueString)}`;
    this.debugWarn('Could not extract a ChatGPT conversation ID, using fallback:', fallbackId);
    return fallbackId;
  }

  private extractConversationData(element: HTMLElement): { url: string } {
    const conversationId =
      getChatGptConversationId(element) ?? this.extractConversationIdFromJslog(element);
    const nativeUrl = getChatGptConversationUrl(element);
    return {
      url:
        nativeUrl ||
        (conversationId ? this.buildConversationUrlFromId(conversationId) : window.location.href),
    };
  }

  /**
   * Extract conversation ID from a DOM element
   * Used for handling removed/added conversations in MutationObserver
   *
   * @param element - The conversation element to extract ID from
   * @returns The normalized ChatGPT conversation ID or undefined if not found
   */
  private extractConversationIdFromElement(element: Element): string | undefined {
    const fromHref = element instanceof HTMLElement ? getChatGptConversationId(element) : null;
    return fromHref ?? this.extractConversationIdFromJslog(element) ?? undefined;
  }

  private setupMutationObserver(): void {
    if (!this.sidebarContainer) return;

    // Disconnect existing observer to prevent duplicates
    if (this.conversationObserver) {
      this.conversationObserver.disconnect();
      this.conversationObserver = null;
    }

    this.conversationObserver = new MutationObserver((mutations) => {
      // 1. Handle added conversations (always safe)
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement) {
            const conversations = getChatGptConversationElements(node);
            // Only treat the added node itself as a draggable conversation when
            // it is a SINGLE-conversation row. Adding a multi-conversation
            // container here made the whole list draggable, and the container's
            // first link (the topmost conversation) became the drag payload no
            // matter which row the user grabbed.
            if (
              getChatGptConversationId(node) &&
              node.querySelectorAll('a[href*="/c/"]').length === 1
            ) {
              conversations.unshift(node);
            }
            conversations.forEach((convElement) => {
              this.makeConversationDraggable(convElement);
              this.applyHideArchivedToConversation(convElement);
              this.cancelPendingRemovalForElement(convElement);
            });
          }
        });
      });

      // 2. Handle removed conversations with safeguards
      // CRITICAL FIX: Prevent data loss when network disconnects or UI refreshes

      // Check 1: If offline, assume removals are due to network error
      if (!navigator.onLine) {
        this.debug('Network offline, ignoring conversation removals to prevent data loss');
        return;
      }

      // Check 2: Calculate total conversations being removed in this batch
      let totalRemovedCount = 0;
      const nodesWithRemovals: HTMLElement[] = [];

      mutations.forEach((mutation) => {
        mutation.removedNodes.forEach((node) => {
          if (node instanceof HTMLElement) {
            const containedConvs = getChatGptConversationElements(node);
            const isConv = !!getChatGptConversationId(node);
            const containedConvsCount = containedConvs.length;

            if (isConv) {
              totalRemovedCount++;
              nodesWithRemovals.push(node);
            } else if (containedConvsCount > 0) {
              totalRemovedCount += containedConvsCount;
              nodesWithRemovals.push(node);
            }
          }
        });
      });

      // If no conversations were removed, we're done
      if (totalRemovedCount === 0) return;

      // Check 3: If multiple conversations are removed at once, it's likely a UI refresh/clear
      // Users typically delete conversations one by one.
      // EXCEPTION: If we are in multi-select mode, the user might be performing a bulk delete.
      if (totalRemovedCount > 1 && !this.isMultiSelectMode) {
        this.debugWarn(
          `Ignored bulk removal of ${totalRemovedCount} conversations - likely UI refresh`,
        );
        return;
      }

      // NEW: Instead of immediately removing, schedule a delayed check
      // This prevents false positives when ChatGPT temporarily removes/re-adds DOM elements during UI updates
      nodesWithRemovals.forEach((node) => {
        const conversations = getChatGptConversationId(node)
          ? [node]
          : getChatGptConversationElements(node);

        conversations.forEach((conv) => {
          // Extract conversation ID from the removed element
          const conversationId = this.extractConversationIdFromElement(conv);

          if (conversationId) {
            this.debug('Detected potential conversation removal:', conversationId);
            // Schedule delayed removal check
            this.scheduleConversationRemovalCheck(conversationId);
          }
        });
      });
    });

    this.conversationObserver.observe(this.sidebarContainer, {
      childList: true,
      subtree: true,
    });
  }

  /**
   * Setup observer to monitor sidebar open/close state
   * Hides folder container when sidebar is collapsed for better UX
   */
  private setupSideNavObserver(): void {
    const appRoot = document.querySelector('#app-root');
    if (!appRoot) {
      this.debugWarn('Could not find #app-root element for sidebar monitoring');
      return;
    }

    this.sideNavObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          this.updateVisibilityBasedOnSideNav();
        }
      });
    });

    this.sideNavObserver.observe(appRoot, {
      attributes: true,
      attributeFilter: ['class'],
    });

    this.debug('Side nav observer setup complete');
  }

  /**
   * Check if sidebar is open and update folder container visibility
   * Sidebar is considered open when #app-root has 'side-nav-open' class
   */
  private updateVisibilityBasedOnSideNav(): void {
    const appRoot = document.querySelector('#app-root');
    const freshSidebar = findChatGptSidebar();
    if (
      freshSidebar &&
      freshSidebar !== this.sidebarContainer &&
      this.isElementActuallyVisible(freshSidebar)
    ) {
      this.debug('Visible sidebar changed, reinitializing folder UI');
      this.sidebarContainer = freshSidebar;
      this.reinitializeFolderUI();
      return;
    }

    const shouldShow = this.shouldShowEmbeddedFolderContainer();
    const appRootSaysOpen = appRoot?.classList.contains('side-nav-open') ?? true;

    // Check if containerElement exists AND is still in the DOM
    // During screen resize (e.g., split-screen to fullscreen), ChatGPT may re-render the sidebar DOM,
    // causing containerElement to become detached from the DOM tree
    if (!this.containerElement || !document.body.contains(this.containerElement)) {
      if (shouldShow) {
        this.debug('Container element not in DOM, reinitializing folder UI');
        // Reinitialize the entire folder UI asynchronously
        // This ensures sidebarContainer and recentSection are also re-found
        this.reinitializeFolderUI();
      }
      return;
    }

    // Also check if sidebarContainer is still valid
    if (!this.sidebarContainer || !document.body.contains(this.sidebarContainer)) {
      if (appRootSaysOpen) {
        this.debug('Sidebar container not in DOM, reinitializing folder UI');
        this.reinitializeFolderUI();
      }
      return;
    }

    if (shouldShow) {
      this.containerElement.style.display = '';
      this.debug('Sidebar open - showing folder container');
    } else {
      this.containerElement.style.display = 'none';
      this.debug('Sidebar closed - hiding folder container');
    }
  }

  /**
   * Reinitialize folder UI when DOM elements become detached
   * This can happen during window resize or split-screen operations
   */
  private reinitializeFolderUI(): void {
    if (this.reinitializePromise) {
      this.debug('Reinitialization already in progress, skipping duplicate request');
      return;
    }

    this.reinitializePromise = (async () => {
      this.debug('Reinitializing folder UI...');

      // Execute general cleanup tasks first (including event listeners)
      this.cleanupTasks.forEach((task) => task());
      this.cleanupTasks = [];

      // Clean up observers/listeners tied to stale DOM nodes
      if (this.sideNavObserver) {
        this.sideNavObserver.disconnect();
        this.sideNavObserver = null;
      }

      if (this.conversationObserver) {
        this.conversationObserver.disconnect();
        this.conversationObserver = null;
      }

      this.cancelNativeMenuWatch();
      this.cancelNativeDialogWatch();
      this.cleanupNativeRemovalWatch();

      if (this.routeChangeCleanup) {
        try {
          this.routeChangeCleanup();
        } catch (error) {
          this.debugWarn('Route change cleanup during reinit failed:', error);
        }
        this.routeChangeCleanup = null;
      }

      if (this.sidebarClickListener && this.sidebarContainer) {
        try {
          this.sidebarContainer.removeEventListener('click', this.sidebarClickListener, true);
        } catch (error) {
          this.debugWarn('Sidebar click listener cleanup failed:', error);
        }
        this.sidebarClickListener = null;
      }

      if (this.containerElement?.isConnected) {
        try {
          this.containerElement.remove();
        } catch (error) {
          this.debugWarn('Failed to remove existing folder container during reinit:', error);
        }
      }

      this.closeActiveImportExportMenu();
      this.closeActiveImportDialog();
      this.clearActiveFolderInput();

      // Clear existing references so initialization starts from a clean slate
      this.containerElement = null;
      this.sidebarContainer = null;
      this.recentSection = null;

      await this.initializeFolderUI();
    })()
      .catch((error) => {
        this.debugWarn('Failed to reinitialize folder UI:', error);
      })
      .finally(() => {
        this.reinitializePromise = null;
      });
  }

  private createFolder(parentId: string | null = null): void {
    // Depth cap: subfolder creation stops once the parent is already as deep
    // as MAX_FOLDER_DEPTH allows. The sidebar context menu hides the affordance
    // at this depth, but guard here too so any other caller (imports, cross-
    // module wiring, drag shortcuts) can't silently exceed the cap. Root
    // creation (parentId === null) is always allowed.
    if (parentId !== null && this.getFolderDepth(parentId) >= MAX_FOLDER_DEPTH) {
      this.debugWarn('createFolder refused: parent is already at MAX_FOLDER_DEPTH', parentId);
      return;
    }

    if (this.activeFolderInput && !this.activeFolderInput.isConnected) {
      this.clearActiveFolderInput();
    }

    // Prevent creating multiple folder inputs simultaneously
    if (this.activeFolderInput) {
      // Focus existing input instead of creating a new one
      const existingInput = this.activeFolderInput.querySelector('input') as HTMLInputElement;
      if (existingInput) {
        existingInput.focus();
        return;
      }

      this.clearActiveFolderInput();
    }

    // Create inline input for folder name
    const inputContainer = document.createElement('div');
    inputContainer.className = 'gv-folder-inline-input';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'gv-folder-name-input';
    input.placeholder = this.t('folder_name_prompt');
    input.maxLength = 50;

    const saveBtn = document.createElement('button');
    saveBtn.className = 'gv-folder-inline-btn gv-folder-inline-save';
    saveBtn.innerHTML =
      '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">check</mat-icon>';
    saveBtn.title = this.t('pm_save');

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'gv-folder-inline-btn gv-folder-inline-cancel';
    cancelBtn.innerHTML =
      '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">close</mat-icon>';
    cancelBtn.title = this.t('pm_cancel');

    inputContainer.appendChild(input);
    inputContainer.appendChild(saveBtn);
    inputContainer.appendChild(cancelBtn);

    const save = () => {
      const name = input.value.trim();
      if (!name) {
        inputContainer.remove();
        this.clearActiveFolderInput();
        return;
      }

      const maxSortIndex = this.data.folders
        .filter((f) => f.parentId === parentId)
        .reduce((max, f) => Math.max(max, f.sortIndex ?? -1), -1);
      const folder: Folder = {
        id: this.generateId(),
        name,
        parentId,
        isExpanded: true,
        sortIndex: maxSortIndex + 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      this.data.folders.push(folder);
      this.data.folderContents[folder.id] = [];
      this.saveData();
      this.refresh();
    };

    const cancel = () => {
      inputContainer.remove();
      this.clearActiveFolderInput();
    };

    saveBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', cancel);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') cancel();
    });

    // Insert input into the folder list
    const folderList = this.containerElement?.querySelector('.gv-folder-list');
    if (folderList) {
      if (parentId) {
        // Insert after the parent folder
        const parentFolder = folderList.querySelector(`[data-folder-id="${parentId}"]`);
        if (parentFolder) {
          const parentContent = parentFolder.querySelector('.gv-folder-content');
          if (parentContent) {
            parentContent.insertBefore(inputContainer, parentContent.firstChild);
          } else {
            parentFolder.insertAdjacentElement('afterend', inputContainer);
          }
        } else {
          folderList.appendChild(inputContainer);
        }
      } else {
        folderList.insertBefore(inputContainer, folderList.firstChild);
      }

      input.focus();

      // Track this input as the active one
      this.activeFolderInput = inputContainer;
    }
  }

  private renameFolder(folderId: string): void {
    this.clearPendingFolderNameClick();

    const folder = this.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    // Find the folder element
    const folderEl = this.containerElement?.querySelector(`[data-folder-id="${folderId}"]`);
    if (!folderEl) return;

    const folderNameEl = folderEl.querySelector('.gv-folder-name');
    if (!folderNameEl) return;

    // Create inline input for renaming
    const inputContainer = document.createElement('span');
    inputContainer.className = 'gv-folder-rename-inline';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'gv-folder-rename-input';
    input.value = folder.name;
    input.maxLength = 50;

    const saveBtn = document.createElement('button');
    saveBtn.className = 'gv-folder-inline-btn gv-folder-inline-save';
    saveBtn.innerHTML =
      '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">check</mat-icon>';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'gv-folder-inline-btn gv-folder-inline-cancel';
    cancelBtn.innerHTML =
      '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">close</mat-icon>';

    inputContainer.appendChild(input);
    inputContainer.appendChild(saveBtn);
    inputContainer.appendChild(cancelBtn);

    const save = () => {
      const newName = input.value.trim();
      if (!newName) {
        restore();
        return;
      }

      folder.name = newName;
      folder.updatedAt = Date.now();
      this.saveData();
      this.refresh();
    };

    const restore = () => {
      folderNameEl.textContent = folder.name;
      inputContainer.remove();
      folderNameEl.classList.remove('gv-hidden');
    };

    const cancel = () => {
      restore();
    };

    saveBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', cancel);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') cancel();
    });

    // Hide original name and show input
    folderNameEl.classList.add('gv-hidden');
    folderNameEl.parentElement?.insertBefore(inputContainer, folderNameEl.nextSibling);
    input.focus();
    input.select();
  }

  private deleteFolder(folderId: string, _event?: MouseEvent): void {
    // Create inline confirmation using safe DOM API
    const confirmDialog = document.createElement('div');
    confirmDialog.className = 'gv-folder-confirm-dialog';

    // Create message element safely
    const message = document.createElement('div');
    message.className = 'gv-folder-confirm-message';
    message.textContent = this.t('folder_delete_confirm'); // Safe: uses textContent

    // Create actions container
    const actions = document.createElement('div');
    actions.className = 'gv-folder-confirm-actions';

    // Create buttons safely
    const yesBtn = document.createElement('button');
    yesBtn.className = 'gv-folder-confirm-btn gv-folder-confirm-yes';
    yesBtn.textContent = this.t('pm_delete'); // Safe: uses textContent

    const noBtn = document.createElement('button');
    noBtn.className = 'gv-folder-confirm-btn gv-folder-confirm-no';
    noBtn.textContent = this.t('pm_cancel'); // Safe: uses textContent

    // Assemble the dialog
    actions.appendChild(yesBtn);
    actions.appendChild(noBtn);
    confirmDialog.appendChild(message);
    confirmDialog.appendChild(actions);

    // Position near the folder
    // Position near the folder header
    const folderEl = this.containerElement?.querySelector(`[data-folder-id="${folderId}"]`);
    const headerEl = folderEl?.querySelector('.gv-folder-item-header');

    if (headerEl) {
      const rect = headerEl.getBoundingClientRect();
      confirmDialog.style.position = 'fixed';
      confirmDialog.style.top = `${rect.bottom + 4}px`;
      confirmDialog.style.left = `${rect.left + 24}px`; // Align with folder name
      confirmDialog.style.zIndex = '10002'; // Ensure it's on top
    } else if (folderEl) {
      const rect = folderEl.getBoundingClientRect();
      confirmDialog.style.position = 'fixed';
      confirmDialog.style.top = `${rect.top + 32}px`; // Fallback approximate height
      confirmDialog.style.left = `${rect.left}px`;
      confirmDialog.style.zIndex = '10002';
    }

    document.body.appendChild(confirmDialog);

    // Cleanup function
    const cleanup = () => {
      confirmDialog.remove();
    };

    yesBtn?.addEventListener('click', () => {
      // Remove folder and all subfolders recursively
      const foldersToDelete = this.getFolderAndDescendants(folderId);
      this.data.folders = this.data.folders.filter((f) => !foldersToDelete.includes(f.id));

      // Remove folder contents
      foldersToDelete.forEach((id) => {
        delete this.data.folderContents[id];
      });

      this.saveData();
      this.refresh();
      cleanup();
    });

    noBtn?.addEventListener('click', cleanup);

    // Close on click outside
    setTimeout(() => {
      const closeOnOutside = (e: MouseEvent) => {
        if (!confirmDialog.contains(e.target as Node)) {
          cleanup();
          document.removeEventListener('click', closeOnOutside);
        }
      };
      document.addEventListener('click', closeOnOutside);
    }, 0);
  }

  private getFolderAndDescendants(folderId: string): string[] {
    const result = [folderId];
    const children = this.data.folders.filter((f) => f.parentId === folderId);
    children.forEach((child) => {
      result.push(...this.getFolderAndDescendants(child.id));
    });
    return result;
  }

  private toggleFolder(folderId: string): void {
    const folder = this.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    folder.isExpanded = !folder.isExpanded;
    folder.updatedAt = Date.now();
    this.saveData();
    this.refresh();
  }

  private togglePinFolder(folderId: string): void {
    const folder = this.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    folder.pinned = !folder.pinned;
    folder.updatedAt = Date.now();
    this.saveData();
    this.refresh();
  }

  /**
   * Sort folders with pinned folders first, then by name using localized collation
   */
  private sortFolders(folders: Folder[]): Folder[] {
    return [...folders].sort((a, b) => {
      // Pinned folders always come first
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;

      // Within the same pinned state, use sortIndex if both have one
      const aIdx = a.sortIndex ?? -1;
      const bIdx = b.sortIndex ?? -1;
      if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;

      // Fall back to name-based sort
      return a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });
  }

  private sortConversations(conversations: ConversationReference[]): ConversationReference[] {
    return sortConversationsByPriority(conversations, this.conversationSortMode);
  }

  /**
   * Move a folder to a parent/position while preserving descendant structure.
   * Only the moved folder's parent/sibling order changes; the subtree beneath it stays intact.
   */
  private moveFolder(
    folderId: string,
    targetParentId: string | null,
    insertIndex?: number,
  ): boolean {
    const folder = this.data.folders.find((candidate) => candidate.id === folderId);
    if (!folder || folder.pinned) return false;

    if (folderId === targetParentId) return false;
    if (targetParentId && this.isFolderDescendant(targetParentId, folderId)) return false;

    const sourceParentId = folder.parentId;
    if (insertIndex == null && sourceParentId === targetParentId) return false;

    const pinned = !!folder.pinned;
    const originalSiblings = this.sortFolders(
      this.data.folders.filter(
        (candidate) =>
          candidate.parentId === sourceParentId &&
          candidate.id !== folderId &&
          !!candidate.pinned === pinned,
      ),
    );
    const targetSiblings = this.sortFolders(
      this.data.folders.filter(
        (candidate) =>
          candidate.parentId === targetParentId &&
          candidate.id !== folderId &&
          !!candidate.pinned === pinned,
      ),
    );

    let normalizedInsertIndex = insertIndex ?? targetSiblings.length;
    if (sourceParentId === targetParentId) {
      const originalIndex = this.sortFolders(
        this.data.folders.filter(
          (candidate) => candidate.parentId === sourceParentId && !!candidate.pinned === pinned,
        ),
      ).findIndex((candidate) => candidate.id === folderId);

      if (originalIndex >= 0 && originalIndex < normalizedInsertIndex) {
        normalizedInsertIndex -= 1;
      }
    }

    const clampedInsertIndex = Math.max(0, Math.min(normalizedInsertIndex, targetSiblings.length));
    const nextOrder = [...targetSiblings];
    nextOrder.splice(clampedInsertIndex, 0, folder);

    folder.parentId = targetParentId;
    folder.updatedAt = Date.now();

    nextOrder.forEach((sibling, index) => {
      sibling.sortIndex = index;
    });

    if (sourceParentId !== targetParentId) {
      originalSiblings.forEach((sibling, index) => {
        sibling.sortIndex = index;
      });
    }

    return true;
  }

  /**
   * Add reorder capability to a conversation element using top/bottom half detection.
   * When dragging over the top half, an indicator line appears above; bottom half 鈫?below.
   */
  private setupConversationReorderZone(
    convEl: HTMLElement,
    folderId: string,
    sortedIndex: number,
  ): void {
    convEl.addEventListener('dragover', (e) => {
      const data = e.dataTransfer?.types.includes('application/json');
      if (!data) return;

      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

      const rect = convEl.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const isTopHalf = e.clientY < midY;

      convEl.classList.remove('gv-reorder-above', 'gv-reorder-below');
      convEl.classList.add(isTopHalf ? 'gv-reorder-above' : 'gv-reorder-below');
    });

    convEl.addEventListener('dragleave', (e) => {
      // Only remove if truly leaving the element (not entering a child)
      const related = e.relatedTarget as Node | null;
      if (!related || !convEl.contains(related)) {
        convEl.classList.remove('gv-reorder-above', 'gv-reorder-below');
      }
    });

    convEl.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const isAbove = convEl.classList.contains('gv-reorder-above');
      convEl.classList.remove('gv-reorder-above', 'gv-reorder-below');

      const rawData = e.dataTransfer?.getData('application/json');
      if (!rawData) return;

      try {
        const dragData: DragData = JSON.parse(rawData);
        if (dragData.type !== 'conversation') return;

        // Restore opacity
        this.selectedConversations.forEach((id) => {
          const el = this.findConversationElement(id);
          if (el) el.style.opacity = '1';
        });

        const insertIndex = isAbove ? sortedIndex : sortedIndex + 1;
        const convs = dragData.conversations ?? [];
        const singleId = dragData.conversationId;
        const sourceFolderId = dragData.sourceFolderId;

        // If conversation(s) are from outside any folder (native sidebar drag),
        // add them to the folder data first so reorderOrMoveConversations can find them
        if (!sourceFolderId) {
          this.ensureConversationsInFolder(folderId, dragData);
        }

        const effectiveSource = sourceFolderId ?? folderId;

        if (convs.length > 0) {
          this.reorderOrMoveConversations(
            convs.map((c) => c.conversationId),
            effectiveSource,
            folderId,
            insertIndex,
          );
        } else if (singleId) {
          this.reorderOrMoveConversations([singleId], effectiveSource, folderId, insertIndex);
        }

        this.exitMultiSelectMode();
      } catch (error) {
        console.error('[FolderManager] Conversation reorder drop error:', error);
      }
    });
  }

  /**
   * Create a thin drop zone between items for drag-and-drop reordering.
   * When an item is dragged over the gap, it expands and shows a blue indicator line.
   * On drop, it reorders the item to the target position.
   */
  private createReorderGap(
    parentId: string,
    itemType: 'folder' | 'conversation',
    insertIndex: number,
  ): HTMLElement {
    const gap = document.createElement('div');
    gap.className = 'gv-reorder-gap';
    gap.dataset.parentId = parentId;
    gap.dataset.itemType = itemType;
    gap.dataset.insertIndex = insertIndex.toString();

    gap.addEventListener('dragover', (e) => {
      const data = e.dataTransfer?.types.includes('application/json');
      if (!data) return;

      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      gap.classList.add('gv-reorder-gap-active');
    });

    gap.addEventListener('dragleave', () => {
      gap.classList.remove('gv-reorder-gap-active');
    });

    gap.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      gap.classList.remove('gv-reorder-gap-active');

      const rawData = e.dataTransfer?.getData('application/json');
      if (!rawData) return;

      try {
        const dragData: DragData = JSON.parse(rawData);

        // Restore opacity for selected conversations
        this.selectedConversations.forEach((id) => {
          const el = this.findConversationElement(id);
          if (el) el.style.opacity = '1';
        });

        if (itemType === 'folder' && dragData.type === 'folder' && dragData.folderId) {
          this.reorderFolder(dragData.folderId, parentId, insertIndex);
        } else if (itemType === 'conversation' && dragData.type === 'conversation') {
          const convs = dragData.conversations ?? [];
          const singleId = dragData.conversationId;
          const sourceFolderId = dragData.sourceFolderId;

          // If from outside any folder, add to folder data first
          if (!sourceFolderId) {
            this.ensureConversationsInFolder(parentId, dragData);
          }

          const effectiveSource = sourceFolderId ?? parentId;

          if (convs.length > 0) {
            this.reorderOrMoveConversations(
              convs.map((c) => c.conversationId),
              effectiveSource,
              parentId,
              insertIndex,
            );
          } else if (singleId) {
            this.reorderOrMoveConversations([singleId], effectiveSource, parentId, insertIndex);
          }
        }

        this.exitMultiSelectMode();
      } catch (error) {
        console.error('[FolderManager] Reorder drop error:', error);
      }
    });

    return gap;
  }

  /**
   * Reorder a folder within its parent (or move to a new parent at a specific position).
   */
  private reorderFolder(folderId: string, targetParentId: string, insertIndex: number): void {
    const targetParent = targetParentId === '__root__' ? null : targetParentId;
    const moved = this.moveFolder(folderId, targetParent, insertIndex);
    if (!moved) return;
    this.saveData();
    this.refresh();
  }

  /** Import/move compatibility only. Old Gemini backups may contain these
   * fields; preserve them opaquely so a round trip is lossless, but never use
   * them to identify, route, title, or render a live ChatGPT conversation. */
  private copyLegacyImportedConversationMetadata(
    source: Pick<ConversationReference, 'isGem' | 'gemId'>,
  ): Pick<ConversationReference, 'isGem' | 'gemId'> {
    const metadata: Pick<ConversationReference, 'isGem' | 'gemId'> = {};
    if (source.isGem !== undefined) metadata.isGem = source.isGem;
    if (source.gemId !== undefined) metadata.gemId = source.gemId;
    return metadata;
  }

  /**
   * Silently add conversation(s) from dragData into a folder's data (no save/refresh).
   * Used before reorderOrMoveConversations so the conversations exist in the folder.
   */
  private ensureConversationsInFolder(folderId: string, dragData: DragData): void {
    if (!this.data.folderContents[folderId]) {
      this.data.folderContents[folderId] = [];
    }

    const convs = dragData.conversations ?? [];
    const items: {
      id: string;
      title: string;
      url?: string;
      legacyMetadata: Pick<ConversationReference, 'isGem' | 'gemId'>;
    }[] =
      convs.length > 0
        ? convs.map((c) => ({
            id: c.conversationId,
            title: c.title,
            url: c.url,
            legacyMetadata: this.copyLegacyImportedConversationMetadata(c),
          }))
        : dragData.conversationId
          ? [
              {
                id: dragData.conversationId,
                title: dragData.title,
                url: dragData.url,
                legacyMetadata: this.copyLegacyImportedConversationMetadata(dragData),
              },
            ]
          : [];

    let maxSortIndex = this.data.folderContents[folderId].reduce(
      (max, c) => Math.max(max, c.sortIndex ?? -1),
      -1,
    );

    for (const item of items) {
      const exists = this.data.folderContents[folderId].some((c) => c.conversationId === item.id);
      if (exists) continue;

      this.data.folderContents[folderId].push({
        conversationId: item.id,
        title: this.resolveConversationTitle(item.id, item.title),
        url: item.url ?? '',
        addedAt: Date.now(),
        ...item.legacyMetadata,
        sortIndex: ++maxSortIndex,
      });
    }
  }

  /**
   * Reorder conversations within a folder, or move from one folder to another at a specific position.
   */
  private reorderOrMoveConversations(
    conversationIds: string[],
    sourceParentId: string,
    targetParentId: string,
    insertIndex: number,
  ): void {
    if (!this.data.folderContents[targetParentId]) {
      this.data.folderContents[targetParentId] = [];
    }

    const movingConvs: ConversationReference[] = [];

    // Deduplicate conversation IDs to prevent duplicates from cross-folder selection
    const uniqueIds = [...new Set(conversationIds)];

    // Collect conversation references
    for (const convId of uniqueIds) {
      const sourceList = this.data.folderContents[sourceParentId];
      if (!sourceList) continue;
      const conv = sourceList.find((c) => c.conversationId === convId);
      if (conv) movingConvs.push(conv);
    }

    if (movingConvs.length === 0) return;

    // When reordering within the same folder, insertIndex is based on the original
    // sorted list (which includes the dragged items). After removal, indices shift.
    // Adjust by subtracting the count of dragged items that were before insertIndex.
    if (sourceParentId === targetParentId) {
      const isStarredGroup = movingConvs[0].starred ?? false;
      const originalSorted = this.sortConversations(
        (this.data.folderContents[targetParentId] ?? []).filter(
          (c) => !!c.starred === isStarredGroup,
        ),
      );
      let adjustment = 0;
      for (const convId of conversationIds) {
        const origIdx = originalSorted.findIndex((c) => c.conversationId === convId);
        if (origIdx >= 0 && origIdx < insertIndex) {
          adjustment++;
        }
      }
      insertIndex -= adjustment;
    }

    // Remove from source
    if (this.data.folderContents[sourceParentId]) {
      const removeSet = new Set(conversationIds);
      this.data.folderContents[sourceParentId] = this.data.folderContents[sourceParentId].filter(
        (c) => !removeSet.has(c.conversationId),
      );
      // Reassign sortIndex in source if it changed
      if (sourceParentId !== targetParentId) {
        const sourceConvs = this.sortConversations(this.data.folderContents[sourceParentId]);
        sourceConvs.forEach((c, i) => {
          c.sortIndex = i;
        });
      }
    }

    // Get target starred group info for proper insertion
    const isStarred = movingConvs[0].starred ?? false;
    const targetList = this.data.folderContents[targetParentId].filter(
      (c) => !conversationIds.includes(c.conversationId),
    );
    this.data.folderContents[targetParentId] = targetList;

    // Get sorted siblings in the same starred group (dragged items already excluded)
    const sameGroupSiblings = this.sortConversations(
      targetList.filter((c) => !!c.starred === isStarred),
    );
    const otherGroup = targetList.filter((c) => !!c.starred !== isStarred);

    // Clamp insertIndex to valid range after removal
    const clampedIndex = Math.min(insertIndex, sameGroupSiblings.length);

    // Insert at position
    sameGroupSiblings.splice(clampedIndex, 0, ...movingConvs);

    // Reassign sortIndex
    sameGroupSiblings.forEach((c, i) => {
      c.sortIndex = i;
    });
    otherGroup.forEach((c, i) => {
      if (c.sortIndex == null) c.sortIndex = i;
    });

    // Recombine
    this.data.folderContents[targetParentId] = [...sameGroupSiblings, ...otherGroup];

    this.saveData();
    this.refresh();
  }

  private addConversationToFolder(
    folderId: string,
    dragData: DragData & { sourceFolderId?: string },
  ): void {
    this.debug('Adding conversation to folder:', {
      folderId,
      dragData,
    });

    if (!this.data.folderContents[folderId]) {
      this.data.folderContents[folderId] = [];
    }

    // Check if conversation is already in this folder
    const exists = this.data.folderContents[folderId].some(
      (c) => c.conversationId === dragData.conversationId,
    );

    if (exists) {
      this.debug('Conversation already in folder:', dragData.conversationId);
      this.debug('Existing conversations:', this.data.folderContents[folderId]);
      return;
    }

    const maxSortIndex = this.data.folderContents[folderId].reduce(
      (max, c) => Math.max(max, c.sortIndex ?? -1),
      -1,
    );
    const conv: ConversationReference = {
      conversationId: dragData.conversationId!,
      title: this.resolveConversationTitle(dragData.conversationId!, dragData.title),
      url: dragData.url!,
      addedAt: Date.now(),
      ...this.copyLegacyImportedConversationMetadata(dragData),
      sortIndex: maxSortIndex + 1,
    };

    this.data.folderContents[folderId].push(conv);
    this.debug('Conversation added. Total in folder:', this.data.folderContents[folderId].length);

    // If this was dragged from another folder, remove it from the source
    if (dragData.sourceFolderId && dragData.sourceFolderId !== folderId) {
      this.debug('Moving from folder:', dragData.sourceFolderId);
      this.removeConversationFromFolder(dragData.sourceFolderId, dragData.conversationId!);
      // Note: removeConversationFromFolder calls saveData() and refresh(), so we don't need to call them again
      // Folder→folder move is not a "first archive"; skip the nudge.
      return;
    }

    // Save immediately before refresh to persist data
    this.saveData();
    this.refresh();
    this.maybeShowHideArchivedNudge();
  }

  // Batch add conversations to folder (for multi-select support)
  private addConversationsToFolder(
    folderId: string,
    conversations: ConversationReference[],
    sourceFolderId?: string,
  ): void {
    this.debug('Adding multiple conversations to folder:', {
      folderId,
      count: conversations.length,
      sourceFolderId,
    });

    if (!this.data.folderContents[folderId]) {
      this.data.folderContents[folderId] = [];
    }

    let addedCount = 0;
    const conversationsToRemove: string[] = [];
    let maxSortIndex = this.data.folderContents[folderId].reduce(
      (max, c) => Math.max(max, c.sortIndex ?? -1),
      -1,
    );

    conversations.forEach((conv) => {
      // Check if conversation is already in this folder
      const exists = this.data.folderContents[folderId].some(
        (c) => c.conversationId === conv.conversationId,
      );

      if (!exists) {
        maxSortIndex++;
        // Create a copy with updated timestamp
        const newConv: ConversationReference = {
          ...conv,
          title: this.resolveConversationTitle(conv.conversationId, conv.title),
          addedAt: Date.now(),
          sortIndex: maxSortIndex,
        };

        this.data.folderContents[folderId].push(newConv);
        addedCount++;

        // Track conversations to remove from source folder
        if (sourceFolderId && sourceFolderId !== folderId) {
          conversationsToRemove.push(conv.conversationId);
        }
      }
    });

    this.debug(
      `Added ${addedCount} conversations. Total in folder:`,
      this.data.folderContents[folderId].length,
    );

    // Remove from source folder if moving
    if (sourceFolderId && sourceFolderId !== folderId && conversationsToRemove.length > 0) {
      this.debug('Removing conversations from source folder:', sourceFolderId);
      conversationsToRemove.forEach((convId) => {
        this.data.folderContents[sourceFolderId] = this.data.folderContents[sourceFolderId].filter(
          (c) => c.conversationId !== convId,
        );
      });
    }

    // Save immediately before refresh to persist data
    this.saveData();
    this.refresh();
    // Trigger nudge only if at least one conversation was actually added from
    // outside. If the whole batch came from another folder (sourceFolderId set),
    // it's a folder→folder move and not a "first archive" event.
    if (addedCount > 0 && !sourceFolderId) {
      this.maybeShowHideArchivedNudge();
    }
  }

  private addFolderToFolder(targetFolderId: string, dragData: DragData): void {
    const draggedFolderId = dragData.folderId;
    if (!draggedFolderId) return;

    this.debug('Moving folder to folder:', {
      draggedFolderId,
      targetFolderId,
    });

    const moved = this.moveFolder(draggedFolderId, targetFolderId);
    if (!moved) {
      this.debug('Folder move rejected');
      return;
    }
    this.saveData();
    this.refresh();
  }

  private moveFolderToRoot(dragData: DragData): void {
    const draggedFolderId = dragData.folderId;
    if (!draggedFolderId) return;

    this.debug('Moving folder to root level:', draggedFolderId);

    const moved = this.moveFolder(draggedFolderId, null);
    if (!moved) {
      this.debug('Folder move to root rejected');
      return;
    }
    this.saveData();
    this.refresh();
  }

  private isFolderDescendant(folderId: string, potentialAncestorId: string): boolean {
    // Check if potentialAncestorId is an ancestor of folderId
    let currentId: string | null = folderId;
    while (currentId) {
      if (currentId === potentialAncestorId) {
        return true;
      }
      const folder = this.data.folders.find((f) => f.id === currentId);
      currentId = folder?.parentId || null;
    }
    return false;
  }

  /**
   * Distance from a folder to the root 鈥?0 for a top-level folder, 1 for a
   * subfolder, etc. Returns 0 for unknown ids so callers can treat "not found"
   * the same as "at root" for gating purposes (they'll also fail their own
   * existence check before mutating).
   */
  private getFolderDepth(folderId: string): number {
    let depth = 0;
    let current = this.data.folders.find((f) => f.id === folderId);
    while (current?.parentId) {
      depth += 1;
      current = this.data.folders.find((f) => f.id === current?.parentId);
    }
    return depth;
  }

  private toggleConversationStar(folderId: string, conversationId: string): void {
    const conversations = this.data.folderContents[folderId];
    if (!conversations) return;

    const conv = conversations.find((c) => c.conversationId === conversationId);
    if (!conv) return;

    // Toggle starred state
    conv.starred = !conv.starred;

    // Save data
    this.saveData();

    // Refresh the folder UI to update the star icon and re-sort
    this.refresh();

    this.debug('Toggled star for conversation:', conversationId, 'starred:', conv.starred);
  }

  private confirmRemoveConversation(
    folderId: string,
    conversationId: string,
    title: string,
    event: MouseEvent,
  ): void {
    // Create inline confirmation dialog using safe DOM API
    const confirmDialog = document.createElement('div');
    confirmDialog.className = 'gv-folder-confirm-dialog';

    // Create message element safely with user-provided title
    const message = document.createElement('div');
    message.className = 'gv-folder-confirm-message';
    // Safe: textContent prevents XSS even with user-controlled title
    message.textContent = this.t('folder_remove_conversation_confirm').replace('{title}', title);

    // Create actions container
    const actions = document.createElement('div');
    actions.className = 'gv-folder-confirm-actions';

    // Create buttons safely
    const yesBtn = document.createElement('button');
    yesBtn.className = 'gv-folder-confirm-btn gv-folder-confirm-yes';
    yesBtn.textContent = this.t('pm_delete'); // Safe: uses textContent

    const noBtn = document.createElement('button');
    noBtn.className = 'gv-folder-confirm-btn gv-folder-confirm-no';
    noBtn.textContent = this.t('pm_cancel'); // Safe: uses textContent

    // Assemble the dialog
    actions.appendChild(yesBtn);
    actions.appendChild(noBtn);
    confirmDialog.appendChild(message);
    confirmDialog.appendChild(actions);

    // Position near the clicked element
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    confirmDialog.style.position = 'fixed';
    confirmDialog.style.top = `${rect.bottom + 4}px`;
    confirmDialog.style.left = `${Math.min(rect.left, window.innerWidth - 280)}px`;

    document.body.appendChild(confirmDialog);

    // Cleanup function
    const cleanup = () => {
      confirmDialog.remove();
    };

    yesBtn?.addEventListener('click', () => {
      this.removeConversationFromFolder(folderId, conversationId);
      cleanup();
    });

    noBtn?.addEventListener('click', cleanup);

    // Close on click outside
    setTimeout(() => {
      const closeOnOutside = (e: MouseEvent) => {
        if (!confirmDialog.contains(e.target as Node)) {
          cleanup();
          document.removeEventListener('click', closeOnOutside);
        }
      };
      document.addEventListener('click', closeOnOutside);
    }, 0);
  }

  private removeConversationFromFolder(folderId: string, conversationId: string): void {
    if (!this.data.folderContents[folderId]) return;

    this.data.folderContents[folderId] = this.data.folderContents[folderId].filter(
      (c) => c.conversationId !== conversationId,
    );

    this.saveData();
    this.refresh();
  }

  private batchDeleteConversations(): void {
    if (!this.multiSelectFolderId || this.selectedConversations.size === 0) return;

    const count = this.selectedConversations.size;
    const confirmed = confirm(
      this.t('batch_remove_from_folder_confirm').replace('{count}', String(count)),
    );

    if (!confirmed) return;

    // Remove all selected conversations from the folder
    const folderId = this.multiSelectFolderId;
    if (!this.data.folderContents[folderId]) return;

    this.data.folderContents[folderId] = this.data.folderContents[folderId].filter(
      (c) => !this.selectedConversations.has(c.conversationId),
    );

    this.saveData();

    // Exit multi-select mode and refresh
    this.exitMultiSelectMode();
    this.refresh();

    this.debug(`Batch deleted ${count} conversations from folder ${folderId}`);
  }

  /**
   * Batch delete native ChatGPT conversations by simulating user clicks
   * This triggers the actual deletion on ChatGPT's servers
   */
  private async batchDeleteNativeConversations(): Promise<void> {
    if (this.batchDeleteInProgress) {
      this.debug('Batch delete already in progress');
      return;
    }

    const count = this.selectedConversations.size;
    if (count === 0) return;

    // Show confirmation dialog
    const confirmMessage = this.t('batch_delete_confirm').replace('{count}', String(count));
    const confirmed = confirm(confirmMessage);
    if (!confirmed) return;

    this.batchDeleteInProgress = true;
    const conversationIds = Array.from(this.selectedConversations);
    let successCount = 0;
    let failedCount = 0;

    try {
      this.showBatchDeleteProgress(0, count);

      for (let index = 0; index < conversationIds.length; index += 1) {
        const conversationId = conversationIds[index];
        this.updateBatchDeleteProgress(index + 1, count);

        const success = await this.triggerNativeDeleteForConversation(conversationId);
        if (!success) {
          // Deletion is destructive. Stop at the first uncertain or failed target;
          // never replay the click sequence automatically.
          failedCount = 1;
          this.debugWarn(`Batch delete stopped at conversation: ${conversationId}`);
          break;
        }

        successCount += 1;
        this.selectedConversations.delete(conversationId);
        this.selectedConversationData.delete(conversationId);
        await this.removeConversationFromAllFolders(conversationId);
      }

      if (failedCount === 0) {
        const successMessage = this.t('batch_delete_success').replace(
          '{count}',
          String(successCount),
        );
        this.showNotification(successMessage, 'success');
        this.exitMultiSelectMode();
      } else {
        const partialMessage = this.t('batch_delete_partial')
          .replace('{success}', String(successCount))
          .replace('{failed}', String(count - successCount));
        this.showNotification(partialMessage, 'info');
        // Keep only the failed/unprocessed targets selected so a successful
        // destructive action cannot be triggered a second time accidentally.
        this.updateConversationSelectionUI();
      }
    } catch (error) {
      console.error('[FolderManager] Batch delete stopped after an unexpected error:', error);
      const partialMessage = this.t('batch_delete_partial')
        .replace('{success}', String(successCount))
        .replace('{failed}', String(count - successCount));
      this.showNotification(partialMessage, 'info');
      this.updateConversationSelectionUI();
    } finally {
      this.hideBatchDeleteProgress();
      this.batchDeleteInProgress = false;
    }
  }

  /**
   * Trigger native delete for a single conversation by simulating UI interactions
   */
  private async triggerNativeDeleteForConversation(conversationId: string): Promise<boolean> {
    let ownedMenu: HTMLElement | null = null;
    let ownedDialog: HTMLElement | null = null;
    let removalWatch: NativeRemovalWatch | null = null;
    let confirmClicked = false;

    try {
      const conversationEl = this.findNativeConversationElement(conversationId);
      if (!conversationEl) {
        this.debugWarn(`Could not find conversation element for: ${conversationId}`);
        return false;
      }

      const resolvedId = normalizeChatGptConversationId(getChatGptConversationId(conversationEl));
      const expectedId = normalizeChatGptConversationId(conversationId);
      const expectedTitle = getChatGptConversationTitle(conversationEl)?.trim() || '';
      if (!expectedId || resolvedId !== expectedId || !expectedTitle) {
        this.debugWarn('Refusing native delete because target verification failed', {
          expectedId,
          resolvedId,
          expectedTitle,
        });
        return false;
      }

      const moreButton = findConversationOptionsButton(conversationEl);
      if (!moreButton) {
        this.debugWarn(`Could not find more button for: ${conversationId}`);
        return false;
      }

      const triggerContext = resolveSidebarConversationContext(moreButton);
      if (normalizeChatGptConversationId(triggerContext?.id) !== expectedId) {
        this.debugWarn('Refusing native delete because the options trigger identity changed');
        return false;
      }

      const menuPromise = this.startOwnedNativeMenuWatch(moreButton, expectedId);
      this.suppressedConversationMenuTrigger = moreButton;
      try {
        moreButton.click();
      } finally {
        this.suppressedConversationMenuTrigger = null;
      }

      ownedMenu = await menuPromise;
      if (!ownedMenu) {
        this.debugWarn(`Owned conversation menu did not appear for: ${conversationId}`);
        return false;
      }
      if (
        !isElementOpen(ownedMenu) ||
        !isNativeConversationMenuBoundToTrigger(ownedMenu, moreButton) ||
        normalizeChatGptConversationId(resolveSidebarConversationContext(moreButton)?.id) !==
          expectedId
      ) {
        this.debugWarn('Refusing native delete because menu ownership changed before use');
        return false;
      }

      const deleteItem = findDeleteConversationMenuItem(ownedMenu);
      if (!deleteItem) {
        this.debugWarn(`Could not click delete button for: ${conversationId}`);
        return false;
      }

      const existingDialogs = new Set(getNativeDeleteDialogs(document));
      const dialogPromise = this.startOwnedNativeDialogWatch(
        deleteItem,
        expectedId,
        existingDialogs,
      );
      deleteItem.click();
      ownedDialog = await dialogPromise;

      if (!ownedDialog || !isOwnedNativeDeleteDialog(ownedDialog, existingDialogs, expectedTitle)) {
        this.debugWarn('Refusing native delete because the confirmation target did not match', {
          conversationId,
          expectedTitle,
        });
        return false;
      }

      const confirmButton = findDeleteConversationConfirmButton(ownedDialog);
      if (!confirmButton) {
        this.debugWarn(`Delete confirmation button unavailable for: ${conversationId}`);
        return false;
      }

      removalWatch = this.startNativeRemovalWatch(conversationEl, expectedId);
      if (!removalWatch) {
        this.debugWarn(`Could not establish attributable removal evidence for: ${conversationId}`);
        return false;
      }

      // From this point onward a destructive side effect may have occurred.
      // Never close/reopen/replay the dialog or compensate automatically.
      confirmClicked = true;
      confirmButton.click();

      const removed = await this.waitForVerifiedNativeRemoval(removalWatch, ownedDialog);
      if (!removed) {
        this.debugWarn(
          `Deletion state is uncertain for ${conversationId}; stopping without an automatic retry`,
        );
        return false;
      }

      return true;
    } catch (error) {
      console.error(`[FolderManager] Error in triggerNativeDeleteForConversation:`, error);
      return false;
    } finally {
      this.cancelNativeMenuWatch();
      this.cancelNativeDialogWatch();
      if (removalWatch) this.cleanupNativeRemovalWatch(removalWatch);

      if (!confirmClicked) {
        if (ownedDialog) closeNativeDeleteDialog(ownedDialog);
        if (ownedMenu) closeNativeConversationMenu(ownedMenu);
      }
    }
  }

  /**
   * Find native conversation element by conversation ID
   */
  private findNativeConversationElement(conversationId: string): HTMLElement | null {
    const expectedId = normalizeChatGptConversationId(conversationId);
    if (!expectedId) return null;

    const root = this.sidebarContainer ?? document;
    return (
      getChatGptConversationElements(root).find(
        (conversation) =>
          normalizeChatGptConversationId(getChatGptConversationId(conversation)) === expectedId,
      ) ?? null
    );
  }

  private createNativeOwnershipToken(prefix: string): string {
    const randomPart =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${randomPart}`;
  }

  private startOwnedNativeMenuWatch(
    trigger: HTMLElement,
    expectedId: string,
  ): Promise<HTMLElement | null> {
    this.cancelNativeMenuWatch();
    const snapshot = createNativeMenuOwnershipSnapshot(
      trigger,
      expectedId,
      this.createNativeOwnershipToken('menu'),
      document,
    );
    if (!snapshot) return Promise.resolve(null);

    return new Promise((resolve) => {
      const candidates = new Set<HTMLElement>();
      let settled = false;
      let watch: PendingNativeMenuWatch;

      const finish = (menu: HTMLElement | null): void => {
        if (settled) return;
        settled = true;
        this.nativeMenuObserver?.disconnect();
        this.nativeMenuObserver = null;
        window.clearTimeout(watch.timeoutId);
        clearNativeMenuOwnership(snapshot);
        if (this.pendingNativeMenuWatch === watch) this.pendingNativeMenuWatch = null;
        resolve(menu);
      };

      const inspectCandidates = (): void => {
        for (const candidate of candidates) {
          if (isOwnedNativeConversationMenu(candidate, snapshot)) {
            finish(candidate);
            return;
          }
        }
      };

      this.nativeMenuObserver = new MutationObserver((mutations) => {
        if (this.isDestroyed) {
          finish(null);
          return;
        }

        for (const mutation of mutations) {
          mutation.addedNodes.forEach((node) => {
            findNativeConversationMenusInNode(node).forEach((menu) => candidates.add(menu));
          });
        }
        inspectCandidates();
      });

      watch = {
        snapshot,
        candidates,
        timeoutId: window.setTimeout(() => finish(null), this.BATCH_DELETE_CONFIG.MENU_WAIT_TIME),
        finish,
      };
      this.pendingNativeMenuWatch = watch;
      this.nativeMenuObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'aria-controls',
          'aria-expanded',
          'aria-labelledby',
          'aria-hidden',
          'data-state',
          'style',
          'hidden',
        ],
      });

      // Radix opens the menu on pointerdown — before the click that arms this
      // watch — so the menu is often already mounted and no further mutation is
      // coming. Seed with what is on screen and inspect once, otherwise we just
      // wait out the timeout. Ownership is verified the same way either path.
      getNativeConversationMenus(document).forEach((menu) => candidates.add(menu));
      inspectCandidates();
    });
  }

  private cancelNativeMenuWatch(): void {
    if (this.pendingNativeMenuWatch) {
      this.pendingNativeMenuWatch.finish(null);
      return;
    }
    this.nativeMenuObserver?.disconnect();
    this.nativeMenuObserver = null;
  }

  private startOwnedNativeDialogWatch(
    deleteItem: HTMLElement,
    expectedId: string,
    existingDialogs: ReadonlySet<HTMLElement>,
  ): Promise<HTMLElement | null> {
    this.cancelNativeDialogWatch();
    const token = this.createNativeOwnershipToken('dialog');
    deleteItem.setAttribute('data-gv-native-delete-token', token);
    deleteItem.setAttribute('data-gv-native-delete-expected-id', expectedId);

    return new Promise((resolve) => {
      const candidates = new Set<HTMLElement>();
      let settled = false;
      let watch: PendingNativeDialogWatch;

      const finish = (dialog: HTMLElement | null): void => {
        if (settled) return;
        settled = true;
        this.nativeDialogObserver?.disconnect();
        this.nativeDialogObserver = null;
        window.clearTimeout(watch.timeoutId);
        if (deleteItem.getAttribute('data-gv-native-delete-token') === token) {
          deleteItem.removeAttribute('data-gv-native-delete-token');
          deleteItem.removeAttribute('data-gv-native-delete-expected-id');
        }
        if (this.pendingNativeDialogWatch === watch) this.pendingNativeDialogWatch = null;
        resolve(dialog);
      };

      const inspectCandidates = (): void => {
        if (
          deleteItem.getAttribute('data-gv-native-delete-token') !== token ||
          deleteItem.getAttribute('data-gv-native-delete-expected-id') !== expectedId
        ) {
          finish(null);
          return;
        }

        for (const candidate of candidates) {
          if (!existingDialogs.has(candidate) && isElementOpen(candidate)) {
            finish(candidate);
            return;
          }
        }
      };

      this.nativeDialogObserver = new MutationObserver((mutations) => {
        if (this.isDestroyed) {
          finish(null);
          return;
        }
        for (const mutation of mutations) {
          mutation.addedNodes.forEach((node) => {
            findNativeDeleteDialogsInNode(node).forEach((dialog) => candidates.add(dialog));
          });
        }
        inspectCandidates();
      });

      watch = {
        deleteItem,
        token,
        expectedId,
        existingDialogs,
        timeoutId: window.setTimeout(() => finish(null), this.BATCH_DELETE_CONFIG.DIALOG_WAIT_TIME),
        finish,
      };
      this.pendingNativeDialogWatch = watch;
      this.nativeDialogObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-hidden', 'data-state', 'style', 'hidden'],
      });
    });
  }

  private cancelNativeDialogWatch(): void {
    if (this.pendingNativeDialogWatch) {
      this.pendingNativeDialogWatch.finish(null);
      return;
    }
    this.nativeDialogObserver?.disconnect();
    this.nativeDialogObserver = null;
  }

  private findNativeHistoryScrollContainer(
    targetRow: HTMLElement,
    sidebarContainer: HTMLElement,
  ): HTMLElement {
    let current: HTMLElement | null = targetRow.parentElement;
    while (current) {
      const style = window.getComputedStyle(current);
      if (
        current.scrollHeight > current.clientHeight ||
        style.overflowY === 'auto' ||
        style.overflowY === 'scroll'
      ) {
        return current;
      }
      if (current === sidebarContainer) break;
      current = current.parentElement;
    }
    return sidebarContainer;
  }

  private startNativeRemovalWatch(
    targetRow: HTMLElement,
    expectedId: string,
  ): NativeRemovalWatch | null {
    this.cleanupNativeRemovalWatch();
    const sidebarContainer = this.sidebarContainer;
    if (!sidebarContainer?.isConnected || !sidebarContainer.contains(targetRow)) return null;
    if (
      normalizeChatGptConversationId(getChatGptConversationId(targetRow)) !== expectedId ||
      getChatGptConversationElements(sidebarContainer).filter(
        (row) => normalizeChatGptConversationId(getChatGptConversationId(row)) === expectedId,
      ).length !== 1
    ) {
      return null;
    }

    const historyContainer =
      this.recentSection?.isConnected && this.recentSection.contains(targetRow)
        ? this.recentSection
        : sidebarContainer;
    if (!historyContainer.isConnected || !historyContainer.contains(targetRow)) return null;

    const scrollContainer = this.findNativeHistoryScrollContainer(targetRow, sidebarContainer);
    let watch: NativeRemovalWatch;
    const scrollListener = (): void => {
      watch.scrollChanged = true;
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        let recordConversationRemovals = 0;
        let containsTarget = false;

        mutation.removedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          const removedLinks =
            (node.matches('a[href*="/c/"]') ? 1 : 0) +
            node.querySelectorAll('a[href*="/c/"]').length;
          recordConversationRemovals += removedLinks;
          if (node === targetRow || node.contains(targetRow)) containsTarget = true;
        });

        if (containsTarget) {
          if (recordConversationRemovals === 1) watch.rowRemovalObserved = true;
          else watch.ambiguousRemoval = true;
        }

        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          const links = [
            ...(node.matches('a[href*="/c/"]') ? [node as HTMLAnchorElement] : []),
            ...Array.from(node.querySelectorAll<HTMLAnchorElement>('a[href*="/c/"]')),
          ];
          if (
            links.some(
              (link) =>
                normalizeChatGptConversationId(
                  extractChatGptConversationIdFromUrl(link.getAttribute('href')),
                ) === expectedId,
            )
          ) {
            watch.ambiguousRemoval = true;
          }
        });
      }
    });

    watch = {
      targetRow,
      expectedId,
      historyContainer,
      historyParent: historyContainer.parentNode,
      sidebarContainer,
      scrollContainer,
      initialScrollTop: scrollContainer.scrollTop,
      initialScrollLeft: scrollContainer.scrollLeft,
      rowRemovalObserved: false,
      ambiguousRemoval: false,
      scrollChanged: false,
      observer,
      scrollListener,
    };
    observer.observe(historyContainer, { childList: true, subtree: true });
    scrollContainer.addEventListener('scroll', scrollListener, { passive: true });
    this.activeNativeRemovalWatch = watch;
    return watch;
  }

  private async waitForVerifiedNativeRemoval(
    watch: NativeRemovalWatch,
    dialog: HTMLElement,
  ): Promise<boolean> {
    const deadline = Date.now() + this.BATCH_DELETE_CONFIG.REMOVAL_WAIT_TIME;
    do {
      if (this.isDestroyed || watch.ambiguousRemoval || watch.scrollChanged) return false;
      if (
        !watch.sidebarContainer.isConnected ||
        !watch.historyContainer.isConnected ||
        watch.historyContainer.parentNode !== watch.historyParent ||
        !watch.sidebarContainer.contains(watch.historyContainer) ||
        !watch.scrollContainer.isConnected ||
        watch.scrollContainer.scrollTop !== watch.initialScrollTop ||
        watch.scrollContainer.scrollLeft !== watch.initialScrollLeft
      ) {
        return false;
      }

      if (watch.rowRemovalObserved && !watch.targetRow.isConnected && !isElementOpen(dialog)) {
        return true;
      }
      await this.delay(this.BATCH_DELETE_CONFIG.CHECK_INTERVAL);
    } while (Date.now() < deadline);
    return false;
  }

  private cleanupNativeRemovalWatch(watch = this.activeNativeRemovalWatch): void {
    if (!watch) return;
    watch.observer.disconnect();
    watch.scrollContainer.removeEventListener('scroll', watch.scrollListener);
    if (this.activeNativeRemovalWatch === watch) this.activeNativeRemovalWatch = null;
  }

  /**
   * Show batch delete progress indicator
   */
  private showBatchDeleteProgress(current: number, total: number): void {
    // Remove existing progress element if any
    this.hideBatchDeleteProgress();

    const progress = document.createElement('div');
    progress.className = 'gv-batch-delete-progress';
    progress.setAttribute('role', 'status');
    progress.setAttribute('aria-live', 'polite');
    progress.setAttribute('aria-atomic', 'true');
    progress.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: rgba(32, 33, 36, 0.95);
      color: #e8eaed;
      padding: 16px 24px;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 12px;
      font-family: 'Google Sans', Roboto, Arial, sans-serif;
      font-size: 14px;
    `;

    const spinner = document.createElement('div');
    spinner.setAttribute('aria-hidden', 'true');
    spinner.style.cssText = `
      width: 20px;
      height: 20px;
      border: 2px solid #8ab4f8;
      border-top-color: transparent;
      border-radius: 50%;
      animation: gv-spin 1s linear infinite;
    `;

    // Add spinner animation if not already present
    if (!document.querySelector('#gv-batch-delete-styles')) {
      const style = document.createElement('style');
      style.id = 'gv-batch-delete-styles';
      style.textContent = `
        @keyframes gv-spin {
          to { transform: rotate(360deg); }
        }
      `;
      document.head.appendChild(style);
    }

    const text = document.createElement('span');
    text.className = 'gv-batch-delete-progress-text';
    text.textContent = this.t('batch_delete_in_progress')
      .replace('{current}', String(current))
      .replace('{total}', String(total));

    progress.appendChild(spinner);
    progress.appendChild(text);
    document.body.appendChild(progress);

    this.batchDeleteProgressElement = progress;
  }

  /**
   * Update batch delete progress indicator
   */
  private updateBatchDeleteProgress(current: number, total: number): void {
    if (this.batchDeleteProgressElement) {
      const textEl = this.batchDeleteProgressElement.querySelector(
        '.gv-batch-delete-progress-text',
      );
      if (textEl) {
        textEl.textContent = this.t('batch_delete_in_progress')
          .replace('{current}', String(current))
          .replace('{total}', String(total));
      }
    }
  }

  /**
   * Hide batch delete progress indicator
   */
  private hideBatchDeleteProgress(): void {
    if (this.batchDeleteProgressElement) {
      this.batchDeleteProgressElement.remove();
      this.batchDeleteProgressElement = null;
    }
  }

  /**
   * Helper function to create a delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Multi-select helper methods
  private clearSelection(): void {
    this.selectedConversations.clear();
    this.selectedConversationData.clear();
  }

  private selectConversation(conversationId: string, snapshot?: ConversationReference): void {
    this.selectedConversations.add(conversationId);
    if (snapshot) this.selectedConversationData.set(conversationId, snapshot);
  }

  private toggleConversationSelection(
    conversationId: string,
    snapshot?: ConversationReference,
  ): void {
    if (this.selectedConversations.has(conversationId)) {
      this.selectedConversations.delete(conversationId);
      this.selectedConversationData.delete(conversationId);

      // Auto-exit multi-select mode when all selections are cleared
      if (this.selectedConversations.size === 0 && this.isMultiSelectMode) {
        this.exitMultiSelectMode();
        return;
      }
    } else {
      // Check if we've reached the maximum selection limit
      if (this.selectedConversations.size >= this.MAX_BATCH_DELETE_COUNT) {
        const message = this.t('batch_delete_limit_reached').replace(
          '{max}',
          String(this.MAX_BATCH_DELETE_COUNT),
        );
        this.showNotification(message, 'info');
        return;
      }
      this.selectedConversations.add(conversationId);
      if (snapshot) this.selectedConversationData.set(conversationId, snapshot);
    }
  }

  /**
   * Build a `ConversationReference` snapshot from a native sidebar
   * conversation element. Called at selection time so the multi-select
   * drag can survive ChatGPT's sidebar DOM virtualisation — once captured,
   * we don't need the element back in the DOM to drop the conversation
   * into a folder.
   */
  private captureNativeConversationSnapshot(element: HTMLElement): ConversationReference | null {
    const conversationId = this.extractConversationId(element);
    if (!conversationId) return null;
    const title = this.extractConversationTitleForDrag(element);
    const data = this.extractConversationData(element);
    return {
      conversationId,
      title,
      url: data.url,
      addedAt: Date.now(),
    };
  }

  private updateConversationSelectionUI(): void {
    // Only update UI for the source where multi-select was initiated
    if (this.multiSelectSource === 'folder') {
      // Only update folder conversation elements
      const allConvEls = this.containerElement?.querySelectorAll('.gv-folder-conversation');
      allConvEls?.forEach((el) => {
        const convId = (el as HTMLElement).dataset.conversationId;
        const elFolderId = (el as HTMLElement).dataset.folderId;

        // Only update conversations in the same folder where multi-select started
        if (convId && (!this.multiSelectFolderId || elFolderId === this.multiSelectFolderId)) {
          if (this.selectedConversations.has(convId)) {
            el.classList.add('gv-folder-conversation-selected');
          } else {
            el.classList.remove('gv-folder-conversation-selected');
          }
        }
      });
    } else if (this.multiSelectSource === 'native') {
      const nativeConversations = this.sidebarContainer
        ? getChatGptConversationElements(this.sidebarContainer)
        : [];
      nativeConversations.forEach((element) => {
        const convId = getChatGptConversationId(element);
        if (convId) {
          if (this.selectedConversations.has(convId)) {
            element.classList.add('gv-conversation-selected');
          } else {
            element.classList.remove('gv-conversation-selected');
          }
        }
      });
    }

    // Update the selection count
    this.updateMultiSelectModeUI();
  }

  private enterMultiSelectMode(
    initialConversationId?: string,
    source: 'folder' | 'native' = 'native',
    folderId?: string,
  ): void {
    this.debug('Entering multi-select mode', { source, folderId });
    this.isMultiSelectMode = true;
    this.multiSelectSource = source;
    this.multiSelectFolderId = folderId || null;

    // Select the conversation that triggered the long-press
    if (initialConversationId) {
      this.selectConversation(initialConversationId);
    }

    this.updateMultiSelectModeUI();
    this.updateConversationSelectionUI();

    // Add visual feedback (vibration on mobile)
    if ('vibrate' in navigator) {
      navigator.vibrate(50);
    }

    // Add click-outside listener to exit multi-select mode
    this.setupOutsideClickHandler();
  }

  private exitMultiSelectMode(): void {
    this.debug('Exiting multi-select mode');
    this.isMultiSelectMode = false;
    this.multiSelectSource = null;
    this.multiSelectFolderId = null;

    // Remove click-outside listener
    this.removeOutsideClickHandler();

    // First update UI to remove selection styles
    this.updateConversationSelectionUI();

    // Then clear the selection set
    this.clearSelection();

    // Update mode UI
    this.updateMultiSelectModeUI();

    // Force cleanup of any remaining visual artifacts
    this.cleanupSelectionArtifacts();
  }

  /**
   * Setup a document-level click handler to exit multi-select mode when clicking outside the sidebar
   */
  private setupOutsideClickHandler(): void {
    // Remove any existing handler first
    this.removeOutsideClickHandler();

    this.outsideClickHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Check if click is inside the sidebar or folder container
      const isInsideSidebar = this.sidebarContainer?.contains(target);
      const isInsideFolderContainer = this.containerElement?.contains(target);

      // Check if click is on an overlay (menus, dialogs, etc.)
      const isOnOverlay = target.closest(
        '[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]',
      );

      // If click is outside all relevant areas, exit multi-select mode
      if (!isInsideSidebar && !isInsideFolderContainer && !isOnOverlay) {
        this.debug('Click outside sidebar detected, exiting multi-select mode');
        this.exitMultiSelectMode();
      }
    };

    // Use setTimeout to avoid the current click event from triggering the handler
    setTimeout(() => {
      document.addEventListener('click', this.outsideClickHandler!, true);
    }, 0);
  }

  /**
   * Remove the outside click handler
   */
  private removeOutsideClickHandler(): void {
    if (this.outsideClickHandler) {
      document.removeEventListener('click', this.outsideClickHandler, true);
      this.outsideClickHandler = null;
    }
  }

  private cleanupSelectionArtifacts(): void {
    // Remove selection classes from all native conversations
    const nativeConvs = this.sidebarContainer
      ? getChatGptConversationElements(this.sidebarContainer)
      : [];
    nativeConvs.forEach((element) => {
      element.classList.remove('gv-conversation-selected');
      element.style.opacity = '1';
    });
    // Remove selection classes from all folder conversations
    const folderConvs = this.containerElement?.querySelectorAll('.gv-folder-conversation');
    folderConvs?.forEach((el) => {
      (el as HTMLElement).classList.remove('gv-folder-conversation-selected');
      (el as HTMLElement).style.opacity = '1';
    });

    // Restore active conversation highlight in folders
    // This ensures that the currently active conversation remains highlighted
    // after drag-and-drop or multi-select operations
    this.highlightActiveConversationInFolders();
  }

  /**
   * Provides visual feedback when user attempts to select conversations from different folders.
   * Uses a subtle shake animation to indicate invalid selection.
   *
   * @param element - The conversation element to apply feedback to
   *
   * Note: Uses animationend event instead of setTimeout to ensure cleanup happens
   * exactly when the CSS animation finishes, making it resilient to animation timing changes.
   */
  private showInvalidSelectionFeedback(element: HTMLElement): void {
    // Remove existing class (if any) to allow animation restart on rapid clicks
    element.classList.remove('gv-invalid-selection');

    // Force reflow to ensure animation restarts (see: CSS Triggers)
    void element.offsetWidth;

    // Add invalid selection class to trigger animation
    element.classList.add('gv-invalid-selection');

    // Listen for animation end to clean up the class automatically
    // Using { once: true } ensures the listener is removed after first invocation
    element.addEventListener(
      'animationend',
      () => {
        element.classList.remove('gv-invalid-selection');
      },
      { once: true },
    );

    // Optional: Haptic feedback on mobile devices
    if ('vibrate' in navigator) {
      navigator.vibrate([30, 20, 30]); // Two short vibrations
    }
  }

  private updateMultiSelectModeUI(): void {
    // Add or remove multi-select mode class from container
    if (this.isMultiSelectMode) {
      this.containerElement?.classList.add('gv-multi-select-mode');
    } else {
      this.containerElement?.classList.remove('gv-multi-select-mode');
    }

    // Update selection count in indicator
    const countElement = this.containerElement?.querySelector('[data-selection-count="true"]');
    if (countElement) {
      const count = this.selectedConversations.size;
      countElement.textContent = this.t('multi_select_count').replace('{count}', String(count));
    }

    // Update action buttons based on source
    const actionsContainer = this.containerElement?.querySelector(
      '[data-multi-select-actions="true"]',
    );
    if (actionsContainer && this.isMultiSelectMode) {
      actionsContainer.innerHTML = ''; // Clear existing buttons

      if (this.multiSelectSource === 'folder') {
        // Delete button for folder multi-select (removes from folder only)
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'gv-multi-select-action-btn gv-multi-select-delete-btn';
        deleteBtn.innerHTML =
          '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">delete</mat-icon>';
        deleteBtn.title = this.t('batch_delete_button');
        deleteBtn.addEventListener('click', () => this.batchDeleteConversations());
        actionsContainer.appendChild(deleteBtn);
      } else if (this.multiSelectSource === 'native') {
        // Delete button for native multi-select (deletes from ChatGPT)
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'gv-multi-select-action-btn gv-multi-select-delete-btn';
        deleteBtn.innerHTML =
          '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">delete</mat-icon>';
        deleteBtn.title = this.t('batch_delete_button');
        deleteBtn.addEventListener('click', () => this.batchDeleteNativeConversations());
        actionsContainer.appendChild(deleteBtn);
      }

      // Exit button (always present)
      const exitBtn = document.createElement('button');
      exitBtn.className = 'gv-multi-select-action-btn gv-multi-select-exit-btn';
      exitBtn.innerHTML =
        '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">close</mat-icon>';
      exitBtn.title = this.t('multi_select_exit');
      exitBtn.addEventListener('click', () => this.exitMultiSelectMode());
      actionsContainer.appendChild(exitBtn);
    } else if (actionsContainer) {
      actionsContainer.innerHTML = ''; // Clear buttons when exiting
    }
  }

  private getSelectedConversationsData(_folderId: string): ConversationReference[] {
    const result: ConversationReference[] = [];
    const seen = new Set<string>();

    // Collect from all folders since selection can span folders
    for (const fId in this.data.folderContents) {
      const conversations = this.data.folderContents[fId];
      conversations.forEach((conv) => {
        if (this.selectedConversations.has(conv.conversationId) && !seen.has(conv.conversationId)) {
          seen.add(conv.conversationId);
          result.push(conv);
        }
      });
    }

    return result;
  }

  private renameConversation(
    folderId: string,
    conversationId: string,
    titleElement: HTMLElement,
  ): void {
    // Get current title
    const conv = this.data.folderContents[folderId]?.find(
      (c) => c.conversationId === conversationId,
    );
    if (!conv) return;

    const currentTitle = conv.title;

    // Create inline input for renaming
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'gv-folder-name-input gv-conversation-rename-input';
    input.value = currentTitle;
    input.style.width = '100%';

    // Replace title with input
    const parent = titleElement.parentElement;
    if (!parent) return;

    titleElement.style.display = 'none';
    parent.insertBefore(input, titleElement);
    input.focus();
    input.select();

    let finished = false;
    const cleanup = () => {
      try {
        input.removeEventListener('blur', onBlur);
      } catch (e) {
        this.debug('Failed to remove blur listener:', e);
      }
      try {
        input.removeEventListener('keydown', onKeyDown);
      } catch (e) {
        this.debug('Failed to remove keydown listener:', e);
      }
    };
    const finalize = (commit: boolean) => {
      if (finished) return;
      finished = true;
      cleanup();
      try {
        if (commit) {
          const newTitle = input.value.trim();
          if (newTitle && newTitle !== currentTitle) {
            conv.title = newTitle;
            conv.customTitle = true; // mark as manually renamed, don't auto-sync from native
            conv.updatedAt = Date.now(); // record update time for sync conflict resolution
            this.saveData();
          }
        }
      } catch (e) {
        this.debug('Failed to save renamed conversation:', e);
      }
      // Restore title element gracefully even if DOM re-rendered
      try {
        if (input.isConnected) input.remove();
      } catch (e) {
        this.debug('Failed to remove input:', e);
      }
      try {
        titleElement.style.display = '';
      } catch (e) {
        this.debug('Failed to restore title display:', e);
      }
      try {
        titleElement.textContent = conv.title;
      } catch (e) {
        this.debug('Failed to restore title text:', e);
      }
    };
    const onBlur = () => {
      // Defer finalize to let Angular/SPA navigation settle
      requestAnimationFrame(() => finalize(true));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finalize(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finalize(false);
      }
    };

    input.addEventListener('blur', onBlur);
    input.addEventListener('keydown', onKeyDown);
  }

  private showFolderMenu(event: MouseEvent, folderId: string): void {
    event.stopPropagation();

    const folder = this.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    // Toggle: re-clicking the same folder's "..." closes the open menu.
    // Otherwise (different folder, or stale tracker) close the previous one
    // before opening the next — without this guard, stopPropagation on the
    // trigger button blocks the outside-click closer and menus stack.
    const reopeningSameFolder = this.activeFolderActionsMenuFolderId === folderId;
    this.closeFolderActionsMenu();
    if (reopeningSameFolder) return;

    // Create context menu
    const menu = document.createElement('div');
    menu.className = 'gv-folder-menu';
    menu.style.position = 'fixed';
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;

    const menuItems: Array<{ label: string; action: () => void }> = [
      {
        label: folder.pinned ? this.t('folder_unpin') : this.t('folder_pin'),
        action: () => this.togglePinFolder(folderId),
      },
    ];

    // "Create subfolder" only appears when the parent isn't already at the
    // floor of the depth cap. Pre-existing deeper data still renders; we just
    // don't offer a UI path to grow it further.
    if (this.getFolderDepth(folderId) < MAX_FOLDER_DEPTH) {
      menuItems.push({
        label: this.t('folder_create_subfolder'),
        action: () => this.createFolder(folderId),
      });
    }

    menuItems.push(
      { label: this.t('folder_rename'), action: () => this.renameFolder(folderId) },
      { label: this.t('folder_change_color'), action: () => this.showColorPicker(folderId, event) },
    );

    // Only show instructions editor when Folder-as-Project is enabled
    if (this.folderProjectEnabled) {
      menuItems.push({
        label: this.t('folder_new_chat_in_folder'),
        action: () => this.createNewChatInFolder(folderId),
      });
      menuItems.push({
        label: folder.instructions
          ? this.t('folderAsProject_editInstructions')
          : this.t('folderAsProject_setInstructions'),
        action: () => this.showInstructionsEditor(folderId),
      });
    }

    menuItems.push({ label: this.t('folder_delete'), action: () => this.deleteFolder(folderId) });

    menuItems.forEach((item) => {
      const menuItem = document.createElement('button');
      menuItem.className = 'gv-folder-menu-item';
      menuItem.textContent = item.label;
      menuItem.addEventListener('click', () => {
        item.action();
        this.closeFolderActionsMenu();
      });
      menu.appendChild(menuItem);
    });

    document.body.appendChild(menu);

    const closeMenu = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) this.closeFolderActionsMenu();
    };
    // setTimeout so the same click that opened the menu doesn't immediately
    // close it via the document-level listener.
    const closerTimeoutId = window.setTimeout(
      () => document.addEventListener('click', closeMenu),
      0,
    );

    this.activeFolderActionsMenu = menu;
    this.activeFolderActionsMenuFolderId = folderId;
    this.activeFolderActionsMenuCleanup = () => {
      window.clearTimeout(closerTimeoutId);
      document.removeEventListener('click', closeMenu);
      menu.remove();
    };
  }

  /** Tear down whatever per-folder "..." menu is currently mounted. Safe to
   *  call with nothing open. */
  private closeFolderActionsMenu(): void {
    if (this.activeFolderActionsMenuCleanup) {
      try {
        this.activeFolderActionsMenuCleanup();
      } catch {
        // best-effort
      }
    }
    this.activeFolderActionsMenu = null;
    this.activeFolderActionsMenuFolderId = null;
    this.activeFolderActionsMenuCleanup = null;
  }

  /**
   * Navigate to a new chat page and pre-select this folder via the
   * Folder-as-Project picker. Stores the folder ID in local storage so the
   * picker can auto-select it after the page loads.
   */
  private createNewChatInFolder(folderId: string): void {
    const navigate = () => {
      const currentPath = window.location.pathname;
      const localeMatch = currentPath.match(/^\/([a-z]{2}(?:-[a-z]{2})?)(?=\/|$)/i);
      const localePrefix = localeMatch ? `/${localeMatch[1]}` : '';
      const pathWithoutLocale = currentPath.slice(localePrefix.length);
      const customGptMatch = pathWithoutLocale.match(/^\/g\/([^/?#]+)/);
      const targetPath = customGptMatch
        ? `${localePrefix}/g/${customGptMatch[1]}`
        : localePrefix || '/';
      const normalizedCurrentPath =
        currentPath.length > 1 ? currentPath.replace(/\/+$/, '') : currentPath;
      const normalizedTargetPath =
        targetPath.length > 1 ? targetPath.replace(/\/+$/, '') : targetPath;

      if (normalizedCurrentPath === normalizedTargetPath) {
        window.location.reload();
      } else {
        window.location.href = `${window.location.origin}${targetPath}`;
      }
    };

    browser.storage.local
      .set({ [StorageKeys.FOLDER_PROJECT_PENDING_FOLDER_ID]: folderId })
      .then(navigate)
      .catch((error) => {
        if (isExtensionContextInvalidatedError(error)) return;
        // storage failed 鈥?still navigate so the user isn't stranded; they can pick the folder manually
        console.warn('[folder] failed to set pending folder ID', error);
        navigate();
      });
  }

  /**
   * Show color picker dialog for a folder
   * @param folderId The folder ID to change color
   * @param sourceEvent The source mouse event (for positioning)
   */
  private showColorPicker(
    folderId: string,
    sourceEvent: MouseEvent,
    allowToggle: boolean = true,
  ): void {
    const folder = this.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    // If a color picker is already open, close it first
    if (this.activeColorPicker) {
      const wasSameFolder = this.activeColorPickerFolderId === folderId;
      this.activeColorPicker.remove();
      // Clean up the old event listener to prevent memory leak
      if (this.activeColorPickerCloseHandler) {
        document.removeEventListener('click', this.activeColorPickerCloseHandler);
        this.activeColorPickerCloseHandler = null;
      }
      this.activeColorPicker = null;
      this.activeColorPickerFolderId = null;
      // If clicking the same folder icon again and toggle is allowed, just close the picker
      if (allowToggle && wasSameFolder) {
        return;
      }
    }

    // Create color picker dialog
    const dialog = document.createElement('div');
    dialog.className = 'gv-color-picker-dialog';

    // Position near the menu click (slightly offset to avoid overlap)
    dialog.style.position = 'fixed';
    dialog.style.left = `${sourceEvent.clientX + 10}px`;
    dialog.style.top = `${sourceEvent.clientY}px`;
    dialog.style.zIndex = '10001';

    // Create color options
    FOLDER_COLORS.forEach((colorConfig) => {
      const colorBtn = document.createElement('button');
      colorBtn.className = 'gv-color-picker-item';
      colorBtn.title = this.t(colorConfig.nameKey);

      // Apply color based on current theme
      const colorValue = getFolderColor(colorConfig.id, isDarkMode());
      colorBtn.style.backgroundColor = colorValue;

      // Mark current color as selected
      if (folder.color === colorConfig.id || (!folder.color && colorConfig.id === 'default')) {
        colorBtn.classList.add('selected');
      }

      colorBtn.addEventListener('click', () => {
        this.changeFolderColor(folderId, colorConfig.id);
        dialog.remove();
        if (this.activeColorPickerCloseHandler) {
          document.removeEventListener('click', this.activeColorPickerCloseHandler);
          this.activeColorPickerCloseHandler = null;
        }
        this.activeColorPicker = null;
        this.activeColorPickerFolderId = null;
      });

      dialog.appendChild(colorBtn);
    });

    // Add Custom Color Picker Button
    const customBtn = document.createElement('button');
    customBtn.className = 'gv-color-picker-item gv-color-picker-custom';
    customBtn.title = this.t('folder_color_custom');

    // Create hidden color input
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    // Style to be invisible but functional
    Object.assign(colorInput.style, {
      position: 'absolute',
      opacity: '0',
      width: '100%',
      height: '100%',
      top: '0',
      left: '0',
      cursor: 'pointer',
    });

    // Set initial state
    if (folder.color && folder.color.startsWith('#')) {
      colorInput.value = folder.color;
      customBtn.classList.add('selected');
      customBtn.style.background = folder.color;
    } else {
      // Rainbow gradient to indicate color picker
      customBtn.style.background =
        'conic-gradient(from 180deg at 50% 50%, #D9231E 0deg, #F06800 66.47deg, #E6A300 125.68deg, #2D9CDB 195.91deg, #9B51E0 262.24deg, #D9231E 360deg)';
    }

    // Handle color change
    colorInput.addEventListener('change', (e) => {
      const hex = (e.target as HTMLInputElement).value;
      this.changeFolderColor(folderId, hex);
      dialog.remove(); // Close picker dialog
      if (this.activeColorPickerCloseHandler) {
        document.removeEventListener('click', this.activeColorPickerCloseHandler);
        this.activeColorPickerCloseHandler = null;
      }
      this.activeColorPicker = null;
      this.activeColorPickerFolderId = null;
    });

    // Prevent button click from closing the dialog immediately (if bubbling)
    customBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Trigger the input (if not clicked directly via the overlay input)
      // Since input covers the button, this might not be strictly needed, but good for safety
      if (e.target === customBtn) {
        colorInput.click();
      }
    });

    customBtn.appendChild(colorInput);
    dialog.appendChild(customBtn);

    document.body.appendChild(dialog);
    this.activeColorPicker = dialog;
    this.activeColorPickerFolderId = folderId;

    // Close dialog on click outside
    const closeDialog = (e: MouseEvent) => {
      if (!dialog.contains(e.target as Node)) {
        dialog.remove();
        this.activeColorPicker = null;
        this.activeColorPickerFolderId = null;
        if (this.activeColorPickerCloseHandler) {
          document.removeEventListener('click', this.activeColorPickerCloseHandler);
          this.activeColorPickerCloseHandler = null;
        }
      }
    };
    this.activeColorPickerCloseHandler = closeDialog;
    setTimeout(() => document.addEventListener('click', closeDialog), 0);
  }

  /**
   * Change folder color
   * @param folderId The folder ID to change
   * @param colorId The new color ID
   */
  private changeFolderColor(folderId: string, colorId: string): void {
    const folder = this.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    folder.color = colorId;
    folder.updatedAt = Date.now();

    this.saveData();
    this.refresh();
  }

  private showMoveToFolderDialog(
    conversationId: string,
    conversationTitle: string,
    url: string,
  ): void {
    // Create dialog overlay
    const overlay = document.createElement('div');
    overlay.className = 'gv-folder-dialog-overlay';

    // Create dialog
    const dialog = document.createElement('div');
    dialog.className = 'gv-folder-dialog';

    // Dialog title
    const dialogTitle = document.createElement('div');
    dialogTitle.className = 'gv-folder-dialog-title';
    dialogTitle.textContent = this.t('conversation_move_to_folder_title');

    // Folder list
    const folderList = document.createElement('div');
    folderList.className = 'gv-folder-dialog-list';

    // Helper function to add folder options recursively
    const addFolderOptions = (parentId: string | null, level: number = 0) => {
      const folders = this.data.folders.filter((f) => f.parentId === parentId);
      const sortedFolders = this.sortFolders(folders); // Apply same sorting as sidebar
      sortedFolders.forEach((folder) => {
        const folderItem = document.createElement('button');
        folderItem.className = 'gv-folder-dialog-item';
        folderItem.style.paddingLeft = `${calculateFolderDialogPaddingLeft(level)}px`;

        // Folder icon — a real SVG, not a Material ligature. The dialog is
        // appended to <body>, outside the `.gv-folder-container` scope that
        // hides leftover `<mat-icon>` glyphs, so a ligature here rendered as
        // the literal word "folder" spilling over the folder name (issue #7).
        const icon = document.createElement('span');
        icon.className = 'gv-folder-dialog-item-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.appendChild(createFolderSvgIcon(16));

        // Folder name
        const name = document.createElement('span');
        name.className = 'gv-folder-dialog-item-name';
        name.textContent = folder.name;

        folderItem.appendChild(icon);
        folderItem.appendChild(name);

        folderItem.addEventListener('click', () => {
          this.addConversationToFolderFromNative(folder.id, conversationId, conversationTitle, url);
          overlay.remove();
        });

        folderList.appendChild(folderItem);

        // Add subfolders recursively
        addFolderOptions(folder.id, level + 1);
      });
    };

    // Add root folders and their children
    addFolderOptions(null);

    // Cancel button
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'gv-folder-dialog-cancel';
    cancelBtn.textContent = this.t('pm_cancel');
    cancelBtn.addEventListener('click', () => overlay.remove());

    // Assemble dialog
    dialog.appendChild(dialogTitle);
    dialog.appendChild(folderList);
    dialog.appendChild(cancelBtn);
    overlay.appendChild(dialog);

    // Add to body
    document.body.appendChild(overlay);

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
      }
    });
  }

  private moveConversationToFolder(
    sourceFolderId: string,
    targetFolderId: string,
    conv: ConversationReference,
  ): void {
    // Remove from source folder
    if (this.data.folderContents[sourceFolderId]) {
      this.data.folderContents[sourceFolderId] = this.data.folderContents[sourceFolderId].filter(
        (c) => c.conversationId !== conv.conversationId,
      );
    }

    // Add to target folder
    if (!this.data.folderContents[targetFolderId]) {
      this.data.folderContents[targetFolderId] = [];
    }

    // Check if conversation already exists in target folder
    const existingIndex = this.data.folderContents[targetFolderId].findIndex(
      (c) => c.conversationId === conv.conversationId,
    );

    if (existingIndex === -1) {
      // Add with updated timestamp
      this.data.folderContents[targetFolderId].push({
        ...conv,
        addedAt: Date.now(),
      });
    }

    this.saveData();
    this.refresh();
  }

  public addConversationToFolderFromNative(
    folderId: string,
    conversationId: string,
    title: string,
    url: string,
    legacyIsGem?: boolean,
    legacyGemId?: string,
  ): void {
    // Guard: ensure the target folder still exists (it may have been deleted
    // from the sidebar or another tab between selection and message send)
    const folderExists = this.data.folders.some((f) => f.id === folderId);
    if (!folderExists) return;

    // Add to folder
    if (!this.data.folderContents[folderId]) {
      this.data.folderContents[folderId] = [];
    }

    // Check if conversation already exists in folder
    const existingIndex = this.data.folderContents[folderId].findIndex(
      (c) => c.conversationId === conversationId,
    );

    let addedNewConversation = false;
    if (existingIndex === -1) {
      // Add new conversation
      this.data.folderContents[folderId].push({
        conversationId,
        title,
        url,
        addedAt: Date.now(),
        ...this.copyLegacyImportedConversationMetadata({
          isGem: legacyIsGem,
          gemId: legacyGemId,
        }),
      });
      addedNewConversation = true;
    }

    this.saveData();
    this.refresh();
    if (addedNewConversation) {
      this.maybeShowHideArchivedNudge();
    }
  }

  /**
   * Returns the current folder list (read-only snapshot for external callers).
   */
  public getFolders(): readonly Folder[] {
    return this.data.folders;
  }

  /**
   * Ensures folder data is loaded. Re-reads from storage if the folder list
   * is empty, which can happen after extension context invalidation or async
   * storage listener resets.
   */
  public async ensureDataLoaded(): Promise<void> {
    if (this.data.folders.length === 0) {
      await this.loadData();
    }
  }

  /**
   * Open a modal that lets the user write or edit text instructions for a
   * folder. Instructions are saved to `folder.instructions` and persisted
   * via `saveData()`.
   *
   * @param folderId - The folder to edit instructions for
   */
  private showInstructionsEditor(folderId: string): void {
    const folder = this.data.folders.find((f) => f.id === folderId);
    if (!folder) return;

    const MAX_CHARS = 10000;

    // 鈹€鈹€ Overlay 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    const overlay = document.createElement('div');
    overlay.className = 'gv-fi-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'gv-fi-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'gv-fi-dialog-title');

    // 鈹€鈹€ Title 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    const titleEl = document.createElement('h2');
    titleEl.className = 'gv-fi-title';
    titleEl.id = 'gv-fi-dialog-title';
    titleEl.textContent = folder.instructions
      ? this.t('folderAsProject_editInstructions')
      : this.t('folderAsProject_setInstructions');

    // 鈹€鈹€ Instructions textarea 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    const textarea = document.createElement('textarea');
    textarea.className = 'gv-fi-textarea';
    textarea.maxLength = MAX_CHARS;
    textarea.rows = 7;
    textarea.placeholder = this.t('folderAsProject_setInstructions');
    textarea.value = folder.instructions ?? '';

    const charCount = document.createElement('div');
    charCount.className = 'gv-fi-char-count';
    charCount.textContent = `${textarea.value.length} / ${MAX_CHARS}`;
    textarea.addEventListener('input', () => {
      charCount.textContent = `${textarea.value.length} / ${MAX_CHARS}`;
    });

    // 鈹€鈹€ Actions 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    const actions = document.createElement('div');
    actions.className = 'gv-fi-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'gv-fi-btn gv-fi-btn-cancel';
    cancelBtn.type = 'button';
    cancelBtn.textContent = this.t('pm_cancel');
    cancelBtn.addEventListener('click', () => overlay.remove());

    const saveBtn = document.createElement('button');
    saveBtn.className = 'gv-fi-btn gv-fi-btn-save';
    saveBtn.type = 'button';
    saveBtn.textContent = this.t('pm_save');
    saveBtn.addEventListener('click', async () => {
      const trimmed = textarea.value.trim();
      folder.instructions = trimmed || undefined;
      folder.updatedAt = Date.now();
      await this.saveData();
      overlay.remove();
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    // 鈹€鈹€ Assembly 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    dialog.appendChild(titleEl);
    dialog.appendChild(textarea);
    dialog.appendChild(charCount);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') overlay.remove();
    });

    setTimeout(() => textarea.focus(), 50);
  }

  private setupNativeConversationMenuObserver(): void {
    // Intentionally no always-on body observer. A bounded observer is armed
    // only in capture phase after the user opens a verified conversation menu.
    this.cancelNativeMenuWatch();
  }

  private injectMoveToFolderButton(
    menuContent: HTMLElement,
    context: NativeConversationContext,
  ): void {
    if (menuContent.querySelector('.gv-move-to-folder-btn')) return;

    const moveToFolderLabel = this.t('conversation_move_to_folder');
    const menuItem = createMoveToFolderMenuItem(menuContent, moveToFolderLabel, moveToFolderLabel);

    menuItem.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeNativeConversationMenu(menuContent);
      this.showMoveToFolderDialog(context.id, context.title, context.url);
    });

    const deleteItem = findDeleteConversationMenuItem(menuContent);
    const deleteGroup = deleteItem?.parentElement;
    const deleteBelongsToOwnedMenu =
      deleteItem && deleteItem.closest<HTMLElement>('[role="menu"]') === menuContent;
    if (deleteItem && deleteGroup && deleteBelongsToOwnedMenu) {
      deleteGroup.insertBefore(menuItem, deleteItem);
      return;
    }

    const directGroup = menuContent.querySelector<HTMLElement>(':scope > [role="group"]');
    (directGroup ?? menuContent).appendChild(menuItem);
  }

  private setupConversationClickTracking(): void {
    if (this.conversationMenuClickListener) return;

    this.conversationMenuClickListener = (event: Event) => {
      const trigger = findConversationOptionsTrigger(event.target);
      if (!trigger) return;
      if (this.suppressedConversationMenuTrigger === trigger) return;

      let context: NativeConversationContext | null = null;
      if (isHeaderConversationOptionsTrigger(trigger)) {
        const pageInfo = this.extractConversationInfoFromPage();
        if (pageInfo) context = { ...pageInfo, element: trigger };
      } else {
        context = resolveSidebarConversationContext(trigger);
      }
      if (!context) return;

      void this.startOwnedNativeMenuWatch(trigger, context.id).then((menu) => {
        if (!menu || this.isDestroyed) return;
        if (!isElementOpen(menu) || !isNativeConversationMenuBoundToTrigger(menu, trigger)) return;
        const liveContext = isHeaderConversationOptionsTrigger(trigger)
          ? this.extractConversationInfoFromPage()
          : resolveSidebarConversationContext(trigger);
        if (normalizeChatGptConversationId(liveContext?.id) !== context.id) return;
        this.injectMoveToFolderButton(menu, context);
      });
    };

    document.addEventListener('click', this.conversationMenuClickListener, true);
  }

  private extractNativeConversationId(conversationEl: HTMLElement): string | null {
    return (
      getChatGptConversationId(conversationEl) ??
      this.extractConversationIdFromJslog(conversationEl)
    );
  }

  private extractNativeConversationTitle(conversationEl: HTMLElement): string | null {
    return getChatGptConversationTitle(conversationEl);
  }

  private syncConversationTitleFromNative(conversationId: string): string | null {
    try {
      const normalizedId = this.normalizeConversationId(conversationId);
      if (!normalizedId) return null;

      // Try to find the conversation in the native sidebar by its ID
      const conversations = getChatGptConversationElements(document);
      for (const convEl of Array.from(conversations)) {
        const currentId = this.normalizeConversationId(
          this.extractNativeConversationId(convEl as HTMLElement),
        );
        if (currentId && currentId === normalizedId) {
          const currentTitle = this.extractNativeConversationTitle(convEl as HTMLElement);
          if (currentTitle) {
            this.debug('Synced title from native:', currentTitle);
            return currentTitle;
          }
        }
      }
    } catch (e) {
      this.debug('Error syncing title from native:', e);
    }
    return null;
  }

  private updateConversationTitle(conversationId: string, newTitle: string): void {
    // Update the title for all instances of this conversation across all folders
    let updated = false;

    for (const folderId in this.data.folderContents) {
      const conversations = this.data.folderContents[folderId];
      for (const conv of conversations) {
        // Match by conversation ID (check both direct match and URL match)
        if (
          (conv.conversationId === conversationId || conv.url.includes(conversationId)) &&
          !conv.customTitle
        ) {
          conv.title = newTitle;
          updated = true;
          this.debug(`Updated title for conversation ${conversationId} in folder ${folderId}`);
        }
      }
    }

    if (updated) {
      this.saveData();
      // Re-render folders to show updated title
      this.renderAllFolders();
    }
  }

  /**
   * Schedule a delayed check to confirm conversation deletion
   * This prevents false positives when ChatGPT UI temporarily removes/re-adds elements
   */
  private scheduleConversationRemovalCheck(conversationId: string): void {
    // Cancel any existing timer for this conversation
    const existingTimer = this.pendingRemovals.get(conversationId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.debug(`Cancelled previous removal timer for ${conversationId}`);
    }

    // Schedule a new check after delay
    const timerId = window.setTimeout(() => {
      this.confirmConversationRemoval(conversationId);
    }, this.removalCheckDelay);

    this.pendingRemovals.set(conversationId, timerId);
    this.debug(
      `Scheduled removal check for ${conversationId} (delay: ${this.removalCheckDelay}ms)`,
    );
  }

  /**
   * Cancel pending removal for a conversation element that was re-added
   */
  private cancelPendingRemovalForElement(element: HTMLElement): void {
    // Extract conversation ID from the element
    const conversationId = this.extractConversationIdFromElement(element);

    if (conversationId) {
      const timerId = this.pendingRemovals.get(conversationId);
      if (timerId) {
        clearTimeout(timerId);
        this.pendingRemovals.delete(conversationId);
        this.debug(`Cancelled removal for ${conversationId} (conversation re-added to DOM)`);
      }
    }
  }

  /**
   * Check if conversation still exists in DOM
   * Returns true if conversation found, false if definitely deleted
   * In case of errors, conservatively returns true to avoid false deletions
   */
  private isConversationInDOM(conversationId: string): boolean {
    if (!this.sidebarContainer) {
      this.debugWarn('Sidebar container not available for DOM check');
      return true; // Conservative: assume conversation exists if we can't check
    }

    try {
      const expectedId = normalizeChatGptConversationId(conversationId);
      if (!expectedId) return true;
      const found = getChatGptConversationElements(this.sidebarContainer).some(
        (element) =>
          normalizeChatGptConversationId(this.extractNativeConversationId(element)) === expectedId,
      );
      if (found) {
        this.debug(`Found conversation ${conversationId} in the ChatGPT sidebar`);
        return true;
      }

      // Not found in DOM
      this.debug(`Conversation ${conversationId} not found in DOM`);
      return false;
    } catch (error) {
      this.debugWarn(`DOM check failed for ${conversationId}:`, error);
      // Conservative approach: if we can't check, assume it still exists
      // This prevents accidental deletion during DOM reconstruction
      return true;
    }
  }

  /**
   * Get the conversation ID from current URL
   */
  private getCurrentConversationId(): string | null {
    return extractChatGptConversationIdFromUrl(window.location.href);
  }

  /**
   * Confirm conversation removal after delay
   * Only removes if conversation is truly deleted (not in DOM and not current conversation)
   */
  private confirmConversationRemoval(conversationId: string): void {
    // Remove from pending list
    this.pendingRemovals.delete(conversationId);

    this.debug(`Confirming removal for conversation ${conversationId}`);
    this.debug(`  Delay elapsed: ${this.removalCheckDelay}ms`);

    // Check 1: Is this the currently active conversation?
    const currentConvId = this.getCurrentConversationId();
    const currentUrl = window.location.href;

    if (currentConvId === conversationId) {
      this.debug('  SKIPPED: Currently active conversation');
      this.debug(`    Current URL: ${currentUrl}`);
      this.debug(`    Matched ID: ${currentConvId}`);
      this.debug('Removal skipped.');
      return;
    }

    // Check 2: Is conversation still in DOM?
    if (this.isConversationInDOM(conversationId)) {
      this.debug('  SKIPPED: Conversation still exists in DOM');
      this.debug(`    Likely a UI refresh, not a deletion`);
      this.debug(`════════════════════════════════════════════════\n`);
      return;
    }

    // Conversation is truly deleted - remove from folders
    this.debug('  CONFIRMED DELETION: Removing from all folders');
    this.debug(`    Reason: Not in current URL and not found in DOM`);
    this.debug(`    Current URL: ${currentUrl}`);
    this.debug(`════════════════════════════════════════════════\n`);

    void this.removeConversationFromAllFolders(conversationId);
  }

  private async removeConversationFromAllFolders(conversationId: string): Promise<void> {
    // Remove this conversation from all folders when the original conversation is deleted
    let removed = false;

    for (const folderId in this.data.folderContents) {
      const conversations = this.data.folderContents[folderId];
      const initialLength = conversations.length;

      // Filter out the deleted conversation
      this.data.folderContents[folderId] = conversations.filter(
        (conv) => conv.conversationId !== conversationId && !conv.url.includes(conversationId),
      );

      if (this.data.folderContents[folderId].length < initialLength) {
        removed = true;
        this.debug(`Removed deleted conversation ${conversationId} from folder ${folderId}`);
      }
    }

    if (removed) {
      await this.saveData();
      // Re-render folders to reflect the removal
      this.renderAllFolders();
    }
  }

  private buildConversationUrlFromId(conversationId: string): string {
    const normalizedId = normalizeChatGptConversationId(conversationId);
    if (!normalizedId) return window.location.origin;

    try {
      const path = window.location.pathname;
      const customGptMatch = path.match(/^(\/[a-z]{2}(?:-[a-z]{2})?)?\/g\/([^/?#]+)(?=\/|$)/i);
      if (customGptMatch) {
        const localePrefix = customGptMatch[1] ?? '';
        const customGptId = customGptMatch[2];
        return `${window.location.origin}${localePrefix}/g/${customGptId}/c/${normalizedId}`;
      }
    } catch (e) {
      this.debug('Failed to resolve custom GPT context:', e);
    }
    return `${window.location.origin}/c/${normalizedId}`;
  }

  private extractNativeConversationUrl(conversationEl: HTMLElement): string | null {
    const chatGptUrl = getChatGptConversationUrl(conversationEl);
    if (chatGptUrl) return chatGptUrl;

    const fallbackId = this.extractConversationIdFromJslog(conversationEl);
    return fallbackId ? this.buildConversationUrlFromId(fallbackId) : null;
  }

  private refresh(): void {
    if (!this.containerElement) return;

    // Clear active folder input reference since the DOM will be replaced
    this.clearActiveFolderInput();

    // Find and update the folders list
    const oldList = this.containerElement.querySelector('.gv-folder-list');
    if (oldList) {
      const newList = this.createFoldersList();
      oldList.replaceWith(newList);
    }

    // Re-apply hide archived setting after refresh
    this.applyHideArchivedSetting();

    // Update active highlight after re-render
    this.highlightActiveConversationInFolders();

    // Flush any pending title updates collected during rendering
    if (this.pendingTitleUpdates.size > 0) {
      this.debug(`Flushing ${this.pendingTitleUpdates.size} pending title updates`);
      // Save once after all title updates are applied (async, fire-and-forget)
      this.saveData()
        .then((saved) => {
          // Only clear after confirmed successful save to avoid losing updates
          if (saved) {
            this.pendingTitleUpdates.clear();
          } else {
            this.debugWarn('Save failed, retaining pending title updates for next attempt');
          }
        })
        .catch((error) => {
          console.error('[FolderManager] Failed to save pending title updates:', error);
        });
    }
  }

  private highlightActiveConversationInFolders(): void {
    if (!this.containerElement) return;
    const currentId = this.normalizeConversationId(this.getCurrentConversationId());
    const rows = this.containerElement.querySelectorAll('.gv-folder-conversation');
    rows.forEach((el) => {
      const row = el as HTMLElement;
      const rowId = this.normalizeConversationId(row.dataset.conversationId);
      const isActive = Boolean(currentId && rowId === currentId);
      row.classList.toggle('gv-folder-conversation-selected', !!isActive);
    });
  }

  /**
   * Ensures data integrity by validating and repairing the folder data structure.
   * This method is called by both loadData() and saveData() to maintain consistency.
   */
  private ensureDataIntegrity(): void {
    // Ensure folderContents object exists
    if (!this.data.folderContents) {
      this.data.folderContents = {};
      this.debugWarn('folderContents was missing, initialized');
    }

    // Ensure folders array exists
    if (!this.data.folders) {
      this.data.folders = [];
      this.debugWarn('folders was missing, initialized');
    }

    // Ensure all folders have a folderContents entry (even if empty)
    // This is critical for empty folders to persist correctly
    this.data.folders.forEach((folder) => {
      if (!this.data.folderContents[folder.id]) {
        this.data.folderContents[folder.id] = [];
        this.debugWarn(`Initialized missing folderContents for folder: ${folder.name}`);
      }
    });

    // Deduplicate conversations within each folder
    for (const folderId of Object.keys(this.data.folderContents)) {
      const convs = this.data.folderContents[folderId];
      const seen = new Set<string>();
      const deduped = convs.filter((c) => {
        if (seen.has(c.conversationId)) return false;
        seen.add(c.conversationId);
        return true;
      });
      if (deduped.length < convs.length) {
        this.debugWarn(
          `Removed ${convs.length - deduped.length} duplicate conversations in folder: ${folderId}`,
        );
        this.data.folderContents[folderId] = deduped;
      }
    }

    // Ensure all items have sortIndex for manual ordering
    this.ensureSortIndices();
  }

  /**
   * Assign sortIndex to folders and conversations that don't have one yet.
   * Uses current sort order so existing users see no change on upgrade.
   */
  private ensureSortIndices(): void {
    // Group folders by parent
    const foldersByParent = new Map<string, Folder[]>();
    for (const folder of this.data.folders) {
      const parentKey = folder.parentId ?? '__root__';
      if (!foldersByParent.has(parentKey)) foldersByParent.set(parentKey, []);
      foldersByParent.get(parentKey)!.push(folder);
    }

    // Assign sortIndex to folders missing it, preserving current name-based order
    for (const siblings of foldersByParent.values()) {
      const needsIndex = siblings.some((f) => f.sortIndex == null);
      if (!needsIndex) continue;

      // Sort by current logic (pinned state ignored here 鈥?sortIndex is within same pinned group)
      const sorted = [...siblings].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      );
      sorted.forEach((folder, i) => {
        if (folder.sortIndex == null) folder.sortIndex = i;
      });
    }

    // Assign sortIndex to conversations missing it, preserving current time-based order
    for (const [, conversations] of Object.entries(this.data.folderContents)) {
      const needsIndex = conversations.some((c) => c.sortIndex == null);
      if (!needsIndex) continue;

      const sorted = [...conversations].sort((a, b) => {
        const aTime = a.lastOpenedAt ?? a.addedAt ?? 0;
        const bTime = b.lastOpenedAt ?? b.addedAt ?? 0;
        return bTime - aTime;
      });
      sorted.forEach((conv, i) => {
        const original = conversations.find((c) => c.conversationId === conv.conversationId);
        if (original && original.sortIndex == null) original.sortIndex = i;
      });
    }
  }

  /**
   * Load folder data from storage (async, browser-agnostic)
   * Uses storage adapter for automatic Safari/non-Safari handling
   */
  private async loadData(): Promise<void> {
    try {
      let loadedData = await this.storage.loadData(this.activeStorageKey);

      if (!loadedData && this.accountIsolationEnabled && this.activeStorageKey !== STORAGE_KEY) {
        loadedData = await this.migrateLegacyFolderDataToScopedStorage();
      }

      if (loadedData && isValidFolderData(loadedData)) {
        this.data = loadedData;

        // Validate and repair data integrity
        this.ensureDataIntegrity();

        // Clean up orphaned folderContents (folders that no longer exist)
        const validFolderIds = new Set(this.data.folders.map((f) => f.id));
        validFolderIds.add(ROOT_CONVERSATIONS_ID); // Keep root conversations
        Object.keys(this.data.folderContents).forEach((folderId) => {
          if (!validFolderIds.has(folderId)) {
            this.debugWarn(`Removing orphaned folderContents for: ${folderId}`);
            delete this.data.folderContents[folderId];
          }
        });

        // Create primary backup on successful load
        await this.backupService.createPrimaryBackup(this.data);

        this.debug('Data loaded and validated successfully');
      } else if (loadedData) {
        // Data exists but validation failed - this is a real corruption case
        console.warn(
          '[FolderManager] Storage returned invalid data structure, attempting recovery from backup',
        );
        const recovered = await this.attemptDataRecovery({
          reason: 'corrupted',
          originalData: loadedData,
        });
        if (!recovered) throw new Error('Folder data is corrupted and no backup could be restored');
      } else {
        // No data found - likely a first-time user
        console.log(
          '[FolderManager] No folder data found, initializing empty state (likely first-time user)',
        );
        this.data = { folders: [], folderContents: {} };
        // No notification needed - this is expected for new users
      }
    } catch (error) {
      console.error('[FolderManager] Load data error:', error);

      // CRITICAL: Do NOT clear data on error - this causes data loss!
      // Instead, try to recover from backup or keep existing data
      const recovered = await this.attemptDataRecovery(error);
      if (!recovered) {
        throw error;
      }
    }
  }

  private cloneFolderData(data: FolderData): FolderData {
    const folders = data.folders.map((folder) => ({ ...folder }));
    const folderContents = Object.fromEntries(
      Object.entries(data.folderContents || {}).map(([folderId, conversations]) => [
        folderId,
        conversations.map((conversation) => ({ ...conversation })),
      ]),
    );
    return { folders, folderContents };
  }

  /** Import migration only: old Gemini backups encoded an account slot in
   * /u/:number routes. Live ChatGPT conversations are never classified by
   * this legacy path shape. */
  private extractLegacyGeminiRouteUserIdFromUrl(url: string): string | null {
    try {
      return new URL(url).pathname.match(/^\/u\/(\d+)\//)?.[1] ?? null;
    } catch {
      return null;
    }
  }

  private filterLegacyFolderDataByCurrentAccount(data: FolderData): FolderData {
    const routeUserId = this.accountScope?.routeUserId;
    if (!routeUserId) {
      return this.cloneFolderData(data);
    }

    const folderById = new Map(data.folders.map((folder) => [folder.id, folder]));
    const visibleFolderIds = new Set<string>();
    const nextContents: Record<string, ConversationReference[]> = {};

    for (const [folderId, conversations] of Object.entries(data.folderContents || {})) {
      const filtered = conversations.filter((conversation) => {
        const conversationUserId = this.extractLegacyGeminiRouteUserIdFromUrl(conversation.url);
        return conversationUserId === null || conversationUserId === routeUserId;
      });
      if (filtered.length === 0) continue;

      nextContents[folderId] = filtered.map((conversation) => ({ ...conversation }));
      if (folderId !== ROOT_CONVERSATIONS_ID) {
        visibleFolderIds.add(folderId);
      }
    }

    const stack = [...visibleFolderIds];
    while (stack.length > 0) {
      const currentId = stack.pop();
      if (!currentId) continue;

      const folder = folderById.get(currentId);
      if (!folder?.parentId) continue;
      if (visibleFolderIds.has(folder.parentId)) continue;
      visibleFolderIds.add(folder.parentId);
      stack.push(folder.parentId);
    }

    const folders = data.folders
      .filter((folder) => visibleFolderIds.has(folder.id))
      .map((folder) => ({ ...folder }));

    for (const folder of folders) {
      if (!nextContents[folder.id]) {
        nextContents[folder.id] = [];
      }
    }

    if (!nextContents[ROOT_CONVERSATIONS_ID]) {
      nextContents[ROOT_CONVERSATIONS_ID] = [];
    }

    return {
      folders,
      folderContents: nextContents,
    };
  }

  private async migrateLegacyFolderDataToScopedStorage(): Promise<FolderData | null> {
    try {
      const legacyData = await this.storage.loadData(STORAGE_KEY);
      if (!legacyData || !isValidFolderData(legacyData)) {
        return null;
      }

      const migratedData = this.filterLegacyFolderDataByCurrentAccount(legacyData);
      const saved = await this.storage.saveData(this.activeStorageKey, migratedData);
      if (!saved) {
        console.warn('[FolderManager] Failed to persist scoped migration data');
      }
      this.debug(
        'Migrated legacy folder data to scoped storage:',
        this.activeStorageKey,
        migratedData.folders.length,
      );
      return migratedData;
    } catch (error) {
      console.error('[FolderManager] Failed to migrate legacy folder data:', error);
      return null;
    }
  }

  /**
   * Attempt to recover data when loadData() encounters corrupted data or errors.
   * This method is only called when there's an actual problem (not for first-time users).
   * Priority: extension-private backup (primary/emergency/legacy beforeUnload) > keep existing data
   */
  private async attemptDataRecovery(error: unknown): Promise<boolean> {
    console.warn('[FolderManager] Attempting data recovery after load failure');

    // Step 1: Try extension-private backups (primary, emergency, legacy beforeUnload).
    const recovered = await this.backupService.recoverFromBackup();
    if (recovered && isValidFolderData(recovered)) {
      this.data = recovered;
      this.ensureDataIntegrity();
      console.warn('[FolderManager] Data recovered from extension-private backup');
      this.showNotificationByLevel(this.t('folderManager_dataRecoveredFromBackup'), 'warning');
      // Save recovered data to persistent storage
      return await this.saveData();
    }

    // Step 2: If current this.data already has valid structure, keep it
    if (isValidFolderData(this.data) && this.data.folders.length > 0) {
      console.warn('[FolderManager] Keeping existing in-memory data after load error');
      this.ensureDataIntegrity();
      return true;
    }

    // Step 3: Last resort - initialize empty data and log critical error
    console.error('[FolderManager] CRITICAL: Unable to recover data, initializing empty state');
    console.error('[FolderManager] Original error:', error);
    this.data = { folders: [], folderContents: {} };

    // Show user notification about data loss
    this.showDataLossNotification();
    return false;
  }

  /**
   * Show notification to user about potential data loss
   */
  private showDataLossNotification(): void {
    this.showNotificationByLevel(
      getTranslationSync('folderManager_dataLossWarning') ||
        'Warning: Failed to load folder data. Please check your browser console for details.',
      'error',
    );
  }

  /**
   * Show a notification to the user with customizable level
   */
  private showNotificationByLevel(
    message: string,
    level: 'info' | 'warning' | 'error' = 'error',
  ): void {
    try {
      // Color based on level
      const colors = {
        info: '#2196F3',
        warning: '#FF9800',
        error: '#f44336',
      };

      // Create a visible notification
      const notification = document.createElement('div');
      notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${colors[level]};
        color: white;
        padding: 16px 24px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        z-index: 10000;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 14px;
        max-width: 400px;
        line-height: 1.4;
      `;
      notification.textContent = message;
      document.body.appendChild(notification);

      // Auto-remove after timeout (longer for errors/warnings)
      const timeout =
        level === 'info' ? 3000 : level === 'warning' ? 7000 : NOTIFICATION_TIMEOUT_MS;
      setTimeout(() => {
        try {
          document.body.removeChild(notification);
        } catch {
          // Ignore - notification may have already been removed
        }
      }, timeout);
    } catch (notificationError) {
      console.error('[FolderManager] Failed to show notification:', notificationError);
    }
  }

  /**
   * Save folder data to storage (async, browser-agnostic)
   * Uses storage adapter for automatic Safari/non-Safari handling
   */
  private saveData(): Promise<boolean> {
    // Every mutation contributes an immutable latest snapshot. Concurrent
    // callers share one drain promise; none are rejected merely because an
    // older write is still in flight.
    this.ensureDataIntegrity();
    const revision = ++this.saveRevision;
    this.pendingSaveSnapshot = {
      key: this.activeStorageKey,
      data: this.cloneFolderData(this.data),
      revision,
    };
    this.saveRequested = true;
    this.saveDirty = true;

    if (this.savePromise) return this.savePromise;

    this.savePromise = this.flushSaveQueue();
    return this.savePromise;
  }

  private async flushSaveQueue(): Promise<boolean> {
    let latestSuccess = false;

    try {
      while (this.saveRequested) {
        this.saveRequested = false;
        const request = this.pendingSaveSnapshot;
        if (!request) break;

        latestSuccess = await this.persistFolderSnapshot(request);
        if (latestSuccess && !this.saveRequested && this.pendingSaveSnapshot === request) {
          this.saveDirty = false;
          this.pendingSaveSnapshot = null;
        } else if (!latestSuccess) {
          // Keep the latest immutable snapshot available for a later mutation or
          // explicit retry. Do not spin indefinitely on quota/API failures.
          this.saveDirty = true;
        }
      }
    } finally {
      // Clear before the drain promise settles. Clearing this from a chained
      // `finally()` creates a lost-wakeup window where a new mutation can join
      // an already-completed promise without ever being flushed.
      this.savePromise = null;
    }

    const fullyFlushed = latestSuccess && !this.saveDirty && !this.saveRequested;
    if (fullyFlushed) {
      try {
        this.floatingPanelHandle?.update(this.data);
      } catch (error) {
        // Persistence has already been verified; a detached/stale UI handle
        // must not turn a successful save into a false storage failure.
        this.debugWarn('Failed to refresh floating folder panel after save', error);
      }
    }
    return fullyFlushed;
  }

  private async persistFolderSnapshot(request: {
    key: string;
    data: FolderData;
    revision: number;
  }): Promise<boolean> {
    try {
      await this.backupService.createEmergencyBackup(request.data);

      if (
        request.data.folders.length === 0 &&
        Object.keys(request.data.folderContents).length === 0
      ) {
        const existingData = await this.storage.loadData(request.key);
        if (
          existingData &&
          (existingData.folders.length > 0 || Object.keys(existingData.folderContents).length > 0)
        ) {
          console.warn(
            '[FolderManager] WARNING: Attempting to save empty data over existing non-empty data',
          );
          console.warn('[FolderManager] This may indicate a bug.');
        }
      }

      let success = await this.storage.saveData(request.key, request.data);
      if (!success) {
        console.warn('[FolderManager] Save failed, retrying once...');
        success = await this.storage.saveData(request.key, request.data);
      }

      if (!success) {
        console.error('[FolderManager] Save failed after retry');
        return false;
      }

      await this.backupService.createPrimaryBackup(request.data);
      this.debug('Data snapshot saved successfully');
      return true;
    } catch (error) {
      console.error('[FolderManager] Save data error:', error);
      return false;
    }
  }

  private async loadFolderEnabledSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({ [StorageKeys.FOLDER_ENABLED]: true });
      this.folderEnabled = result[StorageKeys.FOLDER_ENABLED] !== false;
      this.debug('Loaded folder enabled setting:', this.folderEnabled);
    } catch (error) {
      console.error('[FolderManager] Failed to load folder enabled setting:', error);
      this.folderEnabled = true;
    }
  }

  /**
   * Opt-in toggle that puts the folder feature into "floating window" mode.
   * When on, the sidebar-injection path is skipped entirely and folders live
   * in a body-level floating panel instead. Off by default 鈥?users opt in
   * from the popup's Folder options.
   */
  private async loadFloatingModeSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({
        [StorageKeys.FOLDER_FLOATING_MODE_ENABLED]: false,
      });
      this.floatingModeEnabled = result[StorageKeys.FOLDER_FLOATING_MODE_ENABLED] === true;
      this.debug('Loaded floating-mode setting:', this.floatingModeEnabled);
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) return;
      console.error('[FolderManager] Failed to load floating-mode setting:', error);
      this.floatingModeEnabled = false;
    }
  }

  private async loadAccountIsolationSetting(): Promise<void> {
    try {
      this.accountIsolationEnabled = await accountIsolationService.isIsolationEnabled({
        platform: 'chatgpt',
        pageUrl: window.location.href,
      });
      this.debug('Loaded account isolation setting:', this.accountIsolationEnabled);
    } catch (error) {
      console.error('[FolderManager] Failed to load account isolation setting:', error);
      this.accountIsolationEnabled = false;
    }
  }

  private async refreshAccountScope(): Promise<void> {
    if (!this.accountIsolationEnabled) {
      this.accountScope = null;
      this.activeStorageKey = STORAGE_KEY;
      return;
    }

    try {
      const context = detectAccountContextFromDocument(window.location.href, document);
      const resolvedScope = await accountIsolationService.resolveAccountScope({
        pageUrl: window.location.href,
        routeUserId: context.routeUserId,
        email: context.email,
      });
      this.accountScope = resolvedScope;
      this.activeStorageKey = buildScopedFolderStorageKey(resolvedScope.accountKey);
      await this.storage.init(this.activeStorageKey);
    } catch (error) {
      console.error('[FolderManager] Failed to resolve account scope:', error);
      this.accountScope = null;
      this.activeStorageKey = STORAGE_KEY;
    }
  }

  private toSyncAccountScope(scope: AccountScope | null): SyncAccountScope | undefined {
    if (!scope) return undefined;
    return {
      accountKey: scope.accountKey,
      accountId: scope.accountId,
      routeUserId: scope.routeUserId,
    };
  }

  private async resolveTimelineHierarchySyncScope(): Promise<SyncAccountScope | undefined> {
    try {
      const context = detectAccountContextFromDocument(window.location.href, document);
      if (!context.routeUserId && !context.email) {
        return undefined;
      }

      const scope = await accountIsolationService.resolveAccountScope({
        pageUrl: window.location.href,
        routeUserId: context.routeUserId,
        email: context.email,
      });

      return this.toSyncAccountScope(scope);
    } catch (error) {
      console.warn('[FolderManager] Failed to resolve timeline hierarchy sync scope:', error);
      return undefined;
    }
  }

  private async loadHideArchivedSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({
        [StorageKeys.FOLDER_HIDE_ARCHIVED_CONVERSATIONS]: false,
      });
      this.hideArchivedConversations = !!result[StorageKeys.FOLDER_HIDE_ARCHIVED_CONVERSATIONS];
      this.debug('Loaded hide archived setting:', this.hideArchivedConversations);
    } catch (error) {
      console.error('[FolderManager] Failed to load hide archived setting:', error);
      this.hideArchivedConversations = false;
    }
    // If the user has (or ever had) hide-archived turned on, they already know
    // the feature exists. Mark the nudge as shown so we never surface it again
    // even if they later turn the feature off.
    this.markNudgeShownIfUserKnowsFeature();
  }

  private async loadFoldersCollapsedSetting(): Promise<void> {
    try {
      const result = await browser.storage.local.get({
        [StorageKeys.FOLDERS_COLLAPSED]: false,
        [StorageKeys.FOLDERS_HIDDEN]: false,
      });
      this.foldersCollapsed = result[StorageKeys.FOLDERS_COLLAPSED] === true;
      this.foldersHidden = result[StorageKeys.FOLDERS_HIDDEN] === true;
    } catch {
      this.foldersCollapsed = false;
      this.foldersHidden = false;
    }
  }

  private async loadConversationSortModeSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({
        [StorageKeys.FOLDER_CONVERSATION_SORT_MODE]: 'manual',
      });
      this.conversationSortMode =
        result[StorageKeys.FOLDER_CONVERSATION_SORT_MODE] === 'recent' ? 'recent' : 'manual';
    } catch {
      this.conversationSortMode = 'manual';
    }
  }

  private markNudgeShownIfUserKnowsFeature(): void {
    if (!this.hideArchivedConversations) return;
    if (this.hideArchivedNudgeShown) return;
    this.hideArchivedNudgeShown = true;
    browser.storage.sync
      .set({ [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN]: true })
      .catch((error) => {
        console.error(
          '[FolderManager] Failed to persist nudge-shown flag after observing hide-archived=true:',
          error,
        );
      });
  }

  private async loadHideArchivedNudgeShownSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({
        [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN]: false,
      });
      this.hideArchivedNudgeShown = !!result[StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN];
      this.debug('Loaded hide-archived nudge shown flag:', this.hideArchivedNudgeShown);
    } catch (error) {
      console.error('[FolderManager] Failed to load hide-archived nudge flag:', error);
      this.hideArchivedNudgeShown = false;
    }
  }

  private maybeShowHideArchivedNudge(): void {
    if (
      !shouldShowHideArchivedNudge({
        nudgeShown: this.hideArchivedNudgeShown,
        hideArchivedAlreadyOn: this.hideArchivedConversations,
      })
    ) {
      return;
    }
    if (!this.containerElement || !document.body.contains(this.containerElement)) return;

    mountHideArchivedNudge({
      container: this.containerElement,
      onEnable: () => {
        this.hideArchivedNudgeShown = true;
        browser.storage.sync
          .set({
            [StorageKeys.FOLDER_HIDE_ARCHIVED_CONVERSATIONS]: true,
            [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN]: true,
          })
          .catch((error) => {
            console.error('[FolderManager] Failed to enable hide-archived from nudge:', error);
          });
      },
      onDismiss: () => {
        this.hideArchivedNudgeShown = true;
        browser.storage.sync
          .set({ [StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN]: true })
          .catch((error) => {
            console.error('[FolderManager] Failed to persist nudge-dismissed flag:', error);
          });
      },
    });
  }

  private async loadFolderTreeIndentSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({
        [StorageKeys.GV_FOLDER_TREE_INDENT]: FOLDER_TREE_INDENT_DEFAULT,
      });
      this.folderTreeIndent = clampFolderTreeIndent(result[StorageKeys.GV_FOLDER_TREE_INDENT]);
      this.debug('Loaded folder tree indent setting:', this.folderTreeIndent);
    } catch (error) {
      console.error('[FolderManager] Failed to load folder tree indent setting:', error);
      this.folderTreeIndent = FOLDER_TREE_INDENT_DEFAULT;
    }
  }

  private async loadFolderProjectEnabledSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({
        [StorageKeys.FOLDER_PROJECT_ENABLED]: false,
      });
      this.folderProjectEnabled = result[StorageKeys.FOLDER_PROJECT_ENABLED] === true;
    } catch {
      this.folderProjectEnabled = false;
    }
  }

  private async loadFolderBelowProjectsSetting(): Promise<void> {
    try {
      const result = await browser.storage.sync.get({
        [StorageKeys.GV_FOLDER_BELOW_PROJECTS]: false,
      });
      this.folderBelowProjects = result[StorageKeys.GV_FOLDER_BELOW_PROJECTS] === true;
      this.debug('Loaded folder below-projects setting:', this.folderBelowProjects);
    } catch {
      this.folderBelowProjects = false;
    }
  }

  private applyFolderTreeIndentSetting(value: unknown): void {
    const nextIndent = clampFolderTreeIndent(value);
    if (nextIndent === this.folderTreeIndent) return;

    this.folderTreeIndent = nextIndent;
    this.debug('Folder tree indent changed:', this.folderTreeIndent);

    if (this.folderEnabled && this.containerElement) {
      this.renderAllFolders();
    }
  }

  private async handleAccountIsolationToggle(enabled: boolean): Promise<void> {
    if (enabled === this.accountIsolationEnabled) return;

    this.accountIsolationEnabled = enabled;
    await this.refreshAccountScope();
    await this.loadData();

    if (this.folderEnabled) {
      this.refresh();
    }
  }

  private setupStorageListener(): void {
    if (this.storageChangeListener) return;

    // Listen for sync settings changes
    this.storageChangeListener = (changes, areaName) => {
      if (areaName === 'sync') {
        if (changes[StorageKeys.FOLDER_ENABLED]) {
          this.folderEnabled = changes[StorageKeys.FOLDER_ENABLED].newValue !== false;
          this.debug('Folder enabled setting changed:', this.folderEnabled);
          // Apply the change to folder visibility
          this.applyFolderEnabledSetting();
        }
        if (changes[StorageKeys.FOLDER_FLOATING_MODE_ENABLED]) {
          const next = changes[StorageKeys.FOLDER_FLOATING_MODE_ENABLED].newValue === true;
          if (next !== this.floatingModeEnabled) {
            this.floatingModeEnabled = next;
            this.debug('Floating-mode toggle changed:', next);

            // When folders are disabled, remember the preference without
            // skipping other keys delivered in the same storage event.
            if (this.folderEnabled) {
              if (next) {
                // Switch to floating: drop any sidebar-mode UI and mount the
                // floating panel. `reinitializeFolderUI` would normally tear down
                // the sidebar bits but also re-run sidebar init; we want the
                // teardown without the re-init, so do it inline.
                if (this.containerElement) {
                  this.containerElement.remove();
                  this.containerElement = null;
                }
                if (this.conversationObserver) {
                  this.conversationObserver.disconnect();
                  this.conversationObserver = null;
                }
                if (this.sideNavObserver) {
                  this.sideNavObserver.disconnect();
                  this.sideNavObserver = null;
                }
                void this.startFloatingMode();
              } else {
                // Switch to sidebar: tear down floating, then ask the existing
                // re-init pipeline to rebuild the sidebar panel.
                this.stopFloatingMode();
                this.reinitializeFolderUI();
              }
            }
          }
        }
        if (changes[StorageKeys.FOLDER_HIDE_ARCHIVED_CONVERSATIONS]) {
          this.hideArchivedConversations =
            !!changes[StorageKeys.FOLDER_HIDE_ARCHIVED_CONVERSATIONS].newValue;
          this.debug('Hide archived setting changed:', this.hideArchivedConversations);
          // Apply the change to all conversations
          this.applyHideArchivedSetting();
          // If user enabled hide-archived from the popup while the nudge is
          // still visible, remove it 鈥?the nudge's purpose is already served.
          if (this.hideArchivedConversations && this.containerElement) {
            unmountHideArchivedNudge(this.containerElement);
          }
          // Persist that the user knows this feature, so turning it off later
          // won't cause the nudge to reappear on the next archive.
          this.markNudgeShownIfUserKnowsFeature();
        }
        if (changes[StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN]) {
          this.hideArchivedNudgeShown =
            !!changes[StorageKeys.FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN].newValue;
          if (this.hideArchivedNudgeShown && this.containerElement) {
            unmountHideArchivedNudge(this.containerElement);
          }
        }
        if (changes[StorageKeys.GV_FOLDER_TREE_INDENT]) {
          this.applyFolderTreeIndentSetting(changes[StorageKeys.GV_FOLDER_TREE_INDENT].newValue);
        }
        if (changes[StorageKeys.FOLDER_CONVERSATION_SORT_MODE]) {
          this.applyConversationSortMode(
            changes[StorageKeys.FOLDER_CONVERSATION_SORT_MODE].newValue,
          );
        }
        if (changes[StorageKeys.FOLDER_PROJECT_ENABLED]) {
          this.folderProjectEnabled = changes[StorageKeys.FOLDER_PROJECT_ENABLED].newValue === true;
        }
        if (changes[StorageKeys.GV_FOLDER_BELOW_PROJECTS]) {
          const next = changes[StorageKeys.GV_FOLDER_BELOW_PROJECTS].newValue === true;
          if (next !== this.folderBelowProjects) {
            this.folderBelowProjects = next;
            this.debug('Folder below-projects setting changed:', next);
            // Remount only matters for the sidebar layout. In floating mode the
            // sidebar panel isn't mounted, so just remember the new value.
            if (this.folderEnabled && !this.floatingModeEnabled) {
              this.reinitializeFolderUI();
            }
          }
        }
        if (changes[StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED]) {
          void (async () => {
            const nextEnabled = await accountIsolationService.isIsolationEnabled({
              platform: 'chatgpt',
              pageUrl: window.location.href,
            });
            await this.handleAccountIsolationToggle(nextEnabled);
          })();
        }
        // Listen for language changes and update UI text
        if (changes[StorageKeys.LANGUAGE]) {
          this.debug('Language changed, updating UI text...');
          this.updateHeaderLanguageText();
        }
      }
      // Also listen for language changes from local storage (fallback)
      if (areaName === 'local' && changes[StorageKeys.LANGUAGE]) {
        this.debug('Language changed (local), updating UI text...');
        this.updateHeaderLanguageText();
      }
      if (areaName === 'local' && changes[StorageKeys.FOLDERS_COLLAPSED]) {
        const next = changes[StorageKeys.FOLDERS_COLLAPSED].newValue === true;
        if (next !== this.foldersCollapsed) {
          this.foldersCollapsed = next;
          this.applyFoldersCollapsedState();
        }
      }
      if (areaName === 'local' && changes[StorageKeys.FOLDERS_HIDDEN]) {
        const next = changes[StorageKeys.FOLDERS_HIDDEN].newValue === true;
        if (next !== this.foldersHidden) {
          this.foldersHidden = next;
          this.applyFoldersHiddenState();
        }
      }
      // Listen for folder data changes from local import/restore actions.
      if (areaName === 'local' && changes[this.activeStorageKey]) {
        const changedValue = changes[this.activeStorageKey].newValue;
        let changedData: FolderData | null = null;
        try {
          const decoded =
            typeof changedValue === 'string' ? JSON.parse(changedValue) : changedValue;
          changedData = isValidFolderData(decoded) ? decoded : null;
        } catch {
          changedData = null;
        }

        if (changedData && areJsonValuesEqual(changedData, this.data)) {
          this.debug('Ignoring matching folder storage echo');
          return;
        }

        if (this.savePromise || this.saveDirty) {
          // Never let an older self-write (or an external write racing our
          // verified flush) replace newer in-memory CRUD. Re-queue the latest
          // immutable snapshot so local state remains authoritative.
          this.debug('Folder data changed during a pending save; re-queueing latest snapshot');
          void this.saveData();
          return;
        }

        this.debug('Folder data changed in chrome.storage.local, reloading...');
        void this.reloadFoldersFromStorage();
      }
    };
    browser.storage.onChanged.addListener(this.storageChangeListener);

    // Perform migration from legacy settings
    void this.performMigration();
  }

  /**
   * Reload folder data from chrome.storage.local and refresh UI
   */
  private async reloadFoldersFromStorage(): Promise<boolean> {
    if (this.savePromise || this.saveDirty) {
      this.debug('Skipped folder reload while local data is awaiting a verified save');
      return false;
    }

    try {
      await this.loadData();
      this.renderAllFolders();
      this.debug('Folders reloaded from storage');
      return true;
    } catch (error) {
      console.error('[FolderManager] Failed to reload folders:', error);
      return false;
    }
  }

  /**
   * Migrate legacy settings
   */
  private async performMigration(): Promise<void> {
    try {
      const result = await chrome.storage.local.get('gvSyncMode');
      // Migration: Auto sync is deprecated, switch to manual
      if (result.gvSyncMode === 'auto') {
        console.log('[FolderManager] Migrating legacy "auto" sync mode to "manual"');
        await chrome.storage.local.set({ gvSyncMode: 'manual' });
      }
    } catch (error) {
      console.error('[FolderManager] Migration failed:', error);
    }
  }

  private applyFolderEnabledSetting(): void {
    if (this.folderEnabled) {
      // If folder UI doesn't exist yet, initialize it
      if (!this.containerElement) {
        this.debug('Folder feature enabled, initializing UI');
        this.initializeFolderUI().catch((error) => {
          console.error('[FolderManager] Failed to initialize folder UI:', error);
        });
      } else {
        // UI already exists, sync it with the actual responsive sidebar state.
        this.updateVisibilityBasedOnSideNav();
        this.debug('Folder feature enabled');
      }
    } else {
      // Hide the folder UI if it exists
      if (this.containerElement) {
        this.containerElement.style.display = 'none';
        this.debug('Folder feature disabled');
      }
    }
  }

  private applyHideArchivedSetting(): void {
    if (!this.sidebarContainer) return;

    const conversations = getChatGptConversationElements(this.sidebarContainer);
    conversations.forEach((conv) => {
      this.applyHideArchivedToConversation(conv as HTMLElement);
    });
  }

  /**
   * Apply hide archived setting to a single conversation element
   */
  private applyHideArchivedToConversation(conv: HTMLElement): void {
    const convId = this.extractConversationId(conv);
    const isArchived = this.isConversationInFolders(convId);

    if (this.hideArchivedConversations && isArchived) {
      conv.classList.add('gv-conversation-archived');
    } else {
      conv.classList.remove('gv-conversation-archived');
    }
  }

  private isConversationInFolders(conversationId: string): boolean {
    // Check if conversation exists in any folder
    for (const folderId in this.data.folderContents) {
      const conversations = this.data.folderContents[folderId];
      if (
        conversations.some((c) => {
          // Direct ID match
          if (c.conversationId === conversationId) return true;

          // Robustness fallback: check if one ID contains the other (e.g. c_ prefix mismatch)
          // or if URL contains the ID (common if one is hex and other is full ID)
          const cleanId = conversationId.replace(/^c_/, '');
          const cleanStoredId = c.conversationId.replace(/^c_/, '');

          if (cleanId && cleanId === cleanStoredId) return true;

          // Check if URL contains the hex ID
          if (cleanId && cleanId.length > 8 && c.url.includes(cleanId)) return true;

          return false;
        })
      ) {
        return true;
      }
    }
    return false;
  }

  private generateId(): string {
    return `folder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  private navigateToConversationById(folderId: string, conversationId: string): void {
    // Look up the latest conversation data from storage
    const conv = this.data.folderContents[folderId]?.find(
      (c) => c.conversationId === conversationId,
    );
    if (!conv) {
      console.error('[FolderManager] Conversation not found');
      return;
    }

    this.debug('Navigating to conversation:', { title: conv.title, url: conv.url });

    this.navigateToConversation(conv.url, conv);
  }

  private isSameConversation(targetId: string, conversation: ConversationReference): boolean {
    if (conversation.conversationId === targetId) return true;

    const cleanId = targetId.replace(/^c_/, '');
    const cleanStoredId = conversation.conversationId.replace(/^c_/, '');

    if (cleanId && cleanId === cleanStoredId) return true;

    if (cleanId && cleanId.length > 8 && conversation.url.includes(cleanId)) return true;

    return false;
  }

  private markConversationAsRecentlyOpened(conversationId: string): void {
    const now = Date.now();
    let changed = false;

    for (const folderId in this.data.folderContents) {
      const conversations = this.data.folderContents[folderId];
      conversations.forEach((conversation) => {
        if (!this.isSameConversation(conversationId, conversation)) return;

        // De-duplicate near-simultaneous route/listener updates.
        if (conversation.lastOpenedAt && now - conversation.lastOpenedAt < 1000) return;

        conversation.lastOpenedAt = now;
        conversation.updatedAt = now;
        changed = true;
      });
    }

    if (!changed) return;

    void this.saveData();

    if (this.folderEnabled && this.containerElement) {
      this.renderAllFolders();
    }
  }

  private normalizeConversationId(value: string | null | undefined): string | null {
    return normalizeChatGptConversationId(value);
  }

  private extractConversationIdFromHref(href: string | null | undefined): string | null {
    if (!href) return null;

    try {
      return extractChatGptConversationIdFromUrl(href);
    } catch (error) {
      this.debug('Failed to extract conversation id from href:', error);
    }

    return null;
  }

  /**
   * Extract conversation info from the current page URL and top-bar title.
   * Used exclusively for the top-right conversation header menu (not sidebar).
   *
   * Returns null ONLY when the URL does not contain a valid conversation ID,
   * in which case injection is skipped entirely.
   * Title always has a fallback 鈥?never returns null for title.
   */
  private extractConversationInfoFromPage(): { id: string; title: string; url: string } | null {
    let url: string;
    try {
      url = window.location.href;
    } catch {
      this.debugWarn('extractConversationInfoFromPage: failed to read location.href');
      return null;
    }

    const id = extractChatGptConversationIdFromUrl(url);
    if (!id) {
      this.debug('extractConversationInfoFromPage: no valid conversation ID in URL');
      return null;
    }
    // --- Defensive title extraction ---
    // ChatGPT can update titles asynchronously; try selectors first, then document.title.
    const titleSelectors = ['[data-testid="conversation-title"]', 'main h1', 'header h1'];

    // Placeholder strings ChatGPT may show before the chat is auto-titled.
    const DISALLOWED_TITLES = new Set(['', 'ChatGPT', 'New chat', '\u65b0\u5bf9\u8bdd']);

    let title: string | null = null;
    for (const sel of titleSelectors) {
      try {
        const el = document.querySelector(sel);
        const text = el?.textContent?.trim();
        if (text && !DISALLOWED_TITLES.has(text)) {
          title = text;
          break;
        }
      } catch {
        // Continue to next selector
      }
    }

    // Fallback 1: document.title
    if (!title) {
      try {
        const docTitle = document.title?.trim();
        if (docTitle) {
          const cleaned = docTitle.replace(/\s+-\s*(?:ChatGPT|OpenAI)\s*$/i, '').trim();
          if (cleaned && !DISALLOWED_TITLES.has(cleaned)) {
            title = cleaned;
          }
        }
      } catch {
        // Continue to default
      }
    }

    // Fallback 2: safe default; never return empty/null title
    if (!title) {
      title = 'Untitled';
    }

    this.debug('extractConversationInfoFromPage:', { id, title, url });
    return { id, title, url };
  }

  private findNativeConversationLinkById(conversationId: string): HTMLAnchorElement | null {
    const normalizedId = this.normalizeConversationId(conversationId);
    if (!normalizedId) return null;

    const sidebar = this.sidebarContainer;
    if (!sidebar?.isConnected) return null;

    const historyRoot =
      this.recentSection?.isConnected && sidebar.contains(this.recentSection)
        ? this.recentSection
        : findChatGptHistoryContainer(sidebar);
    if (!historyRoot || (historyRoot !== sidebar && !sidebar.contains(historyRoot))) return null;

    const originProbe = sanitizeFolderConversationUrl(`/c/${normalizedId}`);
    if (!originProbe) return null;
    const trustedOrigin = new URL(originProbe.url).origin;
    const links = Array.from(historyRoot.querySelectorAll<HTMLAnchorElement>('a[href*="/c/"]'));

    for (const link of links) {
      if (link.closest('.gv-folder-container, .gv-floating-folder-panel')) continue;

      const rawHref = link.getAttribute('href');
      if (!rawHref) continue;

      let candidateUrl: URL;
      try {
        candidateUrl = new URL(rawHref, `${trustedOrigin}/`);
      } catch {
        continue;
      }
      if (candidateUrl.origin !== trustedOrigin) continue;

      const candidate = sanitizeFolderConversationUrl(candidateUrl.href, trustedOrigin);
      if (candidate?.conversationId === normalizedId) return link;
    }

    return null;
  }

  private triggerNativeConversationClick(target: HTMLElement): void {
    const options = { bubbles: true, cancelable: true };
    target.dispatchEvent(new MouseEvent('pointerdown', options));
    target.dispatchEvent(new MouseEvent('mousedown', options));
    target.dispatchEvent(new MouseEvent('mouseup', options));
    target.dispatchEvent(new MouseEvent('click', options));
  }

  private navigateWithFullReload(url: string): void {
    const safeTarget = sanitizeFolderConversationUrl(url);
    if (!safeTarget) {
      this.debugWarn('Blocked unsafe folder conversation navigation target');
      return;
    }
    window.location.assign(safeTarget.url);
  }

  private navigateToConversation(url: string, conversation?: ConversationReference): void {
    const safeTarget = sanitizeFolderConversationUrl(url);
    if (!safeTarget) {
      this.debugWarn('Blocked unsafe folder conversation navigation target');
      return;
    }

    // Prefer ChatGPT's native link so its SPA router can manage the transition.
    try {
      const hexId = safeTarget.conversationId;
      const currentConversationId = this.getCurrentConversationId();
      const navigationUrl = safeTarget.url;
      const hardNavigate = () => {
        this.markConversationAsRecentlyOpened(hexId);

        this.navigateWithFullReload(navigationUrl);
      };

      if (currentConversationId === hexId) {
        this.highlightActiveConversationInFolders();
        return;
      }

      const sidebarLink = this.findNativeConversationLinkById(hexId);
      if (!sidebarLink) {
        this.debug('Sidebar link not found, falling back to location.assign');
        hardNavigate();
        return;
      }

      this.triggerNativeConversationClick(sidebarLink);
      this.debug('Triggered native sidebar link click');

      window.setTimeout(() => {
        if (this.getCurrentConversationId() === hexId) {
          this.highlightActiveConversationInFolders();

          if (conversation) {
            const syncedTitle = this.syncConversationTitleFromNative(hexId);
            if (syncedTitle && syncedTitle !== conversation.title) {
              this.updateConversationTitle(hexId, syncedTitle);
              this.debug('Updated conversation title after navigation:', syncedTitle);
            }
          }
          return;
        }

        this.debug('Native sidebar click did not navigate, falling back to location.assign');
        hardNavigate();
      }, FOLDER_NAVIGATION_CONFIRM_DELAY_MS);
    } catch (error) {
      console.error('[FolderManager] Navigation error:', error);
      this.navigateWithFullReload(safeTarget.url);
    }
  }

  private renderAllFolders(): void {
    if (!this.containerElement) return;

    // Find the existing folders list
    const existingList = this.containerElement.querySelector('.gv-folder-list');
    if (!existingList) return;

    // Create a new folders list
    const newList = this.createFoldersList();

    // Replace the old list with the new one
    existingList.replaceWith(newList);

    this.debug('Re-rendered all folders');

    // Ensure active conversation remains highlighted after full re-render
    this.highlightActiveConversationInFolders();
  }

  private installRouteChangeListener(): void {
    const update = () => {
      if (this.isDestroyed) return;
      setTimeout(() => {
        this.highlightActiveConversationInFolders();
        const currentConversationId = this.getCurrentConversationId();
        if (currentConversationId) {
          this.markConversationAsRecentlyOpened(currentConversationId);
        }
        // Some routes (e.g. /library since the 2026-07 redesign) re-render the
        // sidebar wholesale, detaching the folder container and orphaning its
        // observers. Run the DOM-recovery pass on every route change so the
        // panel comes back without waiting for a window resize.
        this.domRecoveryCheck?.();
      }, 0);
    };

    const cleanupFns: (() => void)[] = [];

    try {
      window.addEventListener('popstate', update);
      cleanupFns.push(() => window.removeEventListener('popstate', update));
    } catch (e) {
      this.debug('Failed to add popstate listener:', e);
    }

    try {
      const hist = history as History & Record<string, unknown>;
      const originalPushState = hist.pushState;
      const originalReplaceState = hist.replaceState;

      const wrap = (
        method: 'pushState' | 'replaceState',
        original: (...args: unknown[]) => unknown,
      ) => {
        hist[method] = function (...args: unknown[]) {
          const ret = original.apply(this, args);
          try {
            update();
          } catch {
            /* Ignore - update is non-critical */
          }
          return ret;
        };
      };
      wrap('pushState', originalPushState as (...args: unknown[]) => unknown);
      wrap('replaceState', originalReplaceState as (...args: unknown[]) => unknown);

      cleanupFns.push(() => {
        hist.pushState = originalPushState;
        hist.replaceState = originalReplaceState;
      });
    } catch (e) {
      this.debug('Failed to wrap history methods:', e);
    }

    // Fallback poller for routers/flows that don't emit events
    try {
      this.lastPathname = window.location.pathname;
      this.navPoller = window.setInterval(() => {
        if (this.isDestroyed) {
          if (this.navPoller) clearInterval(this.navPoller);
          return;
        }
        const now = window.location.pathname;
        if (now !== this.lastPathname) {
          this.lastPathname = now;
          update();
        }
      }, 400);
    } catch (e) {
      this.debug('Failed to setup navigation poller:', e);
    }

    this.routeChangeCleanup = () => {
      cleanupFns.forEach((fn) => fn());
      if (this.navPoller) {
        clearInterval(this.navPoller);
        this.navPoller = null;
      }
    };
  }

  private installSidebarClickListener(): void {
    // Capture clicks in ChatGPT's native sidebar and update highlight after navigation happens
    const root = this.sidebarContainer;
    if (!root) return;

    this.sidebarClickListener = (e: Event) => {
      if (this.isDestroyed) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const a = target.closest('a[href*="/c/"]') as HTMLAnchorElement | null;
      if (a) {
        setTimeout(() => this.highlightActiveConversationInFolders(), 0);
      }
    };

    try {
      root.addEventListener('click', this.sidebarClickListener, true);
    } catch (e) {
      this.debug('Failed to add sidebar click listener:', e);
    }
  }

  private t(key: string): string {
    // Use the centralized i18n system that respects user's language preference
    return getTranslationSyncUnsafe(key);
  }

  private getImportValidationMessage(error: ValidationError): string {
    switch (error.type) {
      case ValidationErrorType.INVALID_VERSION:
        return this.t('folder_import_invalid_version');
      case ValidationErrorType.MISSING_DATA:
        return this.t('folder_import_missing_data');
      case ValidationErrorType.CORRUPTED_DATA:
        return this.t('folder_import_corrupted_data');
      case ValidationErrorType.INVALID_FORMAT:
      default:
        return this.t('folder_import_invalid_format');
    }
  }

  /** Commit imported data only after the authoritative adapter verifies it. */
  private async persistImportedData(nextData: FolderData): Promise<boolean> {
    const previousData = this.cloneFolderData(this.data);
    this.data = this.cloneFolderData(nextData);

    let saved = false;
    let importedRevision = this.saveRevision;
    let importedSnapshot = this.cloneFolderData(this.data);
    try {
      const saveAttempt = this.saveData();
      importedRevision = this.saveRevision;
      importedSnapshot = this.cloneFolderData(this.data);
      saved = await saveAttempt;
    } catch {
      saved = false;
    }

    if (saved) return true;

    const importIsStillLatest =
      this.saveRevision === importedRevision && areJsonValuesEqual(this.data, importedSnapshot);
    if (importIsStillLatest) {
      // Roll back only when no CRUD joined the shared save promise. Queue and
      // verify the rollback as a normal save; a failed rollback remains dirty
      // for the next mutation/retry instead of claiming success.
      this.data = previousData;
      try {
        await this.saveData();
      } catch {
        // saveData normally resolves false; retain the rollback snapshot dirty
        // if an adapter unexpectedly rejects.
      }
    }

    this.refresh();
    this.showNotification(this.t('folder_import_save_failed'), 'error');
    return false;
  }

  /**
   * Update all translatable text in the folder header when language changes
   */
  private updateHeaderLanguageText(): void {
    if (!this.containerElement) return;

    // Update folder title
    const title = this.containerElement.querySelector('.gv-folder-header .title');
    if (title) {
      title.textContent = this.t('folder_title');
    }

    // Update button tooltips in header actions
    const actionsContainer = this.containerElement.querySelector('.gv-folder-header-actions');
    if (actionsContainer) {
      const buttons = actionsContainer.querySelectorAll('button');
      buttons.forEach((btn) => {
        if (btn.classList.contains('gv-folder-add-btn')) {
          btn.title = this.t('folder_create');
        } else if (btn.classList.contains('gv-folder-visibility-toggle')) {
          btn.title = this.t(
            this.foldersHidden ? 'folder_show_section' : 'folder_hide_section',
          );
        } else if (btn.classList.contains('gv-folder-import-export-btn')) {
          btn.title = this.t('folder_import_export');
        } else if (btn.classList.contains('gv-folder-settings-btn')) {
          btn.title = this.t('folder_settings');
        }
        if (btn.title) btn.setAttribute('aria-label', btn.title);
      });
    }

    const search = this.containerElement.querySelector<HTMLElement>('.gv-folder-search');
    const input = search?.querySelector<HTMLInputElement>('.gv-folder-search-input');
    const badge = search?.querySelector<HTMLElement>('.gv-folder-search-mode-badge');
    if (search && input && badge) this.updateFolderSearchInputState(search, input, badge);
    this.applyFoldersCollapsedState();
    this.applyFoldersHiddenState();

    // Update empty state text if present
    const emptyState = this.containerElement.querySelector('.gv-folder-empty');
    if (emptyState) {
      emptyState.textContent = this.t(
        this.isFolderSearchActive() ? 'folder_search_empty' : 'folder_empty',
      );
    }

    this.debug('Header language text updated');
  }

  private setupMessageListener(): void {
    if (this.runtimeMessageListener) return;

    const listener: FolderRuntimeMessageListener = (message, _sender, sendResponse) => {
      const msg = message as Record<string, unknown>;
      // Handle request for current folder data
      if (msg.type === 'gv.sync.requestData') {
        this.debug('Received request for folder data from popup');
        sendResponse({
          ok: true,
          data: this.data,
          accountScope: this.toSyncAccountScope(this.accountScope),
        });
        return undefined;
      }

      if (msg.type === 'gv.folders.reload') {
        this.debug('Received reload request');
        void this.reloadFoldersFromStorage().then((ok) => sendResponse({ ok }));
        return true as const;
      }

      if (msg.type === 'gv.account.getContext') {
        const context = detectAccountContextFromDocument(window.location.href, document);
        sendResponse({ ok: true, context });
        return undefined;
      }

      // Handle request to collect all conversations and folder structure for AI organization
      if (msg.type === 'gv.folders.getStructureForAI') {
        this.debug('Received AI structure request');
        const sidebarConversations = this.collectAllSidebarConversations();
        sendResponse({
          ok: true,
          sidebarConversations,
          folderData: this.data,
        });
        return undefined;
      }

      return undefined;
    };
    this.runtimeMessageListener = listener;
    browser.runtime.onMessage.addListener(listener as browser.Runtime.OnMessageListener);
  }

  /**
   * Collect all conversation titles and URLs from the native sidebar DOM
   */
  private collectAllSidebarConversations(): Array<{
    id: string;
    title: string;
    url: string;
  }> {
    const results: Array<{ id: string; title: string; url: string }> = [];
    const conversationEls = getChatGptConversationElements(document);

    for (const el of Array.from(conversationEls)) {
      const htmlEl = el;
      const id = this.extractNativeConversationId(htmlEl);
      const title = this.extractNativeConversationTitle(htmlEl);
      const url = this.extractNativeConversationUrl(htmlEl);
      if (id && title && url) {
        results.push({ id, title, url });
      }
    }

    return results;
  }

  // Tooltip methods
  private createTooltip(): void {
    this.tooltipElement = document.createElement('div');
    this.tooltipElement.className = 'gv-tooltip';
    document.body.appendChild(this.tooltipElement);
  }

  private showTooltip(element: HTMLElement, text: string): void {
    if (!this.tooltipElement) return;

    // Clear any existing timeout
    if (this.tooltipTimeout) {
      clearTimeout(this.tooltipTimeout);
    }

    // Check if text is truncated
    const isTruncated = element.scrollWidth > element.clientWidth;
    if (!isTruncated) return;

    // Show tooltip after a short delay (200ms)
    this.tooltipTimeout = window.setTimeout(() => {
      if (!this.tooltipElement) return;

      this.tooltipElement.textContent = text;

      // Position tooltip
      const rect = element.getBoundingClientRect();
      const tooltipRect = this.tooltipElement.getBoundingClientRect();

      let left = rect.left;
      let top = rect.bottom + 8;

      // Adjust if tooltip goes off screen
      if (left + tooltipRect.width > window.innerWidth) {
        left = window.innerWidth - tooltipRect.width - 10;
      }
      if (top + tooltipRect.height > window.innerHeight) {
        top = rect.top - tooltipRect.height - 8;
      }

      this.tooltipElement.style.left = `${left}px`;
      this.tooltipElement.style.top = `${top}px`;

      // Trigger reflow for animation
      this.tooltipElement.offsetHeight;
      this.tooltipElement.classList.add('show');
    }, 200);
  }

  private hideTooltip(): void {
    if (this.tooltipTimeout) {
      clearTimeout(this.tooltipTimeout);
      this.tooltipTimeout = null;
    }
    if (this.tooltipElement) {
      this.tooltipElement.classList.remove('show');
    }
  }

  // Export/Import methods
  private exportFolders(): void {
    // Prevent concurrent exports
    if (this.exportInProgress) {
      this.showNotification(
        this.t('folder_export_in_progress') || 'Export already in progress',
        'info',
      );
      return;
    }

    this.exportInProgress = true;

    try {
      // Type assertion to match the service's expected type
      const payload = FolderImportExportService.exportToPayload(
        this.data as unknown as Parameters<typeof FolderImportExportService.exportToPayload>[0],
      );
      FolderImportExportService.downloadJSON(payload);
      this.showNotification(this.t('folder_export_success'), 'success');
      this.debug('Folders exported successfully');
    } catch (error) {
      console.error('[FolderManager] Export error:', error);
      this.showNotification(
        this.t('folder_import_error').replace('{error}', String(error)),
        'error',
      );
    } finally {
      // Always release the lock
      this.exportInProgress = false;
    }
  }

  private showImportDialog(): void {
    if (this.activeImportDialog && !this.activeImportDialog.isConnected) {
      this.activeImportDialog = null;
    }

    // Prevent creating multiple import dialogs simultaneously
    if (this.activeImportDialog) return;

    // Create dialog overlay
    const overlay = document.createElement('div');
    overlay.className = 'gv-folder-dialog-overlay';

    // Create dialog
    const dialog = document.createElement('div');
    dialog.className = 'gv-folder-import-dialog';

    // Dialog title
    const dialogTitle = document.createElement('div');
    dialogTitle.className = 'gv-folder-dialog-title';
    dialogTitle.textContent = this.t('folder_import_title');

    // Strategy selection
    const strategyContainer = document.createElement('div');
    strategyContainer.className = 'gv-folder-import-strategy';

    const strategyLabel = document.createElement('div');
    strategyLabel.className = 'gv-folder-import-strategy-label';
    strategyLabel.textContent = this.t('folder_import_strategy');

    const strategyOptions = document.createElement('div');
    strategyOptions.className = 'gv-folder-import-strategy-options';

    const mergeOption = this.createRadioOption('merge', this.t('folder_import_merge'), true);
    const overwriteOption = this.createRadioOption(
      'overwrite',
      this.t('folder_import_overwrite'),
      false,
    );

    strategyOptions.appendChild(mergeOption);
    strategyOptions.appendChild(overwriteOption);

    strategyContainer.appendChild(strategyLabel);
    strategyContainer.appendChild(strategyOptions);

    // File input
    const fileInputContainer = document.createElement('div');
    fileInputContainer.className = 'gv-folder-import-file-input';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.style.display = 'none';

    const fileButton = document.createElement('button');
    fileButton.className = 'gv-folder-import-file-button';
    fileButton.textContent = this.t('folder_import_select_file');
    fileButton.addEventListener('click', () => fileInput.click());

    const fileName = document.createElement('div');
    fileName.className = 'gv-folder-import-file-name';
    fileName.textContent = '';

    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) {
        fileName.textContent = fileInput.files[0].name;
      }
    });

    fileInputContainer.appendChild(fileInput);
    fileInputContainer.appendChild(fileButton);
    fileInputContainer.appendChild(fileName);

    // Paste JSON section
    const pasteContainer = document.createElement('div');
    pasteContainer.className = 'gv-folder-import-paste-container';

    const pasteToggleBtn = document.createElement('button');
    pasteToggleBtn.className = 'gv-folder-import-paste-toggle';
    pasteToggleBtn.textContent = this.t('folder_import_paste_json');
    let pasteExpanded = false;

    const pasteArea = document.createElement('textarea');
    pasteArea.className = 'gv-folder-import-paste-area';
    pasteArea.placeholder = this.t('folder_import_paste_placeholder');
    pasteArea.style.display = 'none';

    pasteToggleBtn.addEventListener('click', () => {
      pasteExpanded = !pasteExpanded;
      pasteArea.style.display = pasteExpanded ? 'block' : 'none';
      pasteToggleBtn.classList.toggle('gv-folder-import-paste-toggle-active', pasteExpanded);
    });

    pasteContainer.appendChild(pasteToggleBtn);
    pasteContainer.appendChild(pasteArea);

    // Buttons
    const buttonsContainer = document.createElement('div');
    buttonsContainer.className = 'gv-folder-dialog-buttons';

    const importBtn = document.createElement('button');
    importBtn.className = 'gv-folder-dialog-btn gv-folder-dialog-btn-primary';
    importBtn.textContent = this.t('pm_import');
    importBtn.addEventListener('click', async () => {
      const strategy = (mergeOption.querySelector('input') as HTMLInputElement).checked
        ? 'merge'
        : 'overwrite';
      const pasteText = pasteArea.value.trim();
      if (pasteText) {
        await this.handleImportFromText(pasteText, strategy);
      } else {
        await this.handleImport(fileInput, strategy);
      }
      this.closeActiveImportDialog();
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'gv-folder-dialog-btn gv-folder-dialog-btn-secondary';
    cancelBtn.textContent = this.t('pm_cancel');
    cancelBtn.addEventListener('click', () => {
      this.closeActiveImportDialog();
    });

    buttonsContainer.appendChild(cancelBtn);
    buttonsContainer.appendChild(importBtn);

    // Assemble dialog
    dialog.appendChild(dialogTitle);
    dialog.appendChild(strategyContainer);
    dialog.appendChild(fileInputContainer);
    dialog.appendChild(pasteContainer);
    dialog.appendChild(buttonsContainer);
    overlay.appendChild(dialog);

    // Add to body
    document.body.appendChild(overlay);

    // Track this dialog as the active one
    this.activeImportDialog = overlay;

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        this.closeActiveImportDialog();
      }
    });
  }

  private createRadioOption(value: string, label: string, checked: boolean): HTMLElement {
    const container = document.createElement('label');
    container.className = 'gv-folder-import-radio-option';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'import-strategy';
    radio.value = value;
    radio.checked = checked;

    const labelText = document.createElement('span');
    labelText.textContent = label;

    container.appendChild(radio);
    container.appendChild(labelText);

    return container;
  }

  private async handleImport(fileInput: HTMLInputElement, strategy: ImportStrategy): Promise<void> {
    // Prevent concurrent imports to avoid data corruption
    if (this.importInProgress) {
      this.showNotification(
        this.t('folder_import_in_progress') || 'Import already in progress',
        'info',
      );
      return;
    }

    this.importInProgress = true;

    try {
      if (!fileInput.files || fileInput.files.length === 0) {
        this.showNotification(this.t('folder_import_select_file'), 'error');
        return;
      }

      const file = fileInput.files[0];

      // Confirm overwrite if strategy is overwrite
      if (strategy === 'overwrite') {
        const confirmed = confirm(this.t('folder_import_confirm_overwrite'));
        if (!confirmed) {
          return;
        }
      }

      // Read and parse file
      const readResult = await FolderImportExportService.readJSONFile(file);
      if (!readResult.success) {
        this.showNotification(this.t('folder_import_invalid_format'), 'error');
        return;
      }

      // Validate payload
      const validationResult = FolderImportExportService.validatePayload(readResult.data);
      if (!validationResult.success) {
        this.showNotification(this.getImportValidationMessage(validationResult.error), 'error');
        return;
      }

      // Import data (now async with concurrency protection)
      const importResult = await FolderImportExportService.importFromPayload(
        validationResult.data,
        this.data as unknown as Parameters<typeof FolderImportExportService.importFromPayload>[1],
        { strategy },
      );

      if (!importResult.success) {
        this.showNotification(
          this.t('folder_import_error').replace('{error}', String(importResult.error)),
          'error',
        );
        return;
      }

      if (!(await this.persistImportedData(importResult.data.data))) return;
      this.refresh();

      // Show success message
      const stats = importResult.data.stats;
      let message = this.t('folder_import_success')
        .replace('{folders}', String(stats.foldersImported))
        .replace('{conversations}', String(stats.conversationsImported));

      if (
        strategy === 'merge' &&
        (stats.duplicatesFoldersSkipped || stats.duplicatesConversationsSkipped)
      ) {
        const totalSkipped =
          (stats.duplicatesFoldersSkipped || 0) + (stats.duplicatesConversationsSkipped || 0);
        message = this.t('folder_import_success_skipped')
          .replace('{folders}', String(stats.foldersImported))
          .replace('{conversations}', String(stats.conversationsImported))
          .replace('{skipped}', String(totalSkipped));
      }

      this.showNotification(message, 'success');
      this.debug('Import successful:', stats);
    } catch (error) {
      console.error('[FolderManager] Import error:', error);
      this.showNotification(
        this.t('folder_import_error').replace('{error}', String(error)),
        'error',
      );
    } finally {
      // Always release the lock, even if an error occurred
      this.importInProgress = false;
    }
  }

  /**
   * Import folder data from pasted JSON text
   */
  private async handleImportFromText(jsonText: string, strategy: ImportStrategy): Promise<void> {
    if (this.importInProgress) {
      this.showNotification(
        this.t('folder_import_in_progress') || 'Import already in progress',
        'info',
      );
      return;
    }

    this.importInProgress = true;

    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        this.showNotification(this.t('folder_import_invalid_format'), 'error');
        return;
      }

      if (strategy === 'overwrite') {
        const confirmed = confirm(this.t('folder_import_confirm_overwrite'));
        if (!confirmed) return;
      }

      const validationResult = FolderImportExportService.validatePayload(parsed);
      if (!validationResult.success) {
        this.showNotification(this.getImportValidationMessage(validationResult.error), 'error');
        return;
      }

      const importResult = await FolderImportExportService.importFromPayload(
        validationResult.data,
        this.data as unknown as Parameters<typeof FolderImportExportService.importFromPayload>[1],
        { strategy },
      );

      if (!importResult.success) {
        this.showNotification(
          this.t('folder_import_error').replace('{error}', String(importResult.error)),
          'error',
        );
        return;
      }

      if (!(await this.persistImportedData(importResult.data.data))) return;
      this.refresh();

      const stats = importResult.data.stats;
      let message = this.t('folder_import_success')
        .replace('{folders}', String(stats.foldersImported))
        .replace('{conversations}', String(stats.conversationsImported));

      if (
        strategy === 'merge' &&
        (stats.duplicatesFoldersSkipped || stats.duplicatesConversationsSkipped)
      ) {
        const totalSkipped =
          (stats.duplicatesFoldersSkipped || 0) + (stats.duplicatesConversationsSkipped || 0);
        message = this.t('folder_import_success_skipped')
          .replace('{folders}', String(stats.foldersImported))
          .replace('{conversations}', String(stats.conversationsImported))
          .replace('{skipped}', String(totalSkipped));
      }

      this.showNotification(message, 'success');
      this.debug('Import from text successful:', stats);
    } catch (error) {
      console.error('[FolderManager] Import from text error:', error);
      this.showNotification(
        this.t('folder_import_error').replace('{error}', String(error)),
        'error',
      );
    } finally {
      this.importInProgress = false;
    }
  }

  private applyFoldersCollapsedState(): void {
    const container = this.containerElement;
    if (!container) return;

    container.classList.toggle('gv-folder-collapsed', this.foldersCollapsed);
    const button = container.querySelector<HTMLButtonElement>('.gv-folder-section-toggle');
    if (button) {
      const label = this.t(
        this.foldersCollapsed ? 'folder_search_expand' : 'folder_search_collapse',
      );
      button.title = label;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-expanded', String(!this.foldersCollapsed));
      button.replaceChildren(
        this.foldersCollapsed ? createChevronRightIcon(16) : createChevronDownIcon(16),
      );
    }
  }

  private applyFoldersHiddenState(): void {
    const container = this.containerElement;
    if (!container) return;

    container.classList.toggle('gv-folder-hidden', this.foldersHidden);
    const button = container.querySelector<HTMLButtonElement>('.gv-folder-visibility-toggle');
    const label = this.t(this.foldersHidden ? 'folder_show_section' : 'folder_hide_section');
    if (button) {
      button.title = label;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', String(this.foldersHidden));
      button.classList.toggle('gv-filter-active', this.foldersHidden);
      button.replaceChildren(this.foldersHidden ? createEyeOffIcon(18) : createEyeIcon(18));
    }

    const peekBar = container.querySelector<HTMLButtonElement>('.gv-folder-peek-bar');
    if (peekBar) {
      const showLabel = this.t('folder_show_section');
      peekBar.title = showLabel;
      peekBar.setAttribute('aria-label', showLabel);
      peekBar.setAttribute('aria-expanded', String(!this.foldersHidden));
    }
  }

  private async toggleFoldersCollapsed(): Promise<void> {
    this.foldersCollapsed = !this.foldersCollapsed;
    this.applyFoldersCollapsedState();
    try {
      await browser.storage.local.set({ [StorageKeys.FOLDERS_COLLAPSED]: this.foldersCollapsed });
    } catch (error) {
      console.error('[FolderManager] Failed to persist collapsed state:', error);
    }
  }

  private async toggleFoldersHidden(): Promise<void> {
    this.foldersHidden = !this.foldersHidden;
    this.applyFoldersHiddenState();
    try {
      await browser.storage.local.set({ [StorageKeys.FOLDERS_HIDDEN]: this.foldersHidden });
    } catch (error) {
      console.error('[FolderManager] Failed to persist hidden state:', error);
    }
  }

  private isFolderSearchActive(): boolean {
    return normalizeFolderSearchText(this.folderSearchQuery).length > 0;
  }

  private isFolderOnlySearchActive(): boolean {
    return this.isFolderSearchActive() && this.getFolderSearchCriteria().mode === 'folder';
  }

  private getFolderSearchCriteria(): FolderSearchCriteria {
    return parseFolderSearchCriteria(this.folderSearchQuery);
  }

  private matchesFolderSearchText(value: string): boolean {
    const { query } = this.getFolderSearchCriteria();
    return query.length === 0 || normalizeFolderSearchText(value).includes(query);
  }

  private filterVisibleConversations(
    conversations: ConversationReference[],
    includeForFolderOnlySearch = false,
  ): ConversationReference[] {
    if (!this.isFolderSearchActive()) return conversations;
    if (this.isFolderOnlySearchActive()) return includeForFolderOnlySearch ? conversations : [];
    return conversations.filter((conversation) => this.matchesFolderSearchText(conversation.title));
  }

  private matchesFolderSearchTree(folderId: string): boolean {
    if (!this.isFolderSearchActive()) return true;
    const folder = this.data.folders.find((candidate) => candidate.id === folderId);
    if (!folder) return false;
    if (this.matchesFolderSearchText(folder.name)) return true;
    if (this.filterVisibleConversations(this.data.folderContents[folderId] || []).length > 0) {
      return true;
    }
    return this.data.folders
      .filter((candidate) => candidate.parentId === folderId)
      .some((child) => this.matchesFolderSearchTree(child.id));
  }

  private applyConversationSortMode(value: unknown): void {
    const next: ConversationSortMode = value === 'recent' ? 'recent' : 'manual';
    if (next === this.conversationSortMode) return;
    this.conversationSortMode = next;
    this.refresh();
  }

  private setConversationSortMode(mode: ConversationSortMode): void {
    this.applyConversationSortMode(mode);
    void browser.storage.sync
      .set({ [StorageKeys.FOLDER_CONVERSATION_SORT_MODE]: mode })
      .catch((error) => {
        console.error('[FolderManager] Failed to persist conversation sort mode:', error);
      });
  }

  private showNotification(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `gv-notification gv-notification-${type}`;
    notification.textContent = message;

    // Add to body
    document.body.appendChild(notification);

    // Trigger animation
    setTimeout(() => notification.classList.add('show'), 10);

    // Remove after 3 seconds
    setTimeout(() => {
      notification.classList.remove('show');
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }

  private openTrackedHeaderMenu(event: MouseEvent, extraClass = ''): HTMLElement | null {
    event.stopPropagation();

    if (this.activeImportExportMenu && !this.activeImportExportMenu.isConnected) {
      this.activeImportExportMenu = null;
      this.removeActiveImportExportMenuCloseHandler();
    }

    if (this.activeImportExportMenu) {
      this.closeActiveImportExportMenu();
      return null;
    }

    const menu = document.createElement('div');
    menu.className = `gv-folder-menu${extraClass ? ` ${extraClass}` : ''}`;
    menu.style.position = 'fixed';
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    document.body.appendChild(menu);
    this.activeImportExportMenu = menu;

    const closeMenu = (clickEvent: MouseEvent) => {
      if (!menu.contains(clickEvent.target as Node)) this.closeActiveImportExportMenu();
    };
    this.activeImportExportMenuCloseHandler = closeMenu;
    this.activeImportExportMenuListenerTimeout = window.setTimeout(() => {
      document.addEventListener('click', closeMenu);
      this.activeImportExportMenuListenerTimeout = null;
    }, 0);

    return menu;
  }

  /** Show the existing local import/export actions in the shared header menu shell. */
  private showImportExportMenu(event: MouseEvent): void {
    const menu = this.openTrackedHeaderMenu(event);
    if (!menu) return;

    const menuItems = [
      {
        label: this.t('folder_import'),
        icon: '↑',
        action: () => this.showImportDialog(),
      },
      {
        label: this.t('folder_export'),
        icon: '↓',
        action: () => this.exportFolders(),
      },
    ];

    menuItems.forEach((item) => {
      const menuItem = document.createElement('button');
      menuItem.className = 'gv-folder-menu-item';
      const icon = document.createElement('span');
      icon.className = 'gv-folder-menu-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = item.icon;
      menuItem.append(icon, document.createTextNode(item.label));
      menuItem.addEventListener('click', () => {
        this.closeActiveImportExportMenu();
        item.action();
      });
      menu.appendChild(menuItem);
    });
  }

  private showFolderSettingsMenu(event: MouseEvent): void {
    const menu = this.openTrackedHeaderMenu(event, 'gv-folder-settings-menu');
    if (!menu) return;

    menu.appendChild(this.createConversationSortSettingsRow());
    const steppers = [
      {
        labelKey: 'folder_item_font_size',
        storageKey: StorageKeys.GV_FOLDER_ITEM_FONT_SIZE,
        min: 12,
        max: 18,
        defaultValue: 13,
        unit: 'px',
      },
      {
        labelKey: 'folderSpacing',
        storageKey: StorageKeys.GV_FOLDER_SPACING,
        min: 0,
        max: 16,
        defaultValue: 2,
      },
      {
        labelKey: 'folderTreeIndent',
        storageKey: StorageKeys.GV_FOLDER_TREE_INDENT,
        min: -8,
        max: 32,
        defaultValue: -8,
      },
    ];
    steppers.forEach((config) => menu.appendChild(this.createSettingsStepperRow(config)));
    menu.addEventListener('click', (clickEvent) => clickEvent.stopPropagation());
  }

  private createConversationSortSettingsRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'gv-folder-settings-row gv-folder-sort-settings-row';

    const label = document.createElement('span');
    label.className = 'gv-folder-settings-label';
    label.textContent = this.t('folder_sort');

    const options = document.createElement('div');
    options.className = 'gv-folder-sort-options';
    options.setAttribute('role', 'group');
    options.setAttribute('aria-label', label.textContent);

    const buttons = new Map<ConversationSortMode, HTMLButtonElement>();
    const render = () => {
      buttons.forEach((button, mode) => {
        const active = this.conversationSortMode === mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
      });
    };

    (['manual', 'recent'] as const).forEach((mode) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gv-folder-sort-option';
      button.textContent = this.t(mode === 'manual' ? 'folder_sort_manual' : 'folder_sort_recent');
      button.addEventListener('click', (clickEvent) => {
        clickEvent.stopPropagation();
        this.setConversationSortMode(mode);
        render();
      });
      buttons.set(mode, button);
      options.appendChild(button);
    });

    render();
    row.append(label, options);
    return row;
  }

  private createSettingsStepperRow(config: {
    labelKey: string;
    storageKey: string;
    min: number;
    max: number;
    defaultValue: number;
    unit?: string;
  }): HTMLElement {
    const { labelKey, storageKey, min, max, defaultValue, unit } = config;
    const clamp = (value: number) =>
      Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : defaultValue)));

    const row = document.createElement('div');
    row.className = 'gv-folder-settings-row';
    const label = document.createElement('span');
    label.className = 'gv-folder-settings-label';
    label.textContent = this.t(labelKey);

    const stepper = document.createElement('div');
    stepper.className = 'gv-folder-stepper';
    const minus = document.createElement('button');
    minus.className = 'gv-folder-stepper-btn';
    minus.type = 'button';
    minus.textContent = '−';
    minus.title = this.t('folder_item_font_size_decrease');
    const value = document.createElement('span');
    value.className = 'gv-folder-stepper-value';
    const plus = document.createElement('button');
    plus.className = 'gv-folder-stepper-btn';
    plus.type = 'button';
    plus.textContent = '+';
    plus.title = this.t('folder_item_font_size_increase');

    let current = defaultValue;
    const render = () => {
      value.textContent = unit ? `${current}${unit}` : String(current);
      minus.disabled = current <= min;
      plus.disabled = current >= max;
    };
    const persist = (next: number) => {
      current = clamp(next);
      render();
      void browser.storage.sync.set({ [storageKey]: current }).catch((error) => {
        console.warn(`[FolderManager] Failed to save ${storageKey}:`, error);
      });
    };

    minus.addEventListener('click', (clickEvent) => {
      clickEvent.stopPropagation();
      persist(current - 1);
    });
    plus.addEventListener('click', (clickEvent) => {
      clickEvent.stopPropagation();
      persist(current + 1);
    });
    void browser.storage.sync
      .get({ [storageKey]: defaultValue })
      .then((result) => {
        const raw = result[storageKey];
        const numeric = typeof raw === 'number' ? raw : Number(raw);
        current = clamp(numeric);
        render();
      })
      .catch(() => undefined);

    render();
    stepper.append(minus, value, plus);
    row.append(label, stepper);
    return row;
  }

  /**
   * Format a timestamp as relative time (e.g. "5 minutes ago")
   */
  private formatRelativeTime(timestamp: number | null): string {
    if (!timestamp) return '';
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) {
      return this.t('justNow');
    } else if (diffMins < 60) {
      return `${diffMins} ${this.t('minutesAgo')}`;
    } else if (diffHours < 24) {
      return `${diffHours} ${this.t('hoursAgo')}`;
    } else if (diffDays === 1) {
      return this.t('yesterday');
    } else {
      return new Date(timestamp).toLocaleDateString();
    }
  }
}
