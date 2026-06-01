import {
  type AccountScope,
  accountIsolationService,
  detectAccountContextFromDocument,
} from '@/core/services/AccountIsolationService';
import { keyboardShortcutService } from '@/core/services/KeyboardShortcutService';
import { storageService } from '@/core/services/StorageService';
import { StorageKeys, type TurnId } from '@/core/types/common';
import {
  buildConversationIdFromUrl,
  buildLegacyConversationIdFromUrl,
  buildRouteConversationIdFromUrl,
  extractConversationIdFromUrl,
} from '@/core/utils/conversationIdentity';
import { hashString } from '@/core/utils/hash';
import { GV_RTL_CLASS, applyRTLClass } from '@/core/utils/rtl';
import { installCachePrimerForManager } from '@/features/cachePrimer/CachePrimer';
import { getConversationCaptureService } from '@/features/conversationApi/ConversationCaptureService';

import { getTranslationSync, initI18n } from '../../../utils/i18n';
import { makeStableTurnId } from '../fork/turnId';
import { TimestampService } from '../timestamp/TimestampService';
import { eventBus } from './EventBus';
import { StarredMessagesService } from './StarredMessagesService';
import { TimelinePreviewPanel } from './TimelinePreviewPanel';
import {
  ATTACHMENT_COLOR,
  ATTACHMENT_LABEL,
  type AttachmentInfo,
  extractAttachments,
} from './attachments';
import {
  getTimelineHierarchyStorageKey,
  getTimelineHierarchyStorageKeysToRead,
  resolveTimelineHierarchyDataForStorageScope,
} from './hierarchyStorage';
import {
  type TimelineHierarchyConversationData,
  getLegacyTimelineCollapsedStorageKey,
  getLegacyTimelineLevelsStorageKey,
} from './hierarchyTypes';
import { findMatchingStarredMessages } from './starredLookup';
import type { StarredMessage, StarredMessagesData } from './starredTypes';
import { TurnTextCache, computeFingerprint } from './turnTextCache';
import type { DotElement, MarkerLevel } from './types';

/** Accessibility prefixes injected by ChatGPT's DOM that should be stripped from previews. */
const TURN_LABEL_PREFIXES =
  /^[\u200B\u200C\u200D\u200E\u200F\uFEFF]*(?:you said|you wrote|user message|your prompt|you asked)[:\s]*/i;
const VISUALLY_HIDDEN_CLASS_FRAGMENT = 'visually-hidden';
const INJECTED_UI_SELECTOR = '.gv-fork-btn, .gv-fork-confirm, .gv-fork-indicator-group';

/**
 * Selectors for ChatGPT-native UI chrome that we want to strip from any text
 * extracted off a user-turn element. Without this, the timeline dot tooltip
 * and preview panel pick up host-page button labels like "展开收起" and bake
 * them into our turn summaries.
 */
const HOST_CHROME_SELECTOR = [
  '[data-testid="collapsible-user-message-toggle"]',
  '[class*="toggleControl"]',
  '[class*="showMoreLabel"]',
  '[class*="showLessLabel"]',
].join(',');

type ExtGlobal = typeof globalThis & {
  chrome?: {
    storage?: {
      sync?: {
        get(k: Record<string, unknown>, cb: (items: Record<string, unknown>) => void): void;
        set?(items: Record<string, unknown>): void;
      };
      onChanged?: {
        addListener(
          cb: (changes: Record<string, { newValue: unknown }>, area: string) => void,
        ): void;
      };
    };
    runtime?: { lastError?: { message: string } };
  };
  browser?: {
    storage?: {
      sync?: {
        get(k: Record<string, unknown>): Promise<Record<string, unknown>>;
        set?(items: Record<string, unknown>): void;
      };
      onChanged?: {
        addListener(
          cb: (changes: Record<string, { newValue: unknown }>, area: string) => void,
        ): void;
      };
    };
  };
};

interface TimelineManagerOptions {
  previousUrl?: string | null;
}

interface TimelineTextPin {
  id: string;
  turnId: string;
  xRatio: number;
  xOffset: number;
  yRatio: number;
  yOffset: number;
  text: string;
  createdAt: number;
}

type TimelineTextPinTarget = {
  marker: {
    id: string;
    element: HTMLElement;
  };
  xOffset: number;
  xRatio: number;
  yOffset: number;
};

export class TimelineManager {
  private scrollContainer: HTMLElement | null = null;
  private conversationContainer: HTMLElement | null = null;
  private markers: Array<{
    id: string;
    element: HTMLElement;
    summary: string;
    n: number;
    baseN: number;
    dotElement: DotElement | null;
    starred: boolean;
    attachments: ReadonlyArray<AttachmentInfo>;
    hasGeneratedImage: boolean;
  }> = [];
  /**
   * Per-conversation summary/attachment cache keyed by turnId. ChatGPT's
   * virtualisation collapses the inner `[data-message-author-role]` body
   * when a turn is far off-screen but keeps the outer
   * `<section data-testid="conversation-turn-N">` in the DOM with a stable
   * offsetTop and data-turn-id. We use that outer wrapper as
   * `marker.element` so the marker itself never goes missing — this cache
   * fills in the *content* (summary, attachments, generated-image flag) so
   * the timeline tooltip / preview / dot accent strips don't go blank when
   * the inner body is collapsed.
   *
   * Persisted to localStorage per-conversation (see TurnTextCache) so the
   * fallback survives page reloads and dots in long conversations are
   * populated before the user has scrolled past them. Pruned each reconcile
   * pass against the live outer-wrapper turn-id set to drop entries deleted
   * by ChatGPT's "edit message" feature (which forks the conversation).
   * LRU-capped inside TurnTextCache.
   */
  private turnTextCache: TurnTextCache = new TurnTextCache();
  private cachePrimerInstalled = false;
  private cachePrimerDispose: (() => void) | null = null;
  private activeTurnId: string | null = null;
  private ui: {
    timelineBar: HTMLElement | null;
    tooltip: HTMLElement | null;
    track?: HTMLElement | null;
    trackContent?: HTMLElement | null;
    slider?: HTMLElement | null;
    sliderHandle?: HTMLElement | null;
  } = { timelineBar: null, tooltip: null };
  private isScrolling = false;

  private mutationObserver: MutationObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private visibleUserTurns: Set<Element> = new Set();
  private onTimelineBarClick: ((e: Event) => void) | null = null;
  private onScroll: (() => void) | null = null;
  private onDocumentScroll: ((e: Event) => void) | null = null;
  private onTimelineWheel: ((e: WheelEvent) => void) | null = null;
  private onWindowResize: (() => void) | null = null;
  private onTimelineBarOver: ((e: MouseEvent) => void) | null = null;
  private onTimelineBarOut: ((e: MouseEvent) => void) | null = null;
  private scrollRafId: number | null = null;
  private scrollRafFallbackTimerId: number | null = null;
  private scrollSyncTimerId: number | null = null;
  private lastScrollSyncAt = 0;
  private lastUserScrollAt = 0;
  private deferredMarkerRecalcTimerId: number | null = null;
  private pendingMarkerOrderSignature: string | null = null;
  private pendingMarkerOrderTimerId: number | null = null;
  private readonly scrollSyncInterval = 50;
  private readonly markerRecalcScrollIdleDelay = 1800;
  private readonly markerOrderChangeConfirmDelay = 900;
  private scrollPollIntervalId: number | null = null;
  private lastObservedScrollTop = -1;
  private lastObservedFirstMarkerTop = Number.NaN;
  // Scroll-direction monotonicity for active-dot updates: when the user is
  // actively scrolling forward, a candidate that points BACKWARD is held back
  // briefly to filter out noisy oscillation from stale marker rects.
  private lastScrollDirection: -1 | 0 | 1 = 0;
  private lastScrollDirectionAt = 0;
  private readonly scrollDirectionFreshnessMs = 350;
  private readonly reverseActiveConfirmDelay = 180;
  private pendingReverseActiveId: string | null = null;
  private pendingReverseActiveAt = 0;
  private pendingReverseActiveTimer: number | null = null;
  private scrollAnimationLockUntil = 0;
  private lastScrollContainerRefreshAt = 0;
  private readonly scrollContainerRefreshInterval = 500;
  private lastMarkerTopsSanityCheckAt = 0;
  private markerTopsMatchViewportCache = true;
  private readonly markerTopsSanityCheckInterval = 250;
  private lastActiveChangeTime = 0;
  private minActiveChangeInterval = 120;
  private pendingActiveId: string | null = null;
  private activeChangeTimer: number | null = null;
  private activeLockUntil = 0;
  private tooltipHideDelay = 100;
  private scrollMode: 'jump' | 'flow' = 'flow';
  private hideContainer: boolean = false;
  private barWidth: number = 24;
  private readonly barWidthMin = 4;
  private readonly barWidthMax = 24;
  private resizing = false;
  private onResizeMove: ((ev: PointerEvent) => void) | null = null;
  private onResizeUp: ((ev: PointerEvent) => void) | null = null;
  private onBarCursorMove: ((ev: PointerEvent) => void) | null = null;
  private runnerRing: HTMLElement | null = null;
  private flowAnimating = false;
  private tooltipHideTimer: number | null = null;
  private tooltipDotId: string | null = null;
  private measureEl: HTMLElement | null = null;
  private measureCanvas: HTMLCanvasElement | null = null;
  private measureCtx: CanvasRenderingContext2D | null = null;
  private showRafId: number | null = null;
  private scale = 1;
  private contentHeight = 0;
  private yPositions: number[] = [];
  private markerTops: number[] = [];
  private visibleRange: { start: number; end: number } = { start: 0, end: -1 };
  private firstUserTurnOffset = 0;
  private contentSpanPx = 1;
  private usePixelTop = false;
  private _cssVarTopSupported: boolean | null = null;
  private sliderDragging = false;
  private sliderFadeTimer: number | null = null;
  private sliderFadeDelay = 1000;
  private sliderAlwaysVisible = false;
  private onSliderDown: ((ev: PointerEvent) => void) | null = null;
  private onSliderMove: ((ev: PointerEvent) => void) | null = null;
  private onSliderUp: ((ev: PointerEvent) => void) | null = null;
  private sliderStartClientY = 0;
  private sliderStartTop = 0;
  private markersVersion = 0;
  private resizeIdleTimer: number | null = null;
  private resizeIdleDelay = 140;
  private resizeIdleRICId: number | null = null;
  private onVisualViewportResize: (() => void) | null = null;
  private zeroTurnsTimer: number | null = null;
  private onStorage: ((e: StorageEvent) => void) | null = null;
  private onChromeStorageChanged:
    | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
    | null = null;
  private starred: Set<string> = new Set();
  /** Map of turnId to starredAt timestamp (ms). Populated from service/storage; used for preview labels. */
  private starredAtMap: Map<string, number> = new Map();
  private markerMap: Map<
    string,
    {
      id: string;
      element: HTMLElement;
      dotElement: DotElement | null;
      starred: boolean;
      n: number;
      baseN: number;
      summary: string;
      attachments: ReadonlyArray<AttachmentInfo>;
      hasGeneratedImage: boolean;
    }
  > = new Map();
  private conversationId: string | null = null;
  private userTurnSelector: string = '';
  private markerLevels: Map<string, MarkerLevel> = new Map();
  private collapsedMarkers: Set<string> = new Set();
  private timelineHierarchyAccountScope: AccountScope | null = null;
  private timelineHierarchyStorageKey: string = StorageKeys.TIMELINE_HIERARCHY;
  private markerLevelEnabled = false;
  private contextMenu: HTMLElement | null = null;
  private onContextMenu: ((ev: MouseEvent) => void) | null = null;
  private onDocumentClick: ((ev: MouseEvent) => void) | null = null;
  private onPointerDown: ((ev: PointerEvent) => void) | null = null;
  private onPointerMove: ((ev: PointerEvent) => void) | null = null;
  private onPointerUp: ((ev: PointerEvent) => void) | null = null;
  private onPointerCancel: ((ev: PointerEvent) => void) | null = null;
  private onPointerLeave: ((ev: PointerEvent) => void) | null = null;
  private pressTargetDot: DotElement | null = null;
  private pressStartPos: { x: number; y: number } | null = null;
  private longPressTimer: number | null = null;
  private longPressTriggered = false;
  private suppressClickUntil = 0;
  private longPressDuration = 550;
  private longPressMoveTolerance = 6;
  private onBarEnter: (() => void) | null = null;
  private onBarLeave: (() => void) | null = null;
  private onSliderEnter: (() => void) | null = null;
  private onSliderLeave: (() => void) | null = null;
  private draggable = false;
  private barDragging = false;
  private barStartPos = { x: 0, y: 0 };
  private barStartOffset = { x: 0, y: 0 };
  private onBarPointerDown: ((ev: PointerEvent) => void) | null = null;
  private onBarPointerMove: ((ev: PointerEvent) => void) | null = null;
  private onBarPointerUp: ((ev: PointerEvent) => void) | null = null;
  private eventBusUnsubscribers: Array<() => void> = [];
  private onGvTurnHashChange: (() => void) | null = null;
  private shortcutUnsubscribe: (() => void) | null = null;
  private navigationQueue: Array<'previous' | 'next'> = [];
  private isNavigating: boolean = false;
  private previewPanel: TimelinePreviewPanel | null = null;
  private rtl = false;
  private timestampService: TimestampService | null = null;
  private showMessageTimestampsEnabled = false;
  private readonly initialTimestampSnapshotDelay = 800;
  private readonly draftTimestampAdoptionWindowMs = 5 * 60 * 1000;
  private timestampTrackingReady = false;
  private timestampStartupTimer: number | null = null;
  private seenTurnIds: Set<string> = new Set();
  private pendingDraftTimestampSourceConversationId: string | null;
  private readonly turnIdByIndex = new Map<number, string>();
  private pinsByTurn: Map<string, TimelineTextPin[]> = new Map();
  private activePinByTurn: Map<string, string> = new Map();
  private pinMode = false;
  private pinControls: HTMLElement | null = null;
  private pinPrevButton: HTMLButtonElement | null = null;
  private pinNextButton: HTMLButtonElement | null = null;
  private pinToggleButton: HTMLButtonElement | null = null;
  private pinBadgeLayer: HTMLElement | null = null;
  private pinBadges: Map<string, HTMLButtonElement> = new Map();
  private selectedPinId: string | null = null;
  private selectedPinTurnId: string | null = null;
  private pinDeleteButton: HTMLButtonElement | null = null;
  private pinFocusTurnId: string | null = null;
  private onPinToggleClick: ((ev: MouseEvent) => void) | null = null;
  private onPinPrevClick: ((ev: MouseEvent) => void) | null = null;
  private onPinNextClick: ((ev: MouseEvent) => void) | null = null;
  private onPinDeleteClick: ((ev: MouseEvent) => void) | null = null;
  private onDocumentPinClick: ((ev: MouseEvent) => void) | null = null;
  private pinBadgePositionRaf: number | null = null;

  constructor(private readonly options: TimelineManagerOptions = {}) {
    this.pendingDraftTimestampSourceConversationId = this.computeDraftTimestampSourceConversationId(
      options.previousUrl ?? null,
    );
  }

  async init(): Promise<void> {
    await initI18n();
    this.purgeLegacyLocalStorageKeys();
    const ok = await this.findCriticalElements();
    if (!ok) return;
    this.injectTimelineUI();
    this.setupEventListeners();
    this.setupObservers();
    this.conversationId = this.computeConversationId();
    this.turnTextCache.setConversation(this.conversationId);
    // Subscribe the turn-text cache to live API captures (page-world hook).
    // Idempotent: install once per manager instance.
    if (!this.cachePrimerInstalled) {
      this.cachePrimerInstalled = true;
      try {
        const handle = installCachePrimerForManager(
          this.turnTextCache,
          getConversationCaptureService(),
        );
        this.cachePrimerDispose = handle.dispose;
      } catch (err) {
        console.warn('[GPT-Voyager] cache primer install failed', err);
      }
    }
    this.loadTextPins();
    await this.loadStars();
    await this.syncStarredFromService();
    await this.loadTimelineHierarchyStorageContext();
    if (this.timelineHierarchyStorageKey === StorageKeys.TIMELINE_HIERARCHY) {
      this.loadMarkerLevels();
      this.loadCollapsedMarkers();
    }
    await this.loadTimelineHierarchyFromExtensionStorage();
    // Initialize timestamp service
    this.timestampService = new TimestampService();
    await this.timestampService.initialize();
    await this.loadMessageTimestampsEnabledSetting();
    // Ensure initial render even when ChatGPT's DOM is already stable.
    this.recalculateAndRenderMarkers();
    this.startScrollPositionPoller();
    // Handle URL hash for starred message navigation. Fires once on init,
    // then again whenever the `#gv-turn-…` fragment changes — that's the
    // signal from the favorites sidebar that the user clicked an in-page
    // starred message and wants the timeline to scroll there.
    this.handleStarredMessageNavigation();
    this.onGvTurnHashChange = () => {
      if (window.location.hash.startsWith('#gv-turn-')) {
        this.handleStarredMessageNavigation();
      }
    };
    window.addEventListener('hashchange', this.onGvTurnHashChange);
    // Initialize keyboard shortcuts
    await this.initKeyboardShortcuts();
    try {
      const g = globalThis as ExtGlobal;
      const defaults = {
        [StorageKeys.TIMELINE_SCROLL_MODE]: 'flow',
        [StorageKeys.TIMELINE_HIDE_CONTAINER]: false,
        [StorageKeys.TIMELINE_BAR_WIDTH]: null,
        [StorageKeys.TIMELINE_DRAGGABLE]: false,
        [StorageKeys.TIMELINE_MARKER_LEVEL]: false,
        [StorageKeys.TIMELINE_POSITION]: null,
        [StorageKeys.TIMELINE_PREVIEW_PINNED]: false,
        [StorageKeys.LANGUAGE]: null,
      };

      let res: Record<string, unknown> | null = null;
      // prefer chrome.storage or browser.storage if available to sync with popup
      if (g.chrome?.storage?.sync || g.browser?.storage?.sync) {
        res = await new Promise((resolve) => {
          if (g.chrome?.storage?.sync?.get) {
            g.chrome.storage.sync.get(
              defaults as Record<string, unknown>,
              (items: Record<string, unknown>) => {
                if (g.chrome.runtime.lastError) {
                  console.error(
                    `[Timeline] chrome.storage.get failed: ${g.chrome.runtime.lastError.message}`,
                  );
                  resolve(null);
                } else {
                  resolve(items);
                }
              },
            );
          } else {
            g.browser?.storage?.sync
              ?.get(defaults)
              .then(resolve)
              .catch((error: Error) => {
                console.error(`[Timeline] browser.storage.get failed: ${error.message}`);
                resolve(null);
              });
          }
        });
      } else {
        // No extension storage available, try to load critical fallback from localStorage
        const saved = localStorage.getItem('gptTimelineScrollMode');
        if (saved === 'flow' || saved === 'jump') {
          res = { [StorageKeys.TIMELINE_SCROLL_MODE]: saved };
        }
      }

      const m = res?.[StorageKeys.TIMELINE_SCROLL_MODE];
      if (m === 'flow' || m === 'jump') this.scrollMode = m;
      this.hideContainer = !!res?.[StorageKeys.TIMELINE_HIDE_CONTAINER];
      const storedWidth = res?.[StorageKeys.TIMELINE_BAR_WIDTH];
      if (
        typeof storedWidth === 'number' &&
        storedWidth >= this.barWidthMin &&
        storedWidth <= this.barWidthMax
      ) {
        this.barWidth = storedWidth;
      }
      this.applyContainerVisibility();
      const timelineDraggable = !!res?.[StorageKeys.TIMELINE_DRAGGABLE];
      this.toggleDraggable(timelineDraggable);
      this.toggleMarkerLevel(!!res?.[StorageKeys.TIMELINE_MARKER_LEVEL]);
      this.previewPanel?.setPinned(res?.[StorageKeys.TIMELINE_PREVIEW_PINNED] === true);
      this.rtl = applyRTLClass(res?.[StorageKeys.LANGUAGE] as string | null | undefined);

      // Load position with auto-migration from v1 to v2
      const position = timelineDraggable
        ? (res?.[StorageKeys.TIMELINE_POSITION] as
            | {
                version?: number;
                topPercent?: number;
                leftPercent?: number;
                top?: number;
                left?: number;
              }
            | undefined)
        : undefined;
      if (position) {
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // v2 format: use percentage (responsive)
        if (
          position.version === 2 &&
          position.topPercent !== undefined &&
          position.leftPercent !== undefined
        ) {
          const top = (position.topPercent / 100) * viewportHeight;
          const left = (position.leftPercent / 100) * viewportWidth;
          this.applyPosition(top, left);
        }
        // v1 format: migrate to v2 (auto-upgrade)
        else if (position.top !== undefined && position.left !== undefined) {
          // Apply old position first
          this.applyPosition(position.top, position.left);

          // Migrate to v2 format (percentage-based)
          const migratedPosition = {
            version: 2,
            topPercent: (position.top / viewportHeight) * 100,
            leftPercent: (position.left / viewportWidth) * 100,
          };
          (g.chrome?.storage?.sync || g.browser?.storage?.sync)?.set?.({
            [StorageKeys.TIMELINE_POSITION]: migratedPosition,
          });
        }
      }
      this.previewPanel?.reposition();

      // listen for changes from popup and update mode live
      try {
        const onChanged = g.chrome?.storage?.onChanged || g.browser?.storage?.onChanged;
        if (onChanged) {
          onChanged.addListener((changes: Record<string, { newValue: unknown }>, area: string) => {
            if (area !== 'sync') return;
            if (changes?.[StorageKeys.TIMELINE_SCROLL_MODE]) {
              const n = changes[StorageKeys.TIMELINE_SCROLL_MODE].newValue;
              if (n === 'flow' || n === 'jump') this.scrollMode = n;
            }
            if (changes?.[StorageKeys.TIMELINE_HIDE_CONTAINER]) {
              this.hideContainer = !!changes[StorageKeys.TIMELINE_HIDE_CONTAINER].newValue;
              this.applyContainerVisibility();
            }
            if (changes?.[StorageKeys.TIMELINE_BAR_WIDTH]) {
              const w = changes[StorageKeys.TIMELINE_BAR_WIDTH].newValue;
              if (typeof w === 'number' && w >= this.barWidthMin && w <= this.barWidthMax) {
                this.barWidth = w;
                this.applyContainerVisibility();
              }
            }
            if (changes?.[StorageKeys.TIMELINE_DRAGGABLE]) {
              this.toggleDraggable(!!changes[StorageKeys.TIMELINE_DRAGGABLE].newValue);
            }
            if (changes?.[StorageKeys.TIMELINE_MARKER_LEVEL]) {
              this.toggleMarkerLevel(!!changes[StorageKeys.TIMELINE_MARKER_LEVEL].newValue);
            }
            if (changes?.[StorageKeys.TIMELINE_PREVIEW_PINNED]) {
              this.previewPanel?.setPinned(
                changes[StorageKeys.TIMELINE_PREVIEW_PINNED].newValue === true,
              );
            }
            if (
              changes?.[StorageKeys.TIMELINE_POSITION] &&
              !changes[StorageKeys.TIMELINE_POSITION].newValue
            ) {
              if (this.ui.timelineBar) {
                this.ui.timelineBar.style.top = '';
                this.ui.timelineBar.style.left = '';
              }
              this.previewPanel?.reposition();
            }
            if (changes?.[StorageKeys.LANGUAGE]) {
              const newLang = changes[StorageKeys.LANGUAGE].newValue as string | null | undefined;
              this.applyRTLUpdate(newLang);
            }
          });
        }
      } catch {}
    } catch (err) {
      console.error('[Timeline] Init storage error:', err);
    }
  }

  private computeElementTopsInScrollContainer(elements: HTMLElement[]): number[] {
    if (!this.scrollContainer || elements.length === 0) return [];

    const containerRect = this.scrollContainer.getBoundingClientRect();
    const scrollTop = this.scrollContainer.scrollTop;

    const first = elements[0];
    const firstOffsetParent = first.offsetParent;
    const firstOffsetTop = first.offsetTop;
    const firstTop = first.getBoundingClientRect().top - containerRect.top + scrollTop;

    // ChatGPT's virtualised `<section data-testid="conversation-turn-N">`
    // wrappers all report `offsetTop === 0` because each is its own
    // positioning context. The shared-offsetParent fast path would collapse
    // every top to `firstTop` and the dedupe step then merges them into a
    // single marker. Bail out of the fast path when offsetTop values look
    // degenerate (all zero on multi-element sets) and fall through to the
    // per-element bounding-rect path.
    const allOffsetTopsZero = elements.length > 1 && elements.every((el) => el.offsetTop === 0);
    const sameOffsetParent =
      firstOffsetParent !== null &&
      !allOffsetTopsZero &&
      elements.every((el) => el.offsetParent === firstOffsetParent);

    const tops = elements.map((el) => {
      if (sameOffsetParent) {
        return firstTop + (el.offsetTop - firstOffsetTop);
      }
      return el.getBoundingClientRect().top - containerRect.top + scrollTop;
    });

    for (let i = 1; i < tops.length; i++) {
      if (tops[i] < tops[i - 1]) return [];
    }

    return tops;
  }

  private computeElementTopInScrollContainer(element: HTMLElement): number {
    if (!this.scrollContainer) return element.offsetTop || 0;
    const containerRect = this.scrollContainer.getBoundingClientRect();
    return element.getBoundingClientRect().top - containerRect.top + this.scrollContainer.scrollTop;
  }

  private updateIntersectionObserverTargetsFromMarkers(): void {
    if (!this.intersectionObserver) return;
    this.intersectionObserver.disconnect();
    this.markers.forEach((m) => this.intersectionObserver!.observe(m.element));
  }

  private applyContainerVisibility(): void {
    if (!this.ui.timelineBar) return;
    const bar = this.ui.timelineBar;
    // Visual background width (::before is centered, bar stays 24px for dots)
    bar.style.setProperty('--timeline-bar-width', `${this.barWidth}px`);
    // hideContainer is an independent binary toggle
    bar.classList.toggle('timeline-no-container', !!this.hideContainer);
  }

  /** Check if pointer is near either edge of the visual background (::before, centered in the 24px bar). */
  private isInResizeEdge(ev: PointerEvent): boolean {
    if (!this.ui.timelineBar) return false;
    const rect = this.ui.timelineBar.getBoundingClientRect();
    const barCenter = rect.left + rect.width / 2;
    const halfWidth = this.barWidth / 2;
    const ZONE = 6;

    const leftEdge = barCenter - halfWidth;
    const rightEdge = barCenter + halfWidth;
    const nearLeft = ev.clientX >= leftEdge - 2 && ev.clientX <= leftEdge + ZONE;
    const nearRight = ev.clientX >= rightEdge - ZONE && ev.clientX <= rightEdge + 2;
    return nearLeft || nearRight;
  }

  private startResize(ev: PointerEvent): void {
    this.resizing = true;
    this.ui.timelineBar!.classList.add('timeline-resizing');
    this.ui.timelineBar!.setPointerCapture(ev.pointerId);
    const barRect = this.ui.timelineBar!.getBoundingClientRect();
    const barCenterX = barRect.left + barRect.width / 2;

    this.onResizeMove = (e: PointerEvent) => {
      // Width = 2 × distance from pointer to bar center (symmetric expansion)
      const dist = Math.abs(e.clientX - barCenterX);
      this.barWidth = Math.max(this.barWidthMin, Math.min(this.barWidthMax, dist * 2));
      this.applyContainerVisibility();
    };

    this.onResizeUp = (_e: PointerEvent) => {
      this.resizing = false;
      this.ui.timelineBar?.classList.remove('timeline-resizing');
      window.removeEventListener('pointermove', this.onResizeMove!);
      window.removeEventListener('pointerup', this.onResizeUp!);
      this.onResizeMove = null;
      this.onResizeUp = null;
      this.saveBarWidth();
    };

    window.addEventListener('pointermove', this.onResizeMove);
    window.addEventListener('pointerup', this.onResizeUp, { once: true });
    ev.preventDefault();
    ev.stopPropagation();
  }

  private saveBarWidth(): void {
    const g = globalThis as ExtGlobal;
    const value = Math.round(this.barWidth);
    if (g.chrome?.storage?.sync?.set) {
      g.chrome.storage.sync.set({ [StorageKeys.TIMELINE_BAR_WIDTH]: value });
    } else if (g.browser?.storage?.sync?.set) {
      g.browser.storage.sync.set({ [StorageKeys.TIMELINE_BAR_WIDTH]: value });
    }
  }

  private computeConversationId(): string {
    return buildConversationIdFromUrl(window.location.href);
  }

  private computeLegacyConversationId(): string {
    return buildLegacyConversationIdFromUrl(window.location.href);
  }

  private computeRouteConversationId(): string {
    return buildRouteConversationIdFromUrl(window.location.href);
  }

  /**
   * DRY helper: Get storage key for starred messages
   */
  private getStarsStorageKey(): string | null {
    return this.conversationId ? `gptTimelineStars:${this.conversationId}` : null;
  }

  private getLegacyStarsStorageKey(): string | null {
    const legacyConversationId = this.computeLegacyConversationId();
    return legacyConversationId ? `gptTimelineStars:${legacyConversationId}` : null;
  }

  private getRouteStarsStorageKey(): string | null {
    const routeConversationId = this.computeRouteConversationId();
    return routeConversationId ? `gptTimelineStars:${routeConversationId}` : null;
  }

  /**
   * DRY helper: Safe localStorage getItem with try-catch
   */
  private safeLocalStorageGet(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.warn('[Timeline] Failed to read from localStorage:', error);
      return null;
    }
  }

  /**
   * DRY helper: Safe localStorage setItem with try-catch
   */
  private safeLocalStorageSet(key: string, value: string): boolean {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      console.warn('[Timeline] Failed to write to localStorage:', error);
      return false;
    }
  }

  private areStarredSetsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const value of a) {
      if (!b.has(value)) return false;
    }
    return true;
  }

  private applyStarredIdSet(nextSet: Set<string>, persistLocal = true): void {
    if (this.areStarredSetsEqual(this.starred, nextSet)) return;

    // Clean up starredAtMap for removed entries
    for (const id of this.starred) {
      if (!nextSet.has(id)) this.starredAtMap.delete(id);
    }

    this.starred = new Set(nextSet);

    if (persistLocal) this.saveStars();

    for (const marker of this.markers) {
      const want = this.starred.has(marker.id);
      if (marker.starred !== want) {
        marker.starred = want;
        if (marker.dotElement) {
          marker.dotElement.classList.toggle('starred', want);
          marker.dotElement.setAttribute('aria-pressed', want ? 'true' : 'false');
          this.updateDotIndicators(marker.dotElement, marker);
        }
      }
    }

    if (this.ui.tooltip?.classList.contains('visible')) {
      const currentDot = this.ui.timelineBar?.querySelector(
        '.timeline-dot:hover, .timeline-dot:focus',
      ) as DotElement | null;
      if (currentDot) this.refreshTooltipForDot(currentDot);
    }
  }

  private applySharedStarredData(data?: StarredMessagesData | null): void {
    if (!this.conversationId) return;

    const rawMessages = data?.messages?.[this.conversationId];
    const conversationMessages = Array.isArray(rawMessages) ? rawMessages : [];
    const nextSet = new Set(conversationMessages.map((message) => String(message.turnId)));

    // Update starredAt map from shared data
    for (const msg of conversationMessages) {
      if (msg.starredAt) this.starredAtMap.set(String(msg.turnId), msg.starredAt);
    }

    this.applyStarredIdSet(nextSet);
  }

  private async syncStarredFromService(): Promise<void> {
    if (!this.conversationId) return;
    try {
      const data = await StarredMessagesService.getAllStarredMessages();
      const matched = findMatchingStarredMessages(data, this.conversationId, window.location.href);

      let messages = matched.messages;
      const needsReconcile = matched.sourceConversationIds.some(
        (sourceConversationId) => sourceConversationId !== this.conversationId,
      );

      if (needsReconcile) {
        const reconciled = await StarredMessagesService.reconcileConversationIds(
          this.conversationId,
          matched.sourceConversationIds,
          window.location.href,
        );
        if (reconciled.length > 0) {
          messages = reconciled;
        }
      }

      const nextSet = new Set(messages.map((message) => String(message.turnId)));

      // Update starredAt map from service data
      for (const msg of messages) {
        if (msg.starredAt) this.starredAtMap.set(String(msg.turnId), msg.starredAt);
      }

      this.applyStarredIdSet(nextSet);
    } catch (error) {
      console.warn('[Timeline] Failed to sync starred messages from shared storage:', error);
    }
  }

  private getConversationTitle(): string {
    const getText = (el: Element | null | undefined): string | null => {
      const text = el?.textContent?.trim();
      return text && text.length > 0 ? text : null;
    };

    // Strategy 1: Prefer the currently selected conversation in folder view
    try {
      const selected = document.querySelector(
        '.gv-folder-conversation-selected .gv-conversation-title',
      );
      const title = getText(selected);
      if (title) return title;
    } catch (error) {
      console.debug('[Timeline] Failed to get title from selected folder conversation:', error);
    }

    // Strategy 2: Try to get from page title
    const titleElement = document.querySelector('title');
    if (titleElement) {
      const title = titleElement.textContent?.trim();
      // Filter out generic titles
      if (
        title &&
        title !== 'ChatGPT' &&
        title !== 'OpenAI' &&
        !title.startsWith('ChatGPT -') &&
        title.length > 0
      ) {
        return title;
      }
    }

    // Strategy 3: Try to get from sidebar conversation list
    // Look for the active conversation in the sidebar
    try {
      // ChatGPT uses various selectors for conversation titles
      const selectors = [
        // ChatGPT sidebar active conversation
        'mat-list-item.mdc-list-item--activated [mat-line]',
        'mat-list-item[aria-current="page"] [mat-line]',
        // Legacy active conversation fallback
        '.conversation-list-item.active .conversation-title',
        '.active-conversation .title',
      ];

      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent) {
          const text = element.textContent.trim();
          if (text && text.length > 0 && text !== 'New chat') {
            return text;
          }
        }
      }
    } catch (error) {
      console.debug('[Timeline] Failed to get title from sidebar:', error);
    }

    // Strategy 4: Use first user message as title (fallback)
    const firstMarker = this.markers[0];
    if (firstMarker && firstMarker.summary) {
      const preview = firstMarker.summary.slice(0, 50);
      return preview.length < firstMarker.summary.length ? `${preview}...` : preview;
    }

    // Strategy 5: Extract from URL if it contains conversation ID
    try {
      const urlPath = window.location.pathname;
      const match = urlPath.match(/\/app\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) {
        return `Conversation ${match[1].slice(0, 8)}...`;
      }
    } catch (error) {
      console.debug('[Timeline] Failed to extract from URL:', error);
    }

    // Final fallback: generic name
    return 'Untitled Conversation';
  }

  private waitForElement(selector: string, timeoutMs: number = 5000): Promise<Element | null> {
    return new Promise((resolve) => {
      const found = document.querySelector(selector);
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          try {
            obs.disconnect();
          } catch {}
          resolve(el);
        }
      });
      try {
        obs.observe(document.body, { childList: true, subtree: true });
      } catch {}
      if (timeoutMs > 0) {
        setTimeout(() => {
          try {
            obs.disconnect();
          } catch {}
          resolve(null);
        }, timeoutMs);
      }
    });
  }

  private waitForAnyElement(
    selectors: string[],
    timeoutMs: number = 5000,
  ): Promise<{ element: Element; selector: string } | null> {
    return new Promise((resolve) => {
      for (const selector of selectors) {
        const found = document.querySelector(selector);
        if (found) return resolve({ element: found, selector });
      }

      const obs = new MutationObserver(() => {
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el) {
            try {
              obs.disconnect();
            } catch {}
            resolve({ element: el, selector });
            return;
          }
        }
      });

      try {
        obs.observe(document.body, { childList: true, subtree: true });
      } catch {}

      if (timeoutMs > 0) {
        setTimeout(() => {
          try {
            obs.disconnect();
          } catch {}
          resolve(null);
        }, timeoutMs);
      }
    });
  }

  private async findCriticalElements(): Promise<boolean> {
    const configured = this.getConfiguredUserTurnSelector();
    let userOverride = '';
    let autoDetected = '';
    try {
      userOverride = localStorage.getItem('gptTimelineUserTurnSelector') || '';
      autoDetected = localStorage.getItem('gptTimelineUserTurnSelectorAuto') || '';
    } catch {}
    const defaultCandidates = [
      // FIRST PRIORITY: outer <section data-testid="conversation-turn-N"
      // data-turn="user">. ChatGPT keeps this wrapper in the DOM with
      // stable offsetTop + data-turn-id UUID even when virtualising the
      // inner body for off-viewport turns. Picking it as the marker
      // element means every user turn always has a real, click-able
      // marker — the long-message-disappears bug goes away. Inner
      // selectors below stay as fallbacks for older / variant layouts.
      '[data-testid^="conversation-turn"][data-turn="user"]',
      // ChatGPT user bubble selectors
      '.user-query-bubble-with-background',
      // Angular containers (fallbacks if bubble selector changes)
      '.user-query-bubble-container',
      '.user-query-container',
      'user-query-content .user-query-bubble-with-background',
      // Attribute-based fallbacks for other variants
      'div[aria-label="User message"]',
      'article[data-author="user"]',
      'article[data-turn="user"]',
      '[data-message-author-role="user"]',
      'div[role="listitem"][data-user="true"]',
    ];
    // Compatibility strategy:
    // - Keep explicit user override as highest priority.
    // - Prefer built-in defaults over auto-detected cache, so stale auto cache can self-heal after refresh.
    let candidates = [...defaultCandidates];
    if (userOverride.length) {
      candidates = [userOverride, ...defaultCandidates.filter((s) => s !== userOverride)];
    } else {
      const cached = autoDetected || configured;
      if (cached && !candidates.includes(cached)) candidates.push(cached);
    }
    let firstTurn: Element | null = null;
    let matchedSelector = '';
    const found = await this.waitForAnyElement(candidates, 4000);
    if (found) {
      firstTurn = found.element;
      matchedSelector = found.selector;
      this.userTurnSelector = matchedSelector;
    }
    if (!firstTurn) {
      this.conversationContainer =
        (document.querySelector('main') as HTMLElement) || (document.body as HTMLElement);
      this.userTurnSelector = defaultCandidates.join(',');
    } else {
      // Scope selection/observers:
      // - Broad scope (main/body) if:
      //   a) user provided an explicit override, or
      //   b) auto-detected selector suggests Angular-based user query DOM (contains 'user-query')
      // - Otherwise, scope to the immediate parent for performance
      const looksAngularUserQuery = /user-query/i.test(matchedSelector || '');
      const looksChatGptUserMessage = /data-message-author-role|data-author|data-turn/i.test(
        matchedSelector || '',
      );
      if (
        (userOverride && matchedSelector === userOverride) ||
        looksAngularUserQuery ||
        looksChatGptUserMessage
      ) {
        this.conversationContainer =
          (document.querySelector('main') as HTMLElement) || (document.body as HTMLElement);
      } else {
        const parent = firstTurn.parentElement as HTMLElement | null;
        if (!parent) return false;
        this.conversationContainer = parent;
      }
      // Persist auto-detected selector for future sessions when no explicit user override exists
      if (!userOverride && matchedSelector) {
        try {
          localStorage.setItem('gptTimelineUserTurnSelectorAuto', matchedSelector);
        } catch {}
      }
      // If a stale user override failed (matchedSelector differs), clear it so we don't keep retrying it
      if (userOverride && matchedSelector && matchedSelector !== userOverride) {
        try {
          localStorage.removeItem('gptTimelineUserTurnSelector');
        } catch {}
      }
    }
    let p: HTMLElement | null = (firstTurn as HTMLElement) || this.conversationContainer;
    while (p && p !== document.body) {
      const st = getComputedStyle(p);
      if (st.overflowY === 'auto' || st.overflowY === 'scroll') {
        this.scrollContainer = p;
        break;
      }
      p = p.parentElement;
    }
    if (!this.scrollContainer)
      this.scrollContainer =
        (document.scrollingElement as HTMLElement) ||
        document.documentElement ||
        (document.body as unknown as HTMLElement);
    return true;
  }

  private getConfiguredUserTurnSelector(): string {
    try {
      const user = localStorage.getItem('gptTimelineUserTurnSelector');
      if (user && typeof user === 'string') return user;
      const auto = localStorage.getItem('gptTimelineUserTurnSelectorAuto');
      return auto && typeof auto === 'string' ? auto : '';
    } catch {
      return '';
    }
  }

  private injectTimelineUI(): void {
    let bar = document.querySelector('.gpt-timeline-bar') as HTMLElement | null;
    if (!bar) {
      bar = document.createElement('div');
      document.body.appendChild(bar);
    }
    bar.className = 'gpt-timeline-bar';
    // Mark the body whenever our timeline bar is present so the stylesheet hides
    // ChatGPT's overlapping native prompt-TOC. Tied to the bar's actual creation
    // (the single source of truth) rather than the lifecycle wrapper, which can
    // race with async init / teardown. Removed in destroy().
    try {
      document.body.classList.add('gv-timeline-active');
    } catch {}
    this.ui.timelineBar = bar;
    let track = bar.querySelector('.timeline-track') as HTMLElement | null;
    if (!track) {
      track = document.createElement('div');
      track.className = 'timeline-track';
      bar.appendChild(track);
    }
    let content = track.querySelector('.timeline-track-content') as HTMLElement | null;
    if (!content) {
      content = document.createElement('div');
      content.className = 'timeline-track-content';
      track.appendChild(content);
    }
    this.ui.track = track;
    this.ui.trackContent = content;

    let slider = document.querySelector('.timeline-left-slider') as HTMLElement | null;
    if (!slider) {
      slider = document.createElement('div');
      slider.className = 'timeline-left-slider';
      const handle = document.createElement('div');
      handle.className = 'timeline-left-handle';
      slider.appendChild(handle);
      document.body.appendChild(slider);
    }
    this.ui.slider = slider;
    this.ui.sliderHandle = slider.querySelector('.timeline-left-handle') as HTMLElement | null;

    if (!this.ui.tooltip) {
      const tip = document.createElement('div');
      tip.className = 'timeline-tooltip';
      tip.id = 'gpt-timeline-tooltip';
      tip.setAttribute('dir', 'auto');
      document.body.appendChild(tip);
      this.ui.tooltip = tip;
      if (!this.measureEl) {
        const m = document.createElement('div');
        m.setAttribute('aria-hidden', 'true');
        m.setAttribute('dir', 'auto');
        Object.assign(m.style, {
          position: 'fixed',
          left: '-9999px',
          top: '0',
          visibility: 'hidden',
          pointerEvents: 'none',
        });
        const cs = getComputedStyle(tip);
        Object.assign(m.style, {
          backgroundColor: cs.backgroundColor,
          color: cs.color,
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          lineHeight: cs.lineHeight,
          padding: cs.padding,
          border: cs.border,
          borderRadius: cs.borderRadius,
          whiteSpace: 'pre-line',
          wordBreak: 'break-word',
          maxWidth: 'none',
          display: 'block',
        });
        document.body.appendChild(m);
        this.measureEl = m;
      }
      if (!this.measureCanvas) {
        this.measureCanvas = document.createElement('canvas');
        this.measureCtx = this.measureCanvas.getContext('2d');
      }
    }

    // Preview panel
    if (!this.previewPanel && this.ui.timelineBar) {
      this.previewPanel = new TimelinePreviewPanel(this.ui.timelineBar);
      this.previewPanel.init(
        (turnId, index) => {
          let marker = this.markers[index] || this.markerMap.get(turnId);
          if (this.maybeRefreshMarkersForInteraction(marker?.element || null)) {
            marker = this.markers[index] || this.markerMap.get(turnId);
          }
          if (!marker?.element) return;
          const fromIdx = this.getActiveIndex();
          const dur = this.computeFlowDuration(fromIdx, index);
          if (this.scrollMode === 'flow' && fromIdx >= 0 && index >= 0 && fromIdx !== index) {
            this.activeTurnId = null;
            this.updateActiveDotUI();
            this.startRunner(fromIdx, index, dur);
          }
          this.smoothScrollTo(marker.element, dur, marker.id);
        },
        (query) => this.highlightSearchInDOM(query),
        (turnId) => {
          // Star toggle from the preview-panel row. Reuses the same code path
          // long-press on a dot would invoke so the persistence, sharing and
          // dot-indicator refresh all stay in one place.
          this.toggleStar(turnId).catch(() => {});
        },
      );
    }

    this.injectPinUI();
  }

  private injectPinUI(): void {
    if (!this.pinControls) {
      const controls = document.createElement('div');
      controls.className = 'timeline-pin-controls';

      const nav = document.createElement('div');
      nav.className = 'timeline-pin-nav';

      const prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'timeline-pin-step timeline-pin-prev';
      prev.setAttribute('aria-label', 'Previous pin in this message');
      prev.innerHTML = '<span aria-hidden="true">&#9650;</span>';

      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'timeline-pin-step timeline-pin-next';
      next.setAttribute('aria-label', 'Next pin in this message');
      next.innerHTML = '<span aria-hidden="true">&#9660;</span>';

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'timeline-pin-toggle';
      toggle.setAttribute('aria-label', 'Pin text in the current conversation');
      toggle.setAttribute('aria-pressed', 'false');
      toggle.innerHTML =
        '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m14 4 6 6"/><path d="m8 10 6-6 6 6-6 6"/><path d="m9 15-5 5"/><path d="m14 16-6-6"/></svg>';

      nav.append(prev, next);
      controls.append(nav, toggle);
      document.body.appendChild(controls);

      this.pinControls = controls;
      this.pinPrevButton = prev;
      this.pinNextButton = next;
      this.pinToggleButton = toggle;
    }

    if (!this.pinBadgeLayer) {
      const layer = document.createElement('div');
      layer.className = 'timeline-pin-badge-layer';
      document.body.appendChild(layer);
      this.pinBadgeLayer = layer;
    }

    if (!this.pinDeleteButton) {
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'timeline-pin-delete';
      deleteButton.setAttribute('aria-label', 'Delete selected pin');
      deleteButton.innerHTML =
        '<svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m6 6 1 14h10l1-14"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>';
      this.pinBadgeLayer?.appendChild(deleteButton);
      this.pinDeleteButton = deleteButton;
    }

    this.positionPinControls();
    this.updatePinControlsState();
  }

  private positionPinControls(): void {
    if (!this.ui.timelineBar || !this.pinControls) return;
    const rect = this.ui.timelineBar.getBoundingClientRect();
    const top = Math.max(12, Math.min(window.innerHeight - 82, rect.bottom - 82));
    const gap = 10;
    const width = 48;
    const left = this.rtl ? Math.round(rect.right + gap) : Math.round(rect.left - gap - width);
    this.pinControls.style.top = `${Math.round(top)}px`;
    this.pinControls.style.left = `${left}px`;
  }

  private updateIntersectionObserverTargets(): void {
    if (!this.intersectionObserver || !this.conversationContainer || !this.userTurnSelector) return;
    this.intersectionObserver.disconnect();
    this.visibleUserTurns.clear();
    const nodeList = this.conversationContainer.querySelectorAll(this.userTurnSelector);
    const topLevel = this.filterTopLevel(Array.from(nodeList));
    topLevel.forEach((el) => this.intersectionObserver!.observe(el));
  }

  private normalizeText(text: string | null): string {
    try {
      if (!text) return '';
      // 1. Collapse whitespace
      const collapsed = String(text).replace(/\s+/g, ' ').trim();
      // 2. Strip prefixes (You said, etc.)
      return collapsed.replace(TURN_LABEL_PREFIXES, '');
    } catch {
      return '';
    }
  }

  private hasVisuallyHiddenClass(el: Element): boolean {
    if (!(el instanceof HTMLElement) || el.classList.length === 0) return false;
    for (const cls of el.classList) {
      if (cls.toLowerCase().includes(VISUALLY_HIDDEN_CLASS_FRAGMENT)) return true;
    }
    return false;
  }

  private extractTurnText(element: HTMLElement | null): string {
    if (!element) return '';
    try {
      const clone = element.cloneNode(true) as HTMLElement;
      if (this.hasVisuallyHiddenClass(clone)) return '';

      // Remove visually-hidden descendants
      const descendants = clone.getElementsByTagName('*');
      for (let i = descendants.length - 1; i >= 0; i--) {
        if (this.hasVisuallyHiddenClass(descendants[i])) {
          descendants[i].remove();
        }
      }

      // Remove extension-injected UI elements (e.g. fork button)
      clone.querySelectorAll(INJECTED_UI_SELECTOR).forEach((el) => el.remove());

      // Strip ChatGPT's own chrome buttons so things like the "展开收起" toggle
      // don't bleed into our turn summaries / aria labels.
      clone.querySelectorAll(HOST_CHROME_SELECTOR).forEach((el) => el.remove());

      // Strip file-attachment tiles outright — we report those as structured
      // data via extractAttachments, so the body text shouldn't repeat the
      // filename / localised "文档" / "Document" noun rendered inside the tile.
      clone
        .querySelectorAll('[role="group"][aria-label], [class*="file-tile"][aria-label]')
        .forEach((el) => el.remove());

      // Restore original text for LaTeX-rendered elements
      clone.querySelectorAll<HTMLElement>('[data-user-latex-original]').forEach((el) => {
        el.textContent = el.dataset.userLatexOriginal ?? '';
      });

      return this.normalizeText(clone.textContent || '');
    } catch {
      return this.normalizeText(element.textContent || '');
    }
  }

  /**
   * Performance-optimized filter to remove nested elements.
   * Sorts elements by depth first, which can prune the search space in the average case.
   * Worst-case complexity: O(n²), but average case is improved over naive implementation.
   */
  private filterTopLevel(elements: Element[]): HTMLElement[] {
    const arr = elements.map((e) => e as HTMLElement);
    if (arr.length === 0) return arr;

    // Use Set for O(1) lookup of descendants
    const descendants = new Set<HTMLElement>();

    // Sort by depth (shallower first) to optimize checking
    const sorted = arr.slice().sort((a, b) => {
      let aDepth = 0,
        bDepth = 0;
      let node: Element | null = a;
      while (node.parentElement) {
        aDepth++;
        node = node.parentElement;
      }
      node = b;
      while (node.parentElement) {
        bDepth++;
        node = node.parentElement;
      }
      return aDepth - bDepth;
    });

    // Only check if element is descendant of earlier elements
    for (let i = 0; i < sorted.length; i++) {
      const el = sorted[i];
      for (let j = 0; j < i; j++) {
        if (sorted[j].contains(el)) {
          descendants.add(el);
          break;
        }
      }
    }

    return arr.filter((el) => !descendants.has(el));
  }

  /**
   * Performance-optimized deduplication with cached text normalization
   */
  private dedupeByTextAndTop(
    elements: HTMLElement[],
    tops: number[],
  ): { elements: HTMLElement[]; tops: number[] } {
    const seen = new Set<string>();
    const out: HTMLElement[] = [];
    const outTops: number[] = [];

    // Cache normalized text to avoid repeated processing
    const normalizedCache = new Map<HTMLElement, string>();

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      // Get or compute normalized text
      let normalizedText = normalizedCache.get(el);
      if (normalizedText === undefined) {
        normalizedText = this.extractTurnText(el);
        normalizedCache.set(el, normalizedText);
      }

      const top = tops[i] ?? this.computeElementTopInScrollContainer(el);
      const key = `${normalizedText}|${Math.round(top)}`;

      if (seen.has(key)) continue;
      seen.add(key);
      out.push(el);
      outTops.push(top);
    }
    return { elements: out, tops: outTops };
  }

  private getCSSVarNumber(el: Element, name: string, fallback: number): number {
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }

  private getTrackPadding(): number {
    return this.ui.timelineBar
      ? this.getCSSVarNumber(this.ui.timelineBar, '--timeline-track-padding', 12)
      : 12;
  }
  private getMinGap(): number {
    return this.ui.timelineBar
      ? this.getCSSVarNumber(this.ui.timelineBar, '--timeline-min-gap', 12)
      : 12;
  }

  private collectExistingTurnIdOwners(elements: HTMLElement[]): Map<string, HTMLElement[]> {
    const owners = new Map<string, HTMLElement[]>();
    elements.forEach((el) => {
      const id = el.dataset?.turnId?.trim() || '';
      if (!id) return;
      const existing = owners.get(id);
      if (existing) {
        existing.push(el);
      } else {
        owners.set(id, [el]);
      }
    });
    return owners;
  }

  private collectPreviousMarkerElementsById(): Map<string, Set<HTMLElement>> {
    const elementsById = new Map<string, Set<HTMLElement>>();
    this.markers.forEach((marker) => {
      let elements = elementsById.get(marker.id);
      if (!elements) {
        elements = new Set<HTMLElement>();
        elementsById.set(marker.id, elements);
      }
      elements.add(marker.element);
    });
    return elementsById;
  }

  private shouldKeepExistingTurnId(
    id: string,
    el: HTMLElement,
    usedIds: Set<string>,
    existingTurnIdOwners: Map<string, HTMLElement[]>,
    previousMarkerElementsById: Map<string, Set<HTMLElement>>,
  ): boolean {
    if (usedIds.has(id)) return false;

    const owners = existingTurnIdOwners.get(id) ?? [];
    if (owners.length <= 1) return true;

    const previousOwners = previousMarkerElementsById.get(id);
    if (!previousOwners || previousOwners.size === 0) return owners[0] === el;
    if (previousOwners.has(el)) return true;

    return !owners.some((owner) => owner !== el && previousOwners.has(owner));
  }

  private allocateTurnId(
    el: HTMLElement,
    index: number,
    usedIds: Set<string>,
    existingTurnIdOwners: Map<string, HTMLElement[]>,
  ): string {
    // Prefer ChatGPT's stable message UUID — it's globally unique and survives
    // mid-conversation insertions (lazy-load of older turns) without collision.
    const uuid = this.extractStableMessageUuid(el);
    if (uuid) {
      const uuidId = `u-${uuid}`;
      if (!usedIds.has(uuidId) && !existingTurnIdOwners.has(uuidId)) return uuidId;
    }

    const basis = this.extractTurnText(el) || `user-${index}`;
    const candidates = [
      this.turnIdByIndex.get(index) || '',
      makeStableTurnId(index),
      `u-${index}-${hashString(basis)}`,
    ];

    for (const candidate of candidates) {
      if (!candidate || usedIds.has(candidate)) continue;
      if (existingTurnIdOwners.has(candidate)) continue;
      return candidate;
    }

    const base = `u-${index}-${hashString(`${basis}|dedupe`)}`;
    let suffix = 0;
    let candidate = base;
    while (usedIds.has(candidate) || existingTurnIdOwners.has(candidate)) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    return candidate;
  }

  private extractStableMessageUuid(el: HTMLElement): string | null {
    // Inner `[data-message-id]` is the canonical source when rendered.
    const direct = el.dataset?.messageId;
    if (direct && this.looksLikeUuid(direct)) return direct;
    const nested = el.querySelector('[data-message-id]') as HTMLElement | null;
    const nestedId = nested?.dataset?.messageId;
    if (nestedId && this.looksLikeUuid(nestedId)) return nestedId;
    const closest = el.closest('[data-message-id]') as HTMLElement | null;
    const closestId = closest?.dataset?.messageId;
    if (closestId && this.looksLikeUuid(closestId)) return closestId;

    // Outer `<section data-testid="conversation-turn-N" data-turn-id="<uuid>">`
    // exposes the SAME UUID via `data-turn-id`, AND it survives ChatGPT's
    // virtualisation when the inner body is collapsed. Without this branch
    // a virtualised turn would fall back to an index-based id, and the
    // moment the inner re-rendered the marker would be re-allocated under
    // a *different* id — dot disappears + a fresh dot pops in, exactly the
    // "时有时无" symptom the user hit.
    const outer = el.matches('[data-testid^="conversation-turn"]')
      ? el
      : (el.closest('[data-testid^="conversation-turn"]') as HTMLElement | null);
    const outerTurnId = outer?.dataset?.turnId;
    if (outerTurnId && this.looksLikeUuid(outerTurnId)) return outerTurnId;
    return null;
  }

  private looksLikeUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  /**
   * Walk forward from a user turn through siblings until the next user turn,
   * checking the assistant content in between for what looks like a generated
   * image. ChatGPT puts dalle/sora/etc results inside `<img>` elements hosted
   * on `oaiusercontent.com` (the file storage CDN), so a sizeable image with
   * that origin is the practical detection signal here. Tiny avatars and
   * inline emoji-style images stay below the size threshold.
   *
   * The real ChatGPT layout wraps each turn in a `<section data-testid="conversation-turn-N">`
   * with a numeric suffix, and the user-message `[data-message-author-role]`
   * div lives several layers inside that section. So walking siblings from
   * the inner user div finds nothing — we have to climb to the section first,
   * then walk to the next sibling section (which is the assistant's reply).
   */
  private detectGeneratedImageAfterTurn(turnElement: HTMLElement): boolean {
    try {
      // Climb to the outer conversation-turn section. ChatGPT uses
      // `data-testid="conversation-turn-<n>"`, so a prefix match is required;
      // exact-equals matching was the original bug that hid this signal.
      const turnSection =
        turnElement.closest<HTMLElement>('[data-testid^="conversation-turn"]') ??
        turnElement.closest<HTMLElement>('article') ??
        turnElement;

      // ChatGPT scatters conversation-turn sections across deeply nested
      // layout wrappers — they are NOT direct siblings of one parent, so
      // `nextElementSibling` walking mostly hits empty `contents` divs.
      // Use the full document-order list of sections to find the reply.
      const allSections = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid^="conversation-turn"]'),
      );
      const idx = allSections.indexOf(turnSection);
      if (idx >= 0) {
        // The reply lives in the next section. Allow up to 2 sections in case
        // ChatGPT renders reasoning/tool-call segments before the final image.
        for (let offset = 1; offset <= 2; offset++) {
          const candidate = allSections[idx + offset];
          if (!candidate) break;
          // Stop at the next user turn — that's a new prompt, not this reply.
          if (this.isUserTurnSection(candidate)) break;
          // Only count images that live inside an assistant turn. Without this
          // guard, user-uploaded screenshots (also served via the estuary URL)
          // would trip elementHasGeneratedImage and paint the photo icon on
          // every dot in a conversation full of user image uploads.
          if (this.isAssistantTurnSection(candidate) && this.elementHasGeneratedImage(candidate))
            return true;
        }
      }

      // Sibling fallback for older / alternate layouts where the sections
      // are direct siblings. Cheap and harmless when it doesn't apply.
      let cur: Element | null = turnSection.nextElementSibling;
      let visited = 0;
      while (cur && visited < 4) {
        visited++;
        if (cur instanceof HTMLElement) {
          if (this.isUserTurnSection(cur)) break;
          if (this.isAssistantTurnSection(cur) && this.elementHasGeneratedImage(cur)) return true;
        }
        cur = cur.nextElementSibling;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * True when the section is a user prompt. ChatGPT migrated from
   * `data-message-author-role="user"` (still present in some layouts) to
   * `data-turn="user"` on the outer `<section data-testid="conversation-turn-*">`.
   * Check both so old and new chats classify correctly.
   */
  private isUserTurnSection(section: HTMLElement): boolean {
    if (section.getAttribute('data-turn') === 'user') return true;
    return !!section.querySelector('[data-message-author-role="user"]');
  }

  private isAssistantTurnSection(section: HTMLElement): boolean {
    if (section.getAttribute('data-turn') === 'assistant') return true;
    return !!section.querySelector('[data-message-author-role="assistant"]');
  }

  private elementHasGeneratedImage(el: HTMLElement): boolean {
    const imgs = el.querySelectorAll('img');
    for (const img of Array.from(imgs)) {
      const src = (img.getAttribute('src') || '').toLowerCase();
      if (!src) continue;
      // Tile-style attachments the user sent live under different routes; we
      // only count actual generated content from ChatGPT's image pipeline.
      // ChatGPT migrated DALL-E / native image outputs to the `estuary`
      // backend endpoint (`/backend-api/estuary/content?id=file_…`) — the
      // older oaiusercontent / dalle URLs are still around for legacy
      // conversations.
      if (
        src.includes('oaiusercontent.com') ||
        src.includes('dalle') ||
        src.includes('image-gen') ||
        src.includes('files.oaiusercontent.com') ||
        src.includes('/backend-api/estuary/content') ||
        src.includes('/backend-api/files/')
      ) {
        // Avatars and tiny icons are well under 100px; generated images are
        // always larger. Use the natural size when available, fall back to
        // the rendered width.
        const w = img.naturalWidth || img.width || 0;
        if (w === 0 || w > 120) return true;
      }
    }
    // Some image generations render via a styled <div> placeholder while
    // streaming. We can pick those up by their distinctive role wrappers.
    if (el.querySelector('[data-testid*="image-generation"], [class*="image-gen"]')) {
      return true;
    }
    return false;
  }

  /**
   * Mount / refresh the per-dot accent children: gold favorite star, file
   * attachment capsules on the left of the bar, or — when the assistant
   * generated an image in reply — a small photo icon that takes the
   * capsules' place. All three are pure visual overlays with
   * `pointer-events: none` so click handling on the dot itself is untouched.
   */
  private updateDotIndicators(
    dot: DotElement,
    marker: {
      starred?: boolean;
      attachments?: ReadonlyArray<AttachmentInfo>;
      hasGeneratedImage?: boolean;
    },
  ): void {
    // Test fixtures sometimes hand us a partial marker shape; treat the new
    // attachment/image flags as soft-optional so this never explodes.
    const starred = !!marker.starred;
    const attachments = marker.attachments ?? [];
    const hasGeneratedImage = !!marker.hasGeneratedImage;

    // Gold star (favorited) — overlay centered inside the dot core.
    let star = dot.querySelector(':scope > .timeline-dot-favorite') as HTMLElement | null;
    if (starred) {
      if (!star) {
        star = document.createElement('span');
        star.className = 'timeline-dot-favorite';
        star.setAttribute('aria-hidden', 'true');
        // Rounded-corner star: same 5-point silhouette but with
        // stroke-linejoin="round" + matching stroke so the tips and inner
        // vertices read as soft pebble shapes instead of needle points.
        star.innerHTML =
          '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">' +
          '<path d="M12 2.7l2.7 6.45 6.95.55-5.3 4.55 1.65 6.8L12 17.4l-6 3.65 1.65-6.8-5.3-4.55 6.95-.55L12 2.7z"/>' +
          '</svg>';
        dot.appendChild(star);
      }
    } else if (star) {
      star.remove();
    }

    // Left-side accent: image-gen icon takes priority over the attachment
    // capsules, since "user gave a file AND assistant generated an image" is
    // rare and "what came out" is the more memorable signal for review.
    let accent = dot.querySelector(':scope > .timeline-dot-accent') as HTMLElement | null;
    const wantImage = hasGeneratedImage;
    const wantCapsules = !wantImage && attachments.length > 0;

    if (!wantImage && !wantCapsules) {
      accent?.remove();
      return;
    }

    if (!accent) {
      accent = document.createElement('span');
      accent.className = 'timeline-dot-accent';
      accent.setAttribute('aria-hidden', 'true');
      dot.appendChild(accent);
    }

    if (wantImage) {
      accent.dataset.kind = 'image';
      accent.innerHTML =
        '<span class="timeline-dot-accent-image"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M21 17l-5-5-9 9"/></svg></span>';
      return;
    }

    accent.dataset.kind = 'files';
    accent.textContent = '';
    // Cap at the first two attachments so the strip never overflows the
    // bar's left gutter; the third file (if any) lives only in the preview.
    const limited = attachments.slice(0, 2);
    for (const att of limited) {
      const pill = document.createElement('span');
      pill.className = 'timeline-dot-accent-pill';
      pill.style.setProperty('--gv-accent-color', ATTACHMENT_COLOR[att.type]);
      accent.appendChild(pill);
    }
  }

  private ensureTurnId(
    el: Element,
    index: number,
    usedIds: Set<string>,
    existingTurnIdOwners: Map<string, HTMLElement[]>,
    previousMarkerElementsById: Map<string, Set<HTMLElement>>,
  ): string {
    const asEl = el as HTMLElement & { dataset?: DOMStringMap & { turnId?: string } };
    const rawExistingId = asEl.dataset?.turnId?.trim() || '';
    // ChatGPT now puts a bare UUID on the outer section's `data-turn-id`
    // (e.g. `0c1c9d89-...`) while we historically allocated marker ids as
    // `u-<uuid>` and persisted pins / starred / hierarchy under that form.
    // Reading the bare UUID as-is would silently change every marker's id
    // and orphan all stored pins. Normalise on the way in.
    const existingId =
      rawExistingId && this.looksLikeUuid(rawExistingId) ? `u-${rawExistingId}` : rawExistingId;
    if (
      existingId &&
      this.shouldKeepExistingTurnId(
        existingId,
        asEl,
        usedIds,
        existingTurnIdOwners,
        previousMarkerElementsById,
      )
    ) {
      usedIds.add(existingId);
      this.turnIdByIndex.set(index, existingId);
      // Persist the normalised form back so downstream selector lookups
      // (`querySelector('[data-turn-id="${targetId}"]')`) keep working.
      try {
        if (asEl.dataset) asEl.dataset.turnId = existingId;
      } catch {}
      return existingId;
    }

    const id = this.allocateTurnId(asEl, index, usedIds, existingTurnIdOwners);
    try {
      if (asEl.dataset) asEl.dataset.turnId = id;
    } catch {}
    usedIds.add(id);
    this.turnIdByIndex.set(index, id);
    return id;
  }

  private detectCssVarTopSupport(pad: number, usableC: number): boolean {
    try {
      const test = document.createElement('button');
      test.className = 'timeline-dot';
      test.style.visibility = 'hidden';
      test.setAttribute('aria-hidden', 'true');
      test.style.setProperty('--n', '0.5');
      this.ui.trackContent!.appendChild(test);
      const cs = getComputedStyle(test);
      const px = parseFloat(cs.top || '');
      test.remove();
      const expected = pad + 0.5 * usableC;
      return Number.isFinite(px) && Math.abs(px - expected) <= 2;
    } catch {
      return false;
    }
  }

  private updateTimelineGeometry(): void {
    if (!this.ui.timelineBar || !this.ui.trackContent) return;
    const H = this.ui.timelineBar.clientHeight || 0;
    const pad = this.getTrackPadding();
    const minGap = this.getMinGap();
    const N = this.markers.length;
    // Get hidden markers for collapse feature
    const hiddenIndices = this.getHiddenMarkerIndices();
    const visibleCount = N - hiddenIndices.size;
    const desired = Math.max(
      H,
      visibleCount > 0 ? 2 * pad + Math.max(0, visibleCount - 1) * minGap : H,
    );
    this.contentHeight = Math.ceil(desired);
    this.scale = H > 0 ? this.contentHeight / H : 1;
    this.ui.trackContent.style.height = `${this.contentHeight}px`;

    const usableC = Math.max(1, this.contentHeight - 2 * pad);
    // Calculate Y positions with collapse - using effective baseN for repositioning
    const { desiredY } = this.calculateCollapsedPositions(hiddenIndices, pad, usableC);

    // Apply min gap only to visible markers
    const gapMultipliers: number[] = new Array(N).fill(1.0);
    const adjusted = this.applyMinGapWithHidden(
      desiredY,
      pad,
      pad + usableC,
      minGap,
      hiddenIndices,
      gapMultipliers,
    );
    this.yPositions = adjusted;

    for (let i = 0; i < N; i++) {
      if (hiddenIndices.has(i)) {
        this.markers[i].n = -1;
        continue;
      }
      const top = adjusted[i];
      const n = (top - pad) / usableC;
      this.markers[i].n = Math.max(0, Math.min(1, n));
      const dot = this.markers[i].dotElement;
      if (dot && !this.usePixelTop) {
        dot.style.setProperty('--n', String(this.markers[i].n));
      }
    }
    if (this._cssVarTopSupported === null) {
      this._cssVarTopSupported = this.detectCssVarTopSupport(pad, usableC);
      this.usePixelTop = !this._cssVarTopSupported;
    }
    this.updateSlider();
    const barH = this.ui.timelineBar.clientHeight || 0;
    this.sliderAlwaysVisible = this.contentHeight > barH + 1;
    if (this.sliderAlwaysVisible) this.showSlider();
  }

  /* Apply minimum gap between visible markers, skipping hidden ones */
  private applyMinGapWithHidden(
    positions: number[],
    minTop: number,
    maxTop: number,
    gap: number,
    hiddenIndices: Set<number>,
    gapMultipliers: number[],
  ): number[] {
    const n = positions.length;
    if (n === 0) return positions;

    const out = positions.slice();
    let prevVisibleIdx = -1;
    for (let i = 0; i < n; i++) {
      if (hiddenIndices.has(i)) continue;

      if (prevVisibleIdx === -1) {
        out[i] = Math.max(minTop, Math.min(positions[i], maxTop));
      } else {
        const currentGap = gap * gapMultipliers[i];
        const minAllowed = out[prevVisibleIdx] + currentGap;
        out[i] = Math.max(positions[i], minAllowed);
      }
      prevVisibleIdx = i;
    }
    let lastVisibleIdx = -1;
    for (let i = n - 1; i >= 0; i--) {
      if (!hiddenIndices.has(i)) {
        lastVisibleIdx = i;
        break;
      }
    }

    if (lastVisibleIdx >= 0 && out[lastVisibleIdx] > maxTop) {
      out[lastVisibleIdx] = maxTop;

      let nextVisibleIdx = lastVisibleIdx;
      for (let i = lastVisibleIdx - 1; i >= 0; i--) {
        if (hiddenIndices.has(i)) continue;

        const currentGap = gap * gapMultipliers[nextVisibleIdx];
        const maxAllowed = out[nextVisibleIdx] - currentGap;
        out[i] = Math.min(out[i], maxAllowed);
        nextVisibleIdx = i;
      }
    }

    // Clamp all visible markers
    for (let i = 0; i < n; i++) {
      if (hiddenIndices.has(i)) continue;
      if (out[i] < minTop) out[i] = minTop;
      if (out[i] > maxTop) out[i] = maxTop;
    }

    return out;
  }

  private applyMinGap(positions: number[], minTop: number, maxTop: number, gap: number): number[] {
    const n = positions.length;
    if (n === 0) return positions;
    const out = positions.slice();
    out[0] = Math.max(minTop, Math.min(positions[0], maxTop));
    for (let i = 1; i < n; i++) {
      const minAllowed = out[i - 1] + gap;
      out[i] = Math.max(positions[i], minAllowed);
    }
    if (out[n - 1] > maxTop) {
      out[n - 1] = maxTop;
      for (let i = n - 2; i >= 0; i--) {
        const maxAllowed = out[i + 1] - gap;
        out[i] = Math.min(out[i], maxAllowed);
      }
      if (out[0] < minTop) {
        out[0] = minTop;
        for (let i = 1; i < n; i++) {
          const minAllowed = out[i - 1] + gap;
          out[i] = Math.max(out[i], minAllowed);
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (out[i] < minTop) out[i] = minTop;
      if (out[i] > maxTop) out[i] = maxTop;
    }
    return out;
  }

  private recalculateAndRenderMarkers = (): void => {
    if (this.shouldDeferMarkerRecalculation()) {
      this.scheduleDeferredMarkerRecalculation();
      return;
    }

    if (
      !this.conversationContainer ||
      !this.ui.timelineBar ||
      !this.scrollContainer ||
      !this.userTurnSelector
    )
      return;
    const userTurnNodeList = this.conversationContainer.querySelectorAll(this.userTurnSelector);
    this.visibleRange = { start: 0, end: -1 };
    if (userTurnNodeList.length === 0) {
      this.updateTimestampTracking([]);
      if (!this.zeroTurnsTimer) {
        // Optimized retry interval: reduced from 350ms to 200ms
        this.zeroTurnsTimer = window.setTimeout(() => {
          this.zeroTurnsTimer = null;
          this.recalculateAndRenderMarkers();
        }, 200);
      }
      return;
    }
    if (this.zeroTurnsTimer) {
      clearTimeout(this.zeroTurnsTimer);
      this.zeroTurnsTimer = null;
    }

    // Build map of existing dots by turn ID for reuse (prevents hover/click disruption)
    const oldDots = new Map<string, DotElement>();
    for (const m of this.markers) {
      if (m.dotElement) oldDots.set(m.id, m.dotElement);
    }

    // Filter to top-level matches first to avoid nested duplicates, then dedupe by text+position
    let allEls = Array.from(userTurnNodeList) as HTMLElement[];
    allEls = this.filterTopLevel(allEls);
    if (allEls.length === 0) return;
    this.refreshScrollContainerForElement(allEls[0]);

    let allTops = this.computeElementTopsInScrollContainer(allEls);
    if (allTops.length !== allEls.length) {
      allTops = allEls.map((element) => this.computeElementTopInScrollContainer(element));
    }
    const deduped = this.dedupeByTextAndTop(allEls, allTops);
    allEls = deduped.elements;
    allTops = deduped.tops;
    this.markerTops = allTops;
    const usedTurnIds = new Set<string>();
    const existingTurnIdOwners = this.collectExistingTurnIdOwners(allEls);
    const previousMarkerElementsById = this.collectPreviousMarkerElementsById();
    const nextIds = allEls.map((element, index) =>
      this.ensureTurnId(
        element,
        index,
        usedTurnIds,
        existingTurnIdOwners,
        previousMarkerElementsById,
      ),
    );
    if (this.shouldConfirmMarkerOrderChange(nextIds)) {
      this.scheduleMarkerOrderChangeConfirmation(nextIds);
      return;
    }
    this.pendingMarkerOrderSignature = null;

    let contentSpan: number;
    const firstTurnTop = allTops[0] ?? this.computeElementTopInScrollContainer(allEls[0]);
    if (allEls.length < 2) {
      contentSpan = 1;
    } else {
      const lastTurnTop =
        allTops[allTops.length - 1] ??
        this.computeElementTopInScrollContainer(allEls[allEls.length - 1]);
      contentSpan = lastTurnTop - firstTurnTop;
    }
    if (contentSpan <= 0) contentSpan = 1;
    this.firstUserTurnOffset = firstTurnTop;
    this.contentSpanPx = contentSpan;

    this.markerMap.clear();
    // Edit-detection accumulator: set true if any (non-final) turn's live
    // content fingerprint differs from its cached fingerprint. That's the
    // semantic "user edited a turn (or assistant regenerated)" signal — we
    // ONLY prune the cache when this fires, so progressive React hydration
    // of a long conversation (where most turns aren't mounted yet) doesn't
    // mistakenly wipe their cached snapshots.
    let editDetected = false;
    this.markers = Array.from(allEls).map((el, idx) => {
      const element = el as HTMLElement;
      const elementTop = allTops[idx] ?? this.computeElementTopInScrollContainer(element);
      const offsetFromStart = elementTop - firstTurnTop;
      let n = offsetFromStart / contentSpan;
      n = Math.max(0, Math.min(1, n));
      const id = nextIds[idx];
      const liveAttachments = extractAttachments(element);
      const liveSummary = this.stripAttachmentNamesFromSummary(
        this.extractTurnText(element),
        liveAttachments,
      );
      const liveHasImage = this.detectGeneratedImageAfterTurn(element);

      // Outer wrapper survives ChatGPT's virtualisation with a stable
      // offsetTop, but its inner content collapses to "" when virtualised.
      // Fall back to the persistent turn-text cache so the tooltip / preview
      // / attachment chips stay populated through scrolling AND across page
      // reloads — refresh the cache whenever we *do* see real content so it
      // tracks edits.
      const cached = this.turnTextCache.get(id);
      const hasLiveContent = liveSummary.length > 0 || liveAttachments.length > 0;
      const summary = hasLiveContent || !cached ? liveSummary : cached.summary;
      const attachments = hasLiveContent || !cached ? liveAttachments : cached.attachments;
      const hasGeneratedImage = hasLiveContent || !cached ? liveHasImage : cached.hasGeneratedImage;

      if (hasLiveContent) {
        const liveFingerprint = computeFingerprint(liveSummary, liveAttachments);
        // Content drift relative to cache = user has edited this turn (or
        // assistant regenerated it). Skip the trailing turn though: it's
        // currently streaming, and its summary mutates from "" → "I'm" →
        // "I'm thinking..." continuously, which isn't an edit signal.
        if (cached && cached.fingerprint !== liveFingerprint && idx < allEls.length - 1) {
          editDetected = true;
        }
        this.turnTextCache.set({
          id,
          summary: liveSummary,
          attachments: liveAttachments,
          hasGeneratedImage: liveHasImage,
          lastSeenAt: Date.now(),
          fingerprint: liveFingerprint,
        });
      } else if (cached) {
        this.turnTextCache.touch(id);
      }

      const m = {
        id,
        element,
        summary,
        n,
        baseN: n,
        dotElement: oldDots.get(id) ?? null,
        starred: this.starred.has(id),
        attachments,
        hasGeneratedImage,
      };
      oldDots.delete(id);
      this.markerMap.set(id, m);
      return m;
    });

    if (editDetected) {
      // A turn's content actually changed under us — that means the user
      // edited a message (or assistant regenerated). ChatGPT forks the
      // conversation at the edit point and assigns fresh turn-ids to every
      // subsequent turn; the old turn-ids will never appear in this DOM
      // again. Now is the right moment to drop their stale cache entries.
      //
      // We intentionally do NOT prune on every reconcile pass — progressive
      // React hydration on long-conversation reload only mounts a handful
      // of outer wrappers initially, and unconditional pruning would treat
      // every not-yet-mounted turn as deleted, wiping the cache that this
      // whole module exists to provide.
      this.turnTextCache.prune(new Set(nextIds));
    }
    this.maybeAdoptDraftRouteTimestamps(this.markers.map((marker) => marker.id));
    this.updateTimestampTracking(this.markers.map((marker) => marker.id));
    // Remove orphaned dots (old dots not reused by any new marker)
    for (const dot of oldDots.values()) dot.remove();
    this.markersVersion++;
    this.updateTimelineGeometry();
    if (!this.activeTurnId && this.markers.length > 0)
      this.activeTurnId = this.markers[this.markers.length - 1].id;
    this.updateIntersectionObserverTargetsFromMarkers();
    this.syncTimelineTrackToMain();
    this.updateVirtualRangeAndRender();
    this.updateAllPinDotStates();
    this.renderTextPinBadges();
    this.updateActiveDotStateOnly();
    this.scheduleScrollSync();
    this.previewPanel?.updateMarkers(
      this.markers.map((m, i) => ({
        id: m.id,
        summary: m.summary,
        index: i,
        starred: m.starred,
        starredAt: m.starred ? this.starredAtMap.get(m.id) : undefined,
        attachments: m.attachments,
      })),
    );
    // Inject timestamps after markers are ready
    this.injectMessageTimestamps().catch(() => {});
  };

  private shouldDeferMarkerRecalculation(): boolean {
    if (this.markers.length === 0) return false;
    if (this.isScrollInteractionActive()) return true;
    if (!this.lastUserScrollAt) return false;
    const now =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    return now - this.lastUserScrollAt < this.markerRecalcScrollIdleDelay;
  }

  private isScrollInteractionActive(): boolean {
    if (!this.scrollContainer) return false;
    const now =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    if (this.lastUserScrollAt && now - this.lastUserScrollAt < this.markerRecalcScrollIdleDelay) {
      return true;
    }

    const currentScrollTop = this.scrollContainer.scrollTop || 0;
    if (
      this.lastObservedScrollTop >= 0 &&
      Math.abs(currentScrollTop - this.lastObservedScrollTop) > 1
    ) {
      this.lastObservedScrollTop = currentScrollTop;
      this.recordUserScrollActivity();
      return true;
    }

    const currentFirstMarkerTop =
      this.markers[0]?.element?.getBoundingClientRect().top ?? Number.NaN;
    if (
      Number.isFinite(currentFirstMarkerTop) &&
      Number.isFinite(this.lastObservedFirstMarkerTop) &&
      Math.abs(currentFirstMarkerTop - this.lastObservedFirstMarkerTop) > 1
    ) {
      this.lastObservedFirstMarkerTop = currentFirstMarkerTop;
      this.recordUserScrollActivity();
      return true;
    }

    return false;
  }

  private scheduleDeferredMarkerRecalculation(): void {
    if (this.deferredMarkerRecalcTimerId !== null) {
      window.clearTimeout(this.deferredMarkerRecalcTimerId);
    }
    const now =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const delay = Math.max(
      80,
      this.markerRecalcScrollIdleDelay - Math.max(0, now - this.lastUserScrollAt),
    );
    this.deferredMarkerRecalcTimerId = window.setTimeout(() => {
      this.deferredMarkerRecalcTimerId = null;
      this.recalculateAndRenderMarkers();
    }, delay);
  }

  private shouldConfirmMarkerOrderChange(nextIds: string[]): boolean {
    if (this.markers.length === 0 || nextIds.length === 0) return false;
    const currentIds = this.markers.map((marker) => marker.id);
    const orderChanged =
      currentIds.length !== nextIds.length || currentIds.some((id, index) => nextIds[index] !== id);
    if (!orderChanged) return false;

    const signature = nextIds.join('|');
    if (this.pendingMarkerOrderSignature === signature && !this.isScrollInteractionActive()) {
      return false;
    }
    return this.pendingMarkerOrderSignature !== signature;
  }

  private scheduleMarkerOrderChangeConfirmation(nextIds: string[]): void {
    this.pendingMarkerOrderSignature = nextIds.join('|');
    if (this.pendingMarkerOrderTimerId !== null) {
      window.clearTimeout(this.pendingMarkerOrderTimerId);
    }
    this.pendingMarkerOrderTimerId = window.setTimeout(() => {
      this.pendingMarkerOrderTimerId = null;
      this.recalculateAndRenderMarkers();
    }, this.markerOrderChangeConfirmDelay);
  }

  private async injectMessageTimestamps(): Promise<void> {
    if (!this.timestampService || !this.conversationId) return;
    const timestampService = this.timestampService;
    const conversationId = this.conversationId;
    if (!this.showMessageTimestampsEnabled) {
      // Remove any existing timestamps if feature is disabled
      document.querySelectorAll('.gv-timestamp').forEach((el) => el.remove());
      return;
    }

    const activeTurnIds = new Set<string>();
    const existingTimestampEls = new Map<string, HTMLElement>();
    document.querySelectorAll<HTMLElement>('.gv-timestamp[data-gv-turn-id]').forEach((el) => {
      const turnId = el.getAttribute('data-gv-turn-id') || '';
      if (!turnId) {
        el.remove();
        return;
      }
      existingTimestampEls.set(turnId, el);
    });

    // Use markers instead of querying DOM - markers already have the correct elements
    this.markers.forEach((marker) => {
      activeTurnIds.add(marker.id);
      const msgEl = marker.element;
      const parent = msgEl.parentElement;
      if (!parent) {
        existingTimestampEls.get(marker.id)?.remove();
        existingTimestampEls.delete(marker.id);
        return;
      }

      let insertionParent: HTMLElement | null = parent;
      let insertionAnchor: HTMLElement = msgEl;
      let alignClass = 'gv-timestamp-assistant';
      const existingTimestampEl = existingTimestampEls.get(marker.id) ?? null;
      try {
        // Walk up to find the nearest horizontal row wrapper (avatar + bubble).
        // Then insert timestamp before that row so it is always above the whole message row.
        let rowWrapper: HTMLElement | null = null;
        let cursor: HTMLElement | null = parent;
        for (let i = 0; i < 4 && cursor; i++) {
          const style = getComputedStyle(cursor);
          if (style.display.includes('flex') && style.flexDirection.startsWith('row')) {
            rowWrapper = cursor;
            break;
          }
          cursor = cursor.parentElement;
        }
        if (rowWrapper && rowWrapper.parentElement) {
          insertionParent = rowWrapper.parentElement as HTMLElement;
          insertionAnchor = rowWrapper;
          const rowStyle = getComputedStyle(rowWrapper);
          if (rowStyle.justifyContent.includes('flex-end')) {
            alignClass = 'gv-timestamp-user';
          }
        }
      } catch {}
      if (!insertionParent) {
        return;
      }

      const timestamp = timestampService.getTimestamp(conversationId, marker.id as TurnId);
      if (timestamp == null) {
        existingTimestampEls.get(marker.id)?.remove();
        existingTimestampEls.delete(marker.id);
        return;
      }

      const formattedTime = timestampService.formatAbsoluteTime(timestamp);
      const desiredClassName = `gv-timestamp ${alignClass}`;
      const timestampEl = existingTimestampEl ?? document.createElement('div');
      timestampEl.setAttribute('data-gv-turn-id', marker.id);
      if (timestampEl.className !== desiredClassName) {
        timestampEl.className = desiredClassName;
      }
      if (timestampEl.textContent !== formattedTime) {
        timestampEl.textContent = formattedTime;
      }

      if (
        timestampEl.parentElement !== insertionParent ||
        timestampEl.nextSibling !== insertionAnchor
      ) {
        // Render timestamp above the message container (outside the bubble)
        insertionParent.insertBefore(timestampEl, insertionAnchor);
      }

      existingTimestampEls.delete(marker.id);
    });

    existingTimestampEls.forEach((el, turnId) => {
      if (!activeTurnIds.has(turnId)) {
        el.remove();
      }
    });
  }

  private async loadMessageTimestampsEnabledSetting(): Promise<void> {
    const enabledResult = await storageService.get<boolean>(StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS);
    this.showMessageTimestampsEnabled = enabledResult.success && enabledResult.data === true;
  }

  private setupObservers(): void {
    this.mutationObserver = new MutationObserver((records) => {
      if (this.shouldIgnoreTimestampMutations(records)) return;
      this.debouncedRecalc();
    });
    if (this.conversationContainer)
      this.mutationObserver.observe(this.conversationContainer, { childList: true, subtree: true });

    this.resizeObserver = new ResizeObserver(() => {
      this.refreshTimelineAfterLayoutChange();
      this.positionPinControls();
      this.schedulePinBadgePositionUpdate();
    });
    if (this.ui.timelineBar) this.resizeObserver.observe(this.ui.timelineBar);

    this.intersectionObserver = new IntersectionObserver(
      () => {
        this.scheduleScrollSync();
      },
      { root: this.scrollContainer, threshold: 0.1, rootMargin: '-40% 0px -59% 0px' },
    );
  }

  /**
   * One-shot cleanup of localStorage entries left over from the project's
   * Gemini-Voyager ancestry. The active code path only ever writes the
   * `gpt*` / `gv-*` namespaces, but old installs accumulated parallel
   * `geminiTimeline*` keys that no longer get read. Strip them so storage
   * doesn't quietly fork between two schemas forever.
   */
  private purgeLegacyLocalStorageKeys(): void {
    try {
      const drop: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (k.startsWith('geminiTimeline')) drop.push(k);
      }
      for (const k of drop) {
        try {
          localStorage.removeItem(k);
        } catch {}
      }
    } catch {}
  }

  private setupEventListeners(): void {
    this.onTimelineBarClick = (e: Event) => {
      this.recordUserScrollActivity();
      const dot = (e.target as HTMLElement).closest('.timeline-dot') as DotElement | null;
      if (!dot) return;
      const now = Date.now();
      if (now < (this.suppressClickUntil || 0)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const resolveTargetFromDot = (): { targetElement: HTMLElement | null; toIdx: number } => {
        // Use index lookup if available for robust handling of duplicate content
        const indexStr = dot.dataset.markerIndex;
        let targetElement: HTMLElement | null = null;
        let toIdx = -1;

        if (indexStr) {
          toIdx = parseInt(indexStr, 10);
          const marker = this.markers[toIdx];
          if (marker) {
            targetElement = marker.element;
          }
        }

        // Fallback to ID-based lookup if index fails
        if (!targetElement) {
          const targetId = dot.dataset.targetTurnId || '';
          if (!targetId) return { targetElement: null, toIdx: -1 };

          // ChatGPT's outer section advertises the bare UUID on
          // `data-turn-id`, while our marker ids use the `u-<uuid>` form.
          // Try both shapes so the fallback works whether the user clicked
          // on a freshly-rendered outer wrapper (bare) or one we already
          // normalised (prefixed).
          const bareTarget = targetId.startsWith('u-') ? targetId.slice(2) : targetId;
          targetElement =
            (this.conversationContainer?.querySelector(
              `[data-turn-id="${targetId}"], [data-turn-id="${bareTarget}"]`,
            ) as HTMLElement | null) ||
            this.markers.find((m) => m.id === targetId)?.element ||
            null;
          toIdx = this.markers.findIndex((m) => m.id === targetId);
        }

        return { targetElement, toIdx };
      };

      let { targetElement, toIdx } = resolveTargetFromDot();

      // On ChatGPT reload/rehydration, marker nodes or scroll container may become stale.
      // Refresh once and resolve target again to keep click navigation reliable.
      if (this.maybeRefreshMarkersForInteraction(targetElement)) {
        ({ targetElement, toIdx } = resolveTargetFromDot());
      }

      if (targetElement) {
        const fromIdx = this.getActiveIndex();
        // toIdx is already determined above
        const dur = this.computeFlowDuration(fromIdx, toIdx);
        if (this.scrollMode === 'flow' && fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx) {
          // Clear previous highlight immediately so runner motion is visually obvious.
          this.activeTurnId = null;
          this.updateActiveDotUI();
          this.startRunner(fromIdx, toIdx, dur);
        }
        const targetId = toIdx >= 0 ? this.markers[toIdx]?.id : dot.dataset.targetTurnId || null;
        this.focusTextPinsForTurn(targetId);
        this.smoothScrollTo(targetElement, dur, targetId);
      }
    };
    this.ui.timelineBar!.addEventListener('click', this.onTimelineBarClick);

    this.onScroll = () => {
      this.recordUserScrollActivity();
      const nextScrollTop = this.scrollContainer?.scrollTop ?? this.lastObservedScrollTop;
      if (this.lastObservedScrollTop >= 0) {
        const delta = nextScrollTop - this.lastObservedScrollTop;
        if (Math.abs(delta) > 1) {
          this.lastScrollDirection = delta > 0 ? 1 : -1;
          this.lastScrollDirectionAt =
            typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
        }
      }
      this.lastObservedScrollTop = nextScrollTop;
      // Skip the heavy sync work while our own click-jump animation is driving
      // the scroll. Without this guard, every scroll tick re-queues another
      // sync RAF, layering main-thread work on top of an already-running
      // animation. The smooth-scroll routine handles a single track sync at
      // the start; a full sync runs once when the animation lands (via
      // correctScrollToElement). Pin badge positioning still updates so any
      // active pin tracks the page smoothly during the jump — its own
      // `hasPinBadgePositionWork` guard keeps it free when no pins are active.
      if (this.isScrolling) {
        this.schedulePinBadgePositionUpdate();
        return;
      }
      this.scheduleScrollSync();
      this.schedulePinBadgePositionUpdate();
    };
    this.scrollContainer!.addEventListener('scroll', this.onScroll, { passive: true });
    this.onDocumentScroll = (e: Event) => {
      const target = e.target;
      if (this.isTimelineScrollEventTarget(target)) {
        return;
      }
      if (this.shouldRefreshScrollContainerFromEvent(target)) {
        this.adoptScrollContainerFromScrollEvent(target);
      }
      this.recordUserScrollActivity();
      // Same rationale as the primary onScroll guard: don't pile sync work
      // onto frames already running our click-jump animation. Pin badges still
      // track their target.
      if (this.isScrolling) {
        this.schedulePinBadgePositionUpdate();
        return;
      }
      this.scheduleScrollSync();
      this.schedulePinBadgePositionUpdate();
    };
    document.addEventListener('scroll', this.onDocumentScroll, {
      capture: true,
      passive: true,
    });
    window.addEventListener('scroll', this.onDocumentScroll, { passive: true });

    this.onTimelineWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.recordUserScrollActivity();
      const delta = e.deltaY || 0;
      this.scrollContainer!.scrollTop += delta;
      this.scheduleScrollSync();
      this.showSlider();
    };
    this.ui.timelineBar!.addEventListener('wheel', this.onTimelineWheel, { passive: false });

    this.onTimelineBarOver = (e: MouseEvent) => {
      const dot = (e.target as HTMLElement).closest('.timeline-dot') as DotElement | null;
      if (dot) this.showTooltipForDot(dot);
    };
    this.onTimelineBarOut = (e: MouseEvent) => {
      const fromDot = (e.target as HTMLElement).closest('.timeline-dot');
      const toDot = (e.relatedTarget as HTMLElement | null)?.closest?.('.timeline-dot');
      if (fromDot && !toDot) {
        const stillHoveringDot = this.ui.timelineBar?.querySelector('.timeline-dot:hover');
        if (!stillHoveringDot) this.hideTooltip();
      }
    };
    this.ui.timelineBar!.addEventListener('mouseover', this.onTimelineBarOver);
    this.ui.timelineBar!.addEventListener('mouseout', this.onTimelineBarOut);

    // Right-click context menu for level selection
    this.onContextMenu = (ev: MouseEvent) => {
      if (!this.markerLevelEnabled) return;
      const dot = (ev.target as HTMLElement).closest('.timeline-dot') as DotElement | null;
      if (!dot) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.showContextMenu(dot, ev.clientX, ev.clientY);
    };
    this.ui.timelineBar!.addEventListener('contextmenu', this.onContextMenu);

    // Close context menu when clicking elsewhere
    this.onDocumentClick = (ev: MouseEvent) => {
      if (this.contextMenu && !this.contextMenu.contains(ev.target as Node)) {
        this.hideContextMenu();
      }
      const target = ev.target as HTMLElement | null;
      if (
        this.selectedPinId &&
        target &&
        !target.closest('.timeline-pin-badge, .timeline-pin-delete, .timeline-pin-controls')
      ) {
        this.clearSelectedTextPin();
      }
    };
    document.addEventListener('click', this.onDocumentClick);

    this.onPinToggleClick = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.setPinMode(!this.pinMode);
    };
    this.onPinPrevClick = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.navigateActiveMessagePin(-1);
    };
    this.onPinNextClick = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.navigateActiveMessagePin(1);
    };
    this.pinToggleButton?.addEventListener('click', this.onPinToggleClick);
    this.pinPrevButton?.addEventListener('click', this.onPinPrevClick);
    this.pinNextButton?.addEventListener('click', this.onPinNextClick);
    this.onPinDeleteClick = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!this.selectedPinTurnId || !this.selectedPinId) return;
      this.removeTextPin(this.selectedPinTurnId, this.selectedPinId);
    };
    this.pinDeleteButton?.addEventListener('click', this.onPinDeleteClick);

    this.onDocumentPinClick = (ev: MouseEvent) => {
      this.handleDocumentPinClick(ev);
    };
    document.addEventListener('click', this.onDocumentPinClick, true);

    this.onPointerDown = (ev: PointerEvent) => {
      const dot = (ev.target as HTMLElement).closest('.timeline-dot') as DotElement | null;
      if (!dot) return;
      if (typeof ev.button === 'number' && ev.button !== 0) return;
      this.cancelLongPress();
      this.pressTargetDot = dot;
      this.pressStartPos = { x: ev.clientX, y: ev.clientY };
      dot.classList.add('holding');
      this.longPressTriggered = false;
      this.longPressTimer = window.setTimeout(() => {
        this.longPressTimer = null;
        if (!this.pressTargetDot) return;
        const id = this.pressTargetDot.dataset.targetTurnId!;
        this.toggleStar(id);
        this.longPressTriggered = true;
        this.suppressClickUntil = Date.now() + 350;
        this.refreshTooltipForDot(this.pressTargetDot!);
        this.pressTargetDot.classList.remove('holding');
      }, this.longPressDuration);
    };
    this.onPointerMove = (ev: PointerEvent) => {
      if (!this.pressTargetDot || !this.pressStartPos) return;
      const dx = ev.clientX - this.pressStartPos.x;
      const dy = ev.clientY - this.pressStartPos.y;
      if (dx * dx + dy * dy > this.longPressMoveTolerance * this.longPressMoveTolerance)
        this.cancelLongPress();
    };
    this.onPointerUp = () => this.cancelLongPress();
    this.onPointerCancel = () => this.cancelLongPress();
    this.onPointerLeave = (ev: PointerEvent) => {
      const dot = (ev.target as HTMLElement).closest('.timeline-dot') as DotElement | null;
      if (dot && dot === this.pressTargetDot) this.cancelLongPress();
    };
    this.ui.timelineBar!.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove, { passive: true });
    window.addEventListener('pointerup', this.onPointerUp, { passive: true });
    window.addEventListener('pointercancel', this.onPointerCancel, { passive: true });
    this.ui.timelineBar!.addEventListener('pointerleave', this.onPointerLeave);

    this.onWindowResize = () => {
      if (this.ui.tooltip?.classList.contains('visible')) {
        const activeDot = this.ui.timelineBar!.querySelector(
          '.timeline-dot:hover, .timeline-dot:focus',
        ) as DotElement | null;
        if (activeDot) this.refreshTooltipForDot(activeDot);
      }
      this.refreshTimelineAfterLayoutChange();
      this.positionPinControls();
      this.schedulePinBadgePositionUpdate();
      // Reapply position for responsive design (v2 format only)
      this.reapplyPosition();
    };
    window.addEventListener('resize', this.onWindowResize);
    if (window.visualViewport) {
      this.onVisualViewportResize = () => {
        this.refreshTimelineAfterLayoutChange();
        this.positionPinControls();
        this.schedulePinBadgePositionUpdate();
        // Reapply position for responsive design (v2 format only)
        this.reapplyPosition();
      };
      window.visualViewport.addEventListener('resize', this.onVisualViewportResize);
    }

    this.onSliderDown = (ev: PointerEvent) => {
      if (!this.ui.sliderHandle) return;
      try {
        this.ui.sliderHandle.setPointerCapture(ev.pointerId);
      } catch {}
      this.sliderDragging = true;
      this.showSlider();
      this.sliderStartClientY = ev.clientY;
      const rect = this.ui.sliderHandle.getBoundingClientRect();
      this.sliderStartTop = rect.top;
      this.onSliderMove = (e: PointerEvent) => this.handleSliderDrag(e);
      this.onSliderUp = (e: PointerEvent) => this.endSliderDrag(e);
      window.addEventListener('pointermove', this.onSliderMove);
      window.addEventListener('pointerup', this.onSliderUp, { once: true });
    };
    this.ui.sliderHandle?.addEventListener('pointerdown', this.onSliderDown);

    this.onBarEnter = () => this.showSlider();
    this.onBarLeave = () => this.hideSliderDeferred();
    this.onSliderEnter = () => this.showSlider();
    this.onSliderLeave = () => this.hideSliderDeferred();
    this.ui.timelineBar!.addEventListener('pointerenter', this.onBarEnter);
    this.ui.timelineBar!.addEventListener('pointerleave', this.onBarLeave);
    this.ui.slider?.addEventListener('pointerenter', this.onSliderEnter);
    this.ui.slider?.addEventListener('pointerleave', this.onSliderLeave);

    this.onBarPointerDown = (ev: PointerEvent) => {
      if ((ev.target as HTMLElement).closest('.timeline-dot, .timeline-thumb')) {
        return;
      }
      // Resize takes priority over position drag
      if (this.isInResizeEdge(ev)) {
        this.startResize(ev);
        return;
      }
      // Position drag only when enabled
      if (!this.draggable) return;
      this.barDragging = true;
      this.barStartPos = { x: ev.clientX, y: ev.clientY };
      const rect = this.ui.timelineBar!.getBoundingClientRect();
      this.barStartOffset = { x: rect.left, y: rect.top };
      this.ui.timelineBar!.setPointerCapture(ev.pointerId);
      this.onBarPointerMove = (e: PointerEvent) => this.handleBarDrag(e);
      this.onBarPointerUp = (e: PointerEvent) => this.endBarDrag(e);
      window.addEventListener('pointermove', this.onBarPointerMove);
      window.addEventListener('pointerup', this.onBarPointerUp, { once: true });
    };
    // Always attach pointerdown for resize (drag is gated by this.draggable inside)
    this.ui.timelineBar!.addEventListener('pointerdown', this.onBarPointerDown);

    // Cursor management: show resize cursor near inner edge
    this.onBarCursorMove = (ev: PointerEvent) => {
      if (this.resizing || this.barDragging) return;
      if (this.isInResizeEdge(ev)) {
        this.ui.timelineBar!.style.cursor = 'ew-resize';
      } else if (this.draggable) {
        this.ui.timelineBar!.style.cursor = 'move';
      } else {
        this.ui.timelineBar!.style.cursor = '';
      }
    };
    this.ui.timelineBar!.addEventListener('pointermove', this.onBarCursorMove);

    this.onStorage = (e: StorageEvent) => {
      if (!e || e.storageArea !== localStorage) return;
      const expectedKey = this.getStarsStorageKey();
      if (!expectedKey || e.key !== expectedKey) return;
      let nextArr: string[] = [];
      try {
        nextArr = JSON.parse(e.newValue || '[]') || [];
      } catch {
        nextArr = [];
      }
      const nextSet = new Set(nextArr.map(String));
      this.applyStarredIdSet(nextSet, false);
    };
    window.addEventListener('storage', this.onStorage);

    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      this.onChromeStorageChanged = (changes, areaName) => {
        if (areaName === 'local') {
          const starredChange = changes[StorageKeys.TIMELINE_STARRED_MESSAGES];
          if (starredChange) {
            this.applySharedStarredData(starredChange.newValue as StarredMessagesData | null);
          }

          const timelineHierarchyChange = changes[this.timelineHierarchyStorageKey];
          if (timelineHierarchyChange && this.conversationId) {
            const data = resolveTimelineHierarchyDataForStorageScope(
              {
                [this.timelineHierarchyStorageKey]: timelineHierarchyChange.newValue,
              },
              this.timelineHierarchyAccountScope?.accountKey,
              this.timelineHierarchyAccountScope?.routeUserId ?? null,
            );
            const conversationData = data.conversations[this.conversationId] || null;
            this.applyTimelineHierarchyConversationData(conversationData);
            if (this.timelineHierarchyStorageKey === StorageKeys.TIMELINE_HIERARCHY) {
              this.persistTimelineHierarchyToLegacyStorage();
            }
            this.updateTimelineGeometry();
            this.updateVirtualRangeAndRender();
          }
        }
        if (areaName === 'sync' || areaName === 'local') {
          const tsEnabledChange = changes[StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS];
          if (tsEnabledChange) {
            this.showMessageTimestampsEnabled = tsEnabledChange.newValue === true;
            this.injectMessageTimestamps().catch(() => {});
          }
        }
      };
      chrome.storage.onChanged.addListener(this.onChromeStorageChanged);
    }

    // Subscribe to EventBus for cross-component starred state synchronization
    this.eventBusUnsubscribers.push(
      eventBus.on('starred:removed', ({ conversationId, turnId }) => {
        // Only handle events for current conversation
        if (conversationId !== this.conversationId) return;

        // Update local starred set
        if (this.starred.has(turnId)) {
          this.starred.delete(turnId);
          this.starredAtMap.delete(turnId);
          this.saveStars();

          // Update marker UI
          const marker = this.markerMap.get(turnId);
          if (marker && marker.dotElement) {
            marker.starred = false;
            marker.dotElement.classList.remove('starred');
            marker.dotElement.setAttribute('aria-pressed', 'false');
          }

          console.log('[Timeline] Starred removed via EventBus:', turnId);
        }
      }),
    );

    this.eventBusUnsubscribers.push(
      eventBus.on('starred:added', ({ conversationId, turnId }) => {
        // Only handle events for current conversation
        if (conversationId !== this.conversationId) return;

        // Update local starred set
        if (!this.starred.has(turnId)) {
          this.starred.add(turnId);
          this.starredAtMap.set(turnId, Date.now());
          this.saveStars();

          // Update marker UI
          const marker = this.markerMap.get(turnId);
          if (marker && marker.dotElement) {
            marker.starred = true;
            marker.dotElement.classList.add('starred');
            marker.dotElement.setAttribute('aria-pressed', 'true');
          }

          console.log('[Timeline] Starred added via EventBus:', turnId);
        }
      }),
    );
  }

  private computeScrollTopForElement(targetElement: HTMLElement): number {
    const container = this.scrollContainer;
    if (!container) return 0;
    const containerRect = container.getBoundingClientRect();
    const targetRect = targetElement.getBoundingClientRect();
    return targetRect.top - containerRect.top + container.scrollTop;
  }

  private setActiveTurnFromNavigation(targetId?: string | null): void {
    if (!targetId) return;
    if (this.activeChangeTimer) {
      clearTimeout(this.activeChangeTimer);
      this.activeChangeTimer = null;
      this.pendingActiveId = null;
    }
    this.activeLockUntil =
      typeof performance !== 'undefined' && performance.now
        ? performance.now() + 700
        : Date.now() + 700;
    this.activeTurnId = targetId;
    this.updateActiveDotUI();
  }

  private correctScrollToElement(targetElement: HTMLElement, targetId?: string | null): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!this.scrollContainer || !targetElement.isConnected) {
          this.isScrolling = false;
          this.scrollAnimationLockUntil = 0;
          this.setActiveTurnFromNavigation(targetId);
          return;
        }

        const correctedPosition = this.computeScrollTopForElement(targetElement);
        if (Math.abs(this.scrollContainer.scrollTop - correctedPosition) > 2) {
          this.scrollContainer.scrollTop = correctedPosition;
        }

        this.setActiveTurnFromNavigation(targetId);
        this.isScrolling = false;
        this.scrollAnimationLockUntil = 0;
        this.scheduleScrollSync();
      });
    });
  }

  private smoothScrollTo(
    targetElement: HTMLElement,
    duration = 600,
    targetId?: string | null,
  ): void {
    if (!this.scrollContainer) return;
    const targetPosition = this.computeScrollTopForElement(targetElement);
    const startPosition = this.scrollContainer.scrollTop;
    const distance = targetPosition - startPosition;

    this.isScrolling = true;
    this.setProgrammaticScrollLock(duration);
    this.setActiveTurnFromNavigation(targetId);
    // Position the timeline-track once at animation start so the active dot is
    // visible in the bar throughout the jump. The per-frame scroll listener is
    // short-circuited during isScrolling, so without this single sync the track
    // would freeze at its previous position until the animation lands.
    this.syncTimelineTrackToMain();

    if (this.scrollMode === 'jump' || duration <= 0 || Math.abs(distance) < 2) {
      this.scrollContainer.scrollTop = targetPosition;
      this.correctScrollToElement(targetElement, targetId);
      return;
    }

    // === Spring overshoot warm-up ===
    // ChatGPT's virtualiser only mounts the inner body of turns roughly within
    // viewport ± rootMargin. If the user clicks a dot far away, we land on
    // the target with surrounding turns still virtualised — their dots in our
    // timeline show empty content until ChatGPT decides to mount them. To
    // pre-empt that, animate PAST the target in the direction of travel by
    // ~600px (so ChatGPT's IntersectionObserver fires on turns beyond the
    // target as we cross them), then settle back. After landing we re-run the
    // reconcile so the cache picks up newly-mounted content immediately.
    //
    // Bail out for short jumps (overshoot wouldn't help) and for jumps near
    // the conversation edges (no room to overshoot without clamping).
    const maxScroll = Math.max(
      0,
      this.scrollContainer.scrollHeight - this.scrollContainer.clientHeight,
    );
    const direction = Math.sign(distance) || 1;
    const overshootPx = 600;
    const overshootPos = Math.max(0, Math.min(maxScroll, targetPosition + direction * overshootPx));
    const overshootDelta = Math.abs(overshootPos - targetPosition);
    const overshootWorthwhile = overshootDelta > 200 && Math.abs(distance) > 400;

    if (overshootWorthwhile && typeof this.scrollContainer.scrollTo === 'function') {
      const phase1Duration = duration;
      const phase2Duration = 220;
      const settleAfter = phase1Duration + phase2Duration + 120;
      // Extend the programmatic-scroll lock so our own scroll handler doesn't
      // fight the two-phase animation.
      this.setProgrammaticScrollLock(settleAfter);
      try {
        this.scrollContainer.scrollTo({ top: overshootPos, behavior: 'smooth' });
      } catch {
        this.scrollContainer.scrollTop = overshootPos;
      }
      window.setTimeout(() => {
        if (!this.scrollContainer) return;
        try {
          this.scrollContainer.scrollTo({ top: targetPosition, behavior: 'smooth' });
        } catch {
          this.scrollContainer.scrollTop = targetPosition;
        }
      }, phase1Duration);
      window.setTimeout(() => {
        this.correctScrollToElement(targetElement, targetId);
        // ChatGPT has finished mounting the turns we passed through —
        // refresh the timeline so freshly-rendered content lands in cache
        // and the surrounding dots stop showing the empty-placeholder state.
        this.recalculateAndRenderMarkers();
      }, settleAfter);
      return;
    }

    // Use the browser's native smooth scroll. It runs on the compositor and
    // gives the same buttery feel as a real wheel scroll, which our hand-rolled
    // RAF loop never could because every animation frame had to share the main
    // thread with ChatGPT's own scroll handlers. Our `isScrolling` flag still
    // short-circuits the scroll listener so we don't pile on per-frame work.
    if (typeof this.scrollContainer.scrollTo === 'function') {
      try {
        this.scrollContainer.scrollTo({ top: targetPosition, behavior: 'smooth' });
      } catch {
        this.scrollContainer.scrollTop = targetPosition;
      }
    } else {
      this.scrollContainer.scrollTop = targetPosition;
    }
    // Native smooth scroll doesn't expose a completion callback. Estimate when
    // it will land using our requested duration (plus a small buffer) and run
    // the same correction routine the manual animation used to.
    const settleMs = Math.max(250, duration + 80);
    window.setTimeout(() => {
      this.correctScrollToElement(targetElement, targetId);
      // Even for short jumps without overshoot, surrounding turns may have
      // come into ChatGPT's mount range during the scroll — pick that up.
      this.recalculateAndRenderMarkers();
    }, settleMs);
  }

  private easeInOutQuad(t: number, b: number, c: number, d: number): number {
    // Overridable via spring profile
    const spring = (() => {
      try {
        return localStorage.getItem('gptTimelineSpring') || 'ios';
      } catch {
        return 'ios';
      }
    })();
    const clamp = (x: number) => Math.max(0, Math.min(1, x));
    const u = clamp(t / d);
    if (spring === 'snappy') {
      // Ease out back a bit then settle
      const s = 1.15; // overshoot
      const x = u < 0.6 ? u / 0.6 : 1 + (0.6 - u) * 0.15;
      return b + c * clamp(x * s - (s - 1));
    }
    if (spring === 'gentle') {
      // Smooth cubic ease-in-out
      return b + c * (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
    }
    // iOS-like spring-ish: ease out with slight acceleration then decel
    const k1 = 0.42,
      k2 = 0.58; // pseudo cubic bezier
    const s = u * u * (3 - 2 * u); // smoothstep baseline
    const mix = (a: number, b: number, m: number) => a + (b - a) * m;
    const shaped = mix(Math.pow(u, k1), Math.pow(u, k2), 0.5) * 0.15 + s * 0.85;
    return b + c * clamp(shaped);
  }

  private updateActiveDotUI(): void {
    this.ensureActiveDotVisible();
    this.updateActiveDotStateOnly();
  }

  private updateActiveDotStateOnly(): void {
    this.markers.forEach((marker) => {
      marker.dotElement?.classList.toggle('active', marker.id === this.activeTurnId);
    });
    this.previewPanel?.updateActiveTurn(this.activeTurnId);
    this.syncPreviewDomActiveTurn();
    this.schedulePreviewTurnIntoListView(this.activeTurnId);
    this.updatePinControlsState();
  }

  private scrollTimelineTrackToMarker(
    index: number,
    mode: 'nearest' | 'center' | 'visible' = 'nearest',
  ): boolean {
    if (!this.ui.track || !this.contentHeight || index < 0 || index >= this.yPositions.length) {
      return false;
    }

    const track = this.ui.track;
    const viewportHeight = track.clientHeight || 0;
    if (viewportHeight <= 0) return false;

    const maxScroll = Math.max(0, this.contentHeight - viewportHeight);
    const currentScrollTop = track.scrollTop || 0;
    const y = this.yPositions[index] || 0;
    const margin =
      mode === 'visible' ? 2 : Math.max(12, Math.min(48, Math.floor(viewportHeight * 0.2)));
    let nextScrollTop = currentScrollTop;

    if (mode === 'center') {
      nextScrollTop = y - viewportHeight / 2;
    } else {
      const visibleTop = currentScrollTop + margin;
      const visibleBottom = currentScrollTop + viewportHeight - margin;
      if (y < visibleTop) {
        nextScrollTop = y - margin;
      } else if (y > visibleBottom) {
        nextScrollTop = y - viewportHeight + margin;
      }
    }

    nextScrollTop = Math.max(0, Math.min(maxScroll, Math.round(nextScrollTop)));
    if (Math.abs(nextScrollTop - currentScrollTop) <= 1) return false;
    track.scrollTop = nextScrollTop;
    return true;
  }

  private ensureActiveDotVisible(): void {
    if (!this.activeTurnId || !this.ui.track || !this.ui.trackContent) return;

    const activeIndex = this.getActiveIndex();
    if (activeIndex < 0) return;

    const scrolled = this.scrollTimelineTrackToMarker(activeIndex);
    const activeMarker = this.markers[activeIndex];
    const activeDotRendered =
      !!activeMarker?.dotElement &&
      activeIndex >= this.visibleRange.start &&
      activeIndex <= this.visibleRange.end;

    if (scrolled || !activeDotRendered) {
      this.updateVirtualRangeAndRender();
    }
  }

  private isActiveDotRendered(): boolean {
    if (!this.activeTurnId) return true;
    const activeIndex = this.getActiveIndex();
    if (activeIndex < 0) return true;
    const marker = this.markers[activeIndex];
    return (
      !!marker?.dotElement &&
      activeIndex >= this.visibleRange.start &&
      activeIndex <= this.visibleRange.end
    );
  }

  private isActiveDotVisibleInTrack(): boolean {
    if (!this.activeTurnId || !this.ui.track) return true;
    const activeIndex = this.getActiveIndex();
    if (activeIndex < 0) return true;
    const dot = this.markers[activeIndex]?.dotElement;
    if (!dot) return false;
    const y = this.yPositions[activeIndex] || 0;
    const top = this.ui.track.scrollTop || 0;
    const bottom = top + (this.ui.track.clientHeight || 0);
    return y >= top && y <= bottom;
  }

  private syncPreviewDomActiveTurn(): void {
    const items = document.querySelectorAll('.timeline-preview-item');
    if (!items.length) return;
    let activeItem: HTMLElement | null = null;
    items.forEach((item) => {
      const el = item as HTMLElement;
      const isActive = !!this.activeTurnId && el.dataset.turnId === this.activeTurnId;
      el.classList.toggle('active', isActive);
      if (isActive) activeItem = el;
    });
    const activeEl = activeItem as HTMLElement | null;
    if (activeEl && document.querySelector('.timeline-preview-panel.visible')) {
      this.schedulePreviewItemIntoListView(activeEl);
    }
  }

  private schedulePreviewItemIntoListView(item: HTMLElement): void {
    this.scrollPreviewItemIntoListView(item);
    queueMicrotask(() => {
      if (item.isConnected) this.scrollPreviewItemIntoListView(item);
    });
    requestAnimationFrame(() => {
      if (item.isConnected) this.scrollPreviewItemIntoListView(item);
    });
    window.setTimeout(() => {
      if (item.isConnected) this.scrollPreviewItemIntoListView(item);
    }, 100);
    window.setTimeout(() => {
      if (item.isConnected) this.scrollPreviewItemIntoListView(item);
    }, 300);
    window.setTimeout(() => {
      if (item.isConnected) this.scrollPreviewItemIntoListView(item);
    }, 700);
  }

  private schedulePreviewTurnIntoListView(turnId: string | null): void {
    if (!turnId) return;
    const scroll = () => {
      const item = this.findPreviewItemByTurnId(turnId);
      if (item) this.scrollPreviewItemIntoListView(item);
    };
    scroll();
    queueMicrotask(scroll);
    requestAnimationFrame(scroll);
    window.setTimeout(scroll, 100);
    window.setTimeout(scroll, 300);
    window.setTimeout(scroll, 700);
  }

  private findPreviewItemByTurnId(turnId: string): HTMLElement | null {
    const items = document.querySelectorAll<HTMLElement>('.timeline-preview-item');
    for (const item of items) {
      if (item.dataset.turnId === turnId) return item;
    }
    return null;
  }

  private scrollPreviewItemIntoListView(item: HTMLElement): void {
    const listEl = item.closest('.timeline-preview-list') as HTMLElement | null;
    if (!listEl) return;

    const listRect = listEl.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const padding = 8;
    let nextScrollTop = listEl.scrollTop;

    if (itemRect.top < listRect.top + padding) {
      nextScrollTop += itemRect.top - listRect.top - padding;
    } else if (itemRect.bottom > listRect.bottom - padding) {
      nextScrollTop += itemRect.bottom - listRect.bottom + padding;
    } else {
      return;
    }

    const maxScrollTop = Math.max(0, listEl.scrollHeight - listEl.clientHeight);
    nextScrollTop = Math.max(0, Math.min(maxScrollTop, Math.round(nextScrollTop)));
    if (Math.abs(listEl.scrollTop - nextScrollTop) <= 1) return;
    listEl.scrollTop = nextScrollTop;
  }

  private getPinsStorageKey(): string | null {
    return this.conversationId ? `gptTimelineTextPins:${this.conversationId}` : null;
  }

  private loadTextPins(): void {
    this.pinsByTurn.clear();
    const key = this.getPinsStorageKey();
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { pins?: unknown } | unknown[];
      const rawPins = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.pins)
          ? parsed.pins
          : [];
      rawPins.forEach((item) => {
        if (!item || typeof item !== 'object') return;
        const pin = item as Partial<TimelineTextPin>;
        const turnId = typeof pin.turnId === 'string' ? pin.turnId : '';
        const id = typeof pin.id === 'string' ? pin.id : '';
        if (!turnId || !id) return;
        const normalized: TimelineTextPin = {
          id,
          turnId,
          xRatio: this.clamp01(Number(pin.xRatio)),
          xOffset: Math.max(0, Number.isFinite(Number(pin.xOffset)) ? Number(pin.xOffset) : 0),
          yRatio: this.clamp01(Number(pin.yRatio)),
          yOffset: Math.max(0, Number.isFinite(Number(pin.yOffset)) ? Number(pin.yOffset) : 0),
          text: typeof pin.text === 'string' ? pin.text.slice(0, 160) : '',
          createdAt: Number.isFinite(Number(pin.createdAt)) ? Number(pin.createdAt) : Date.now(),
        };
        const pins = this.pinsByTurn.get(turnId) ?? [];
        pins.push(normalized);
        this.pinsByTurn.set(turnId, pins);
      });
      this.pinsByTurn.forEach((pins) => pins.sort((a, b) => a.yOffset - b.yOffset));
    } catch {
      this.pinsByTurn.clear();
    }
  }

  private saveTextPins(): void {
    const key = this.getPinsStorageKey();
    if (!key) return;
    const pins = Array.from(this.pinsByTurn.values()).flat();
    this.safeLocalStorageSet(key, JSON.stringify({ version: 1, pins }));
  }

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
  }

  private setPinMode(enabled: boolean): void {
    this.pinMode = enabled;
    this.pinControls?.classList.toggle('pin-mode', enabled);
    this.pinToggleButton?.classList.toggle('active', enabled);
    this.pinToggleButton?.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    document.body.classList.toggle('timeline-pin-picking', enabled);
  }

  private getCurrentPinTurnId(): string | null {
    if (
      this.pinFocusTurnId &&
      this.markerMap.has(this.pinFocusTurnId) &&
      (this.pinsByTurn.get(this.pinFocusTurnId)?.length ?? 0) > 0
    ) {
      return this.pinFocusTurnId;
    }
    if (
      this.activeTurnId &&
      this.markerMap.has(this.activeTurnId) &&
      (this.pinsByTurn.get(this.activeTurnId)?.length ?? 0) > 0
    ) {
      return this.activeTurnId;
    }
    if (this.activeTurnId && this.markerMap.has(this.activeTurnId)) return this.activeTurnId;
    const index = this.getActiveIndex();
    return index >= 0 ? (this.markers[index]?.id ?? null) : null;
  }

  private getActivePinIndex(turnId: string): number {
    const pins = this.pinsByTurn.get(turnId) ?? [];
    if (!pins.length) return -1;
    const currentId = this.activePinByTurn.get(turnId);
    if (!currentId) return 0;
    const currentIndex = pins.findIndex((pin) => pin.id === currentId);
    return currentIndex >= 0 ? currentIndex : 0;
  }

  private updatePinControlsState(): void {
    const turnId = this.getCurrentPinTurnId();
    const pins = turnId ? (this.pinsByTurn.get(turnId) ?? []) : [];
    const count = pins.length;
    const activeIndex = turnId ? this.getActivePinIndex(turnId) : -1;
    if (this.pinPrevButton) this.pinPrevButton.disabled = activeIndex <= 0;
    if (this.pinNextButton)
      this.pinNextButton.disabled = activeIndex < 0 || activeIndex >= count - 1;
    this.pinControls?.setAttribute('data-pin-count', String(count));
  }

  private handleDocumentPinClick(ev: MouseEvent): void {
    if (!this.pinMode) return;
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    if (
      target.closest(
        '.timeline-pin-controls, .timeline-pin-badge, .gpt-timeline-bar, .timeline-preview-toggle, .timeline-preview-panel, .timeline-left-slider',
      )
    ) {
      return;
    }

    this.maybeRefreshMarkersForInteraction(target);
    const pinTarget = this.resolveTextPinTarget(target, ev.clientX, ev.clientY);
    if (!pinTarget) return;

    ev.preventDefault();
    ev.stopPropagation();
    this.addTextPin(pinTarget, ev.clientX, ev.clientY, target);
    this.setPinMode(false);
  }

  private resolveTextPinTarget(
    target: HTMLElement,
    clientX: number,
    clientY: number,
  ): TimelineTextPinTarget | null {
    if (!this.scrollContainer || this.markers.length === 0) {
      const directMarker = this.markers.find((item) => item.element.contains(target));
      if (!directMarker) return null;
      const rect = directMarker.element.getBoundingClientRect();
      const y = Math.max(0, clientY - rect.top);
      return {
        marker: directMarker,
        xOffset: Math.max(0, clientX - rect.left),
        xRatio: this.clamp01((clientX - rect.left) / Math.max(1, rect.width)),
        yOffset: y,
      };
    }

    if (
      this.conversationContainer &&
      !this.conversationContainer.contains(target) &&
      !this.scrollContainer.contains(target)
    ) {
      return null;
    }

    const scrollRect = this.scrollContainer.getBoundingClientRect();
    const clickTop = clientY - scrollRect.top + this.scrollContainer.scrollTop;
    // Pin anchor is the inner [data-message-author-role] body when present
    // (matches positionTextPinBadges / navigateToTextPin). Falls back to
    // marker.element (the outer wrapper) when the inner is virtualised —
    // although that's effectively never the case here, since a pin can
    // only be created on a clickable, on-page text node.
    const anchorOfMarker = (marker: { element: HTMLElement }): HTMLElement =>
      (marker.element.querySelector('[data-message-author-role]') as HTMLElement | null) ??
      marker.element;
    const currentMarkerTops = this.markers.map((marker) =>
      this.computeElementTopInScrollContainer(anchorOfMarker(marker)),
    );
    let ownerIndex = 0;
    for (let i = 0; i < this.markers.length; i++) {
      const top =
        currentMarkerTops[i] ??
        this.computeElementTopInScrollContainer(anchorOfMarker(this.markers[i]));
      if (top <= clickTop) ownerIndex = i;
      else break;
    }

    const marker =
      this.markers.find((item) => item.element.contains(target)) ?? this.markers[ownerIndex];
    if (!marker) return null;

    const ownerTop =
      currentMarkerTops[this.markers.findIndex((item) => item.id === marker.id)] ??
      this.computeElementTopInScrollContainer(anchorOfMarker(marker));
    const yOffset = Math.max(0, clickTop - ownerTop);
    const baseRect = (this.conversationContainer ?? this.scrollContainer).getBoundingClientRect();
    const xOffset = Math.max(0, clientX - baseRect.left);
    return {
      marker,
      xOffset,
      xRatio: this.clamp01(xOffset / Math.max(1, baseRect.width)),
      yOffset,
    };
  }

  private addTextPin(
    pinTarget: TimelineTextPinTarget,
    clientX: number,
    clientY: number,
    target: HTMLElement,
  ): void {
    const { marker } = pinTarget;
    const rect = marker.element.getBoundingClientRect();
    const y = pinTarget.yOffset;
    const pin: TimelineTextPin = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      turnId: marker.id,
      xRatio: pinTarget.xRatio,
      xOffset: pinTarget.xOffset,
      yRatio: this.clamp01(y / Math.max(1, rect.height)),
      yOffset: y,
      text: this.extractTextAroundPoint(clientX, clientY, target),
      createdAt: Date.now(),
    };
    const pins = this.pinsByTurn.get(marker.id) ?? [];
    pins.push(pin);
    pins.sort((a, b) => a.yOffset - b.yOffset);
    this.pinsByTurn.set(marker.id, pins);
    this.activePinByTurn.set(marker.id, pin.id);
    this.pinFocusTurnId = marker.id;
    this.activeTurnId = marker.id;
    this.saveTextPins();
    this.updatePinDotState(marker.id);
    this.renderTextPinBadges();
    this.updateActiveDotUI();
    this.schedulePinBadgePositionUpdate();
  }

  private extractTextAroundPoint(
    clientX: number,
    clientY: number,
    fallbackTarget: HTMLElement,
  ): string {
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
    };
    let node: Node | null = null;
    let offset = 0;
    const range = doc.caretRangeFromPoint?.(clientX, clientY);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    } else {
      const pos = doc.caretPositionFromPoint?.(clientX, clientY);
      if (pos) {
        node = pos.offsetNode;
        offset = pos.offset;
      }
    }

    // KaTeX renders math as a `.katex` subtree containing both `.katex-mathml`
    // (the source / accessibility tree) and `.katex-html` (the visible glyphs).
    // textContent of either branch yields raw LaTeX commands like `\boxed{...}`.
    // When the caret hits anywhere inside a katex tree, snap the pin text to
    // the parent paragraph's visible text instead so we don't bake source code
    // into the pin label.
    const katexAncestor = this.findKatexAncestor(node);
    if (katexAncestor) {
      const surroundingBlock =
        (katexAncestor.closest('p, li, blockquote, div.markdown, .prose') as HTMLElement | null) ||
        fallbackTarget;
      const cleaned = this.extractCleanInlineText(surroundingBlock);
      if (cleaned) return cleaned.slice(0, 80);
    }

    if (node?.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      const left = text
        .slice(0, offset)
        .search(/[^\s.,;:!?()[\]{}"'`，。！？；：（）【】《》、]*$/);
      const start = left >= 0 ? left : Math.max(0, offset - 24);
      const rightMatch = text
        .slice(offset)
        .match(/^[^\s.,;:!?()[\]{}"'`，。！？；：（）【】《》、]*/);
      const end = Math.min(text.length, offset + (rightMatch?.[0].length ?? 0));
      const word = this.stripLatexNoise(text.slice(start, end).trim());
      if (word) return word.slice(0, 80);
      const snippet = this.stripLatexNoise(
        text.slice(Math.max(0, offset - 24), Math.min(text.length, offset + 56)).trim(),
      );
      if (snippet) return snippet.slice(0, 80);
    }

    return this.extractCleanInlineText(fallbackTarget).slice(0, 80);
  }

  private findKatexAncestor(node: Node | null): HTMLElement | null {
    let cur: Node | null = node;
    while (cur && cur !== document.documentElement) {
      if (cur.nodeType === Node.ELEMENT_NODE) {
        const el = cur as HTMLElement;
        if (
          el.classList?.contains('katex') ||
          el.classList?.contains('katex-display') ||
          el.classList?.contains('katex-mathml') ||
          el.classList?.contains('katex-html')
        ) {
          return el;
        }
      }
      cur = cur.parentNode;
    }
    return null;
  }

  private extractCleanInlineText(el: HTMLElement | null): string {
    if (!el) return '';
    try {
      const clone = el.cloneNode(true) as HTMLElement;
      // Strip extension UI + ChatGPT chrome buttons (same as turn extraction).
      clone.querySelectorAll(INJECTED_UI_SELECTOR).forEach((n) => n.remove());
      clone.querySelectorAll(HOST_CHROME_SELECTOR).forEach((n) => n.remove());
      // Drop the LaTeX source tree; keep only what's rendered visually.
      clone
        .querySelectorAll('.katex-mathml, annotation, .katex-html .sr-only')
        .forEach((n) => n.remove());
      // Convert any `[data-user-latex-original]` placeholders back to the LaTeX
      // the user actually typed, then mark the substring so we can keep it
      // intact below.
      clone.querySelectorAll<HTMLElement>('[data-user-latex-original]').forEach((n) => {
        n.textContent = n.dataset.userLatexOriginal ?? n.textContent ?? '';
      });
      return this.stripLatexNoise(this.normalizeText(clone.textContent || ''));
    } catch {
      return this.stripLatexNoise(this.normalizeText(el.textContent || ''));
    }
  }

  /**
   * Safety net for legacy paths that bypass the DOM-level tile removal in
   * `extractTurnText`. If the filename still appears verbatim in the body
   * (e.g. the tile selector missed a variant), strip it. Normal flow already
   * removes the entire file tile up front, so this is usually a no-op.
   */
  private stripAttachmentNamesFromSummary(
    summary: string,
    attachments: ReadonlyArray<AttachmentInfo>,
  ): string {
    if (!summary) return summary;
    let out = summary;
    for (const att of attachments) {
      if (!att.name) continue;
      const escaped = att.name.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      out = out.replace(new RegExp(escaped, 'g'), '');
    }
    return out.replace(/\s{2,}/g, ' ').trim();
  }

  private stripLatexNoise(s: string): string {
    if (!s) return s;
    // Heuristic: collapse stray backslash-commands like \boxed{...} \text{...}
    // that occasionally slip through when text crosses a katex boundary. We
    // keep the curly-brace contents because they usually carry the visible
    // glyphs the user already sees rendered next door.
    return s
      .replace(/\\(?:boxed|text|mathrm|mathbf|mathit|operatorname)\s*\{([^{}]*)\}/g, '$1')
      .replace(/\\[A-Za-z]+\b/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  private renderTextPinBadges(): void {
    if (!this.pinBadgeLayer) return;
    const livePinIds = new Set<string>();
    for (const marker of this.markers) {
      const pins = this.pinsByTurn.get(marker.id) ?? [];
      for (const pin of pins) {
        livePinIds.add(pin.id);
        let badge = this.pinBadges.get(pin.id);
        if (!badge) {
          badge = document.createElement('button');
          badge.type = 'button';
          badge.className = 'timeline-pin-badge';
          badge.dataset.pinId = pin.id;
          badge.dataset.turnId = pin.turnId;
          badge.setAttribute('aria-label', pin.text ? `Select pin: ${pin.text}` : 'Select pin');
          badge.innerHTML =
            '<svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="m14 4 6 6"/><path d="m8 10 6-6 6 6-6 6"/><path d="m9 15-5 5"/><path d="m14 16-6-6"/></svg>';
          badge.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this.selectTextPin(pin, true);
          });
          this.pinBadgeLayer.appendChild(badge);
          this.pinBadges.set(pin.id, badge);
        }
        const isActive = this.activePinByTurn.get(pin.turnId) === pin.id;
        badge.classList.toggle('active', isActive);
        badge.classList.toggle('selected', this.selectedPinId === pin.id);
        badge.title = pin.text ? `Select pin: ${pin.text}` : 'Select pin';
      }
    }
    for (const [pinId, badge] of this.pinBadges) {
      if (!livePinIds.has(pinId)) {
        badge.remove();
        this.pinBadges.delete(pinId);
      }
    }
    this.schedulePinBadgePositionUpdate();
  }

  private selectTextPin(pin: TimelineTextPin, showDelete = false): void {
    this.activePinByTurn.set(pin.turnId, pin.id);
    this.pinFocusTurnId = pin.turnId;
    this.activeTurnId = pin.turnId;
    if (showDelete) {
      this.selectedPinId = pin.id;
      this.selectedPinTurnId = pin.turnId;
    } else {
      this.selectedPinId = null;
      this.selectedPinTurnId = null;
      this.hidePinDeleteButton();
    }
    this.renderTextPinBadges();
    this.updateActiveDotUI();
    this.schedulePinBadgePositionUpdate();
  }

  private clearSelectedTextPin(): void {
    if (!this.selectedPinId) return;
    this.selectedPinId = null;
    this.selectedPinTurnId = null;
    this.renderTextPinBadges();
    this.hidePinDeleteButton();
  }

  private focusTextPinsForTurn(turnId?: string | null): void {
    if (!turnId || !this.markerMap.has(turnId)) return;
    this.pinFocusTurnId = turnId;
    this.selectedPinId = null;
    this.selectedPinTurnId = null;
    const pins = this.pinsByTurn.get(turnId) ?? [];
    if (pins.length) {
      const currentId = this.activePinByTurn.get(turnId);
      if (!currentId || !pins.some((pin) => pin.id === currentId)) {
        this.activePinByTurn.set(turnId, pins[0].id);
      }
    }
    this.renderTextPinBadges();
    this.updatePinControlsState();
    this.hidePinDeleteButton();
  }

  private schedulePinBadgePositionUpdate(): void {
    if (!this.hasPinBadgePositionWork()) return;
    if (this.pinBadgePositionRaf !== null) return;
    this.pinBadgePositionRaf = requestAnimationFrame(() => {
      this.pinBadgePositionRaf = null;
      this.positionTextPinBadges();
    });
  }

  private hasPinBadgePositionWork(): boolean {
    return this.pinBadges.size > 0 || !!this.selectedPinId;
  }

  private positionTextPinBadges(): void {
    if (!this.hasPinBadgePositionWork()) return;
    const baseRect = this.conversationContainer?.getBoundingClientRect() ?? null;
    for (const marker of this.markers) {
      const pins = this.pinsByTurn.get(marker.id) ?? [];
      // Pins were historically anchored to the *inner*
      // `[data-message-author-role]` element which sits a few pixels below
      // the outer `<section>` (header padding etc.). The marker switched to
      // the outer wrapper so dots survive virtualisation; for pin badge
      // positioning we still prefer the inner anchor when it exists, so
      // existing pin yOffsets keep landing on the same on-page text. When
      // the inner is virtualised away we fall back to the outer — pin
      // visibility check below collapses the badge in that case anyway.
      const anchor =
        (marker.element.querySelector('[data-message-author-role]') as HTMLElement | null) ??
        marker.element;
      const rect = anchor.getBoundingClientRect();
      for (const pin of pins) {
        const badge = this.pinBadges.get(pin.id);
        if (!badge) continue;
        const yOffset = Math.max(0, pin.yOffset || pin.yRatio * rect.height);
        const y = rect.top + yOffset;
        // Visibility used to require `rect.width > 0 && rect.height > 0`,
        // but ChatGPT collapses the outer `<section>` wrapper of a
        // virtualised turn to height = 0 while preserving its document-flow
        // top. In a long conversation, the user turn that anchors a pin in
        // the following long assistant answer goes through this state once
        // the reader scrolls past it: BCR.height = 0, BCR.top = a real
        // negative-or-positive viewport y. The Y projection above
        // (`rect.top + yOffset`) still lands in the correct viewport
        // position, so the badge SHOULD be visible — but the old check
        // bailed because of the zero height and the user saw nothing.
        // `anchor.isConnected` is enough to reject genuinely-detached
        // elements; the viewport-range clamp on y is what actually decides
        // whether the user can see the pin.
        const visible = anchor.isConnected && y >= -40 && y <= window.innerHeight + 40;
        if (!visible) {
          badge.classList.add('offscreen');
          continue;
        }
        const x = baseRect
          ? baseRect.left + (pin.xOffset || baseRect.width * pin.xRatio)
          : rect.left + (rect.width || 1) * pin.xRatio;
        badge.style.left = `${Math.round(x)}px`;
        badge.style.top = `${Math.round(y)}px`;
        badge.classList.remove('offscreen');
      }
    }
    this.positionPinDeleteButton();
  }

  private positionPinDeleteButton(): void {
    if (!this.pinDeleteButton || !this.selectedPinId) {
      this.hidePinDeleteButton();
      return;
    }
    const badge = this.pinBadges.get(this.selectedPinId);
    if (!badge || badge.classList.contains('offscreen') || !badge.isConnected) {
      this.hidePinDeleteButton();
      return;
    }
    const rect = badge.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      this.hidePinDeleteButton();
      return;
    }
    this.pinDeleteButton.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
    this.pinDeleteButton.style.top = `${Math.round(rect.top - 6)}px`;
    this.pinDeleteButton.classList.add('visible');
  }

  private hidePinDeleteButton(): void {
    this.pinDeleteButton?.classList.remove('visible');
  }

  private updateAllPinDotStates(): void {
    this.markers.forEach((marker) => this.updatePinDotState(marker.id));
    this.updatePinControlsState();
  }

  private updatePinDotState(turnId: string): void {
    const hasPins = (this.pinsByTurn.get(turnId)?.length ?? 0) > 0;
    this.markers.forEach((marker) => {
      if (marker.id !== turnId || !marker.dotElement) return;
      marker.dotElement.classList.toggle('has-pins', hasPins);
      let indicator = marker.dotElement.querySelector('.timeline-dot-pin-indicator');
      if (hasPins && !indicator) {
        indicator = document.createElement('span');
        indicator.className = 'timeline-dot-pin-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        indicator.textContent = 'P';
        marker.dotElement.appendChild(indicator);
      } else if (!hasPins && indicator) {
        indicator.remove();
      }
    });
    this.updatePinControlsState();
  }

  private removeTextPin(turnId: string, pinId: string): void {
    const pins = this.pinsByTurn.get(turnId) ?? [];
    const removedIndex = Math.max(
      0,
      pins.findIndex((pin) => pin.id === pinId),
    );
    const nextPins = pins.filter((pin) => pin.id !== pinId);
    if (nextPins.length) {
      this.pinsByTurn.set(turnId, nextPins);
      if (this.activePinByTurn.get(turnId) === pinId) {
        this.activePinByTurn.set(turnId, nextPins[Math.min(removedIndex, nextPins.length - 1)].id);
      }
    } else {
      this.pinsByTurn.delete(turnId);
      this.activePinByTurn.delete(turnId);
      if (this.pinFocusTurnId === turnId) this.pinFocusTurnId = null;
    }
    if (this.selectedPinId === pinId) {
      this.selectedPinId = null;
      this.selectedPinTurnId = null;
      this.hidePinDeleteButton();
    }
    this.pinBadges.get(pinId)?.remove();
    this.pinBadges.delete(pinId);
    this.saveTextPins();
    this.updatePinDotState(turnId);
    this.renderTextPinBadges();
    this.updateActiveDotUI();
  }

  private navigateActiveMessagePin(direction: -1 | 1): void {
    const turnId = this.getCurrentPinTurnId();
    if (!turnId) return;
    const pins = this.pinsByTurn.get(turnId) ?? [];
    if (!pins.length) return;
    const currentIndex = this.getActivePinIndex(turnId);
    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= pins.length) {
      this.pinFocusTurnId = turnId;
      this.activeTurnId = turnId;
      this.updatePinControlsState();
      return;
    }
    const pin = pins[nextIndex];
    this.selectTextPin(pin, false);
    this.navigateToTextPin(pin, 420);
  }

  private navigateToTextPin(pin: TimelineTextPin, duration = 260): void {
    const marker = this.markerMap.get(pin.turnId);
    if (!marker?.element || !this.scrollContainer) return;
    // Same inner-vs-outer reasoning as positionTextPinBadges: pin yOffset
    // is measured against the inner message body. Anchor scrolling to the
    // same element so the badge lands where it was originally captured.
    const anchor =
      (marker.element.querySelector('[data-message-author-role]') as HTMLElement | null) ??
      marker.element;
    const messageTop = this.computeScrollTopForElement(anchor);
    const targetPosition =
      messageTop + pin.yOffset - Math.round(this.scrollContainer.clientHeight * 0.22);
    this.smoothScrollToPosition(targetPosition, duration, pin.turnId, true);
  }

  private smoothScrollToPosition(
    targetPosition: number,
    duration = 260,
    targetId?: string | null,
    forceSmooth = false,
  ): void {
    if (!this.scrollContainer) return;
    const maxScroll = Math.max(
      0,
      this.scrollContainer.scrollHeight - this.scrollContainer.clientHeight,
    );
    const target = Math.max(0, Math.min(maxScroll, targetPosition));
    const startPosition = this.scrollContainer.scrollTop;
    const distance = target - startPosition;
    let startTime: number | null = null;

    this.isScrolling = true;
    this.setProgrammaticScrollLock(duration);
    this.setActiveTurnFromNavigation(targetId);
    // See smoothScrollTo: position the track once up front because the per-
    // frame scroll listener is short-circuited during isScrolling.
    this.syncTimelineTrackToMain();

    if ((!forceSmooth && this.scrollMode === 'jump') || duration <= 0 || Math.abs(distance) < 2) {
      this.scrollContainer.scrollTop = target;
      this.isScrolling = false;
      this.scrollAnimationLockUntil = 0;
      this.scheduleScrollSync();
      this.schedulePinBadgePositionUpdate();
      return;
    }

    const animation = (currentTime: number) => {
      if (!this.scrollContainer) return;
      if (startTime === null) startTime = currentTime;
      const timeElapsed = currentTime - startTime;
      const run = this.easeInOutQuad(timeElapsed, startPosition, distance, duration);
      this.scrollContainer.scrollTop = run;
      this.schedulePinBadgePositionUpdate();
      if (timeElapsed < duration) {
        requestAnimationFrame(animation);
      } else {
        this.scrollContainer.scrollTop = target;
        this.isScrolling = false;
        this.scrollAnimationLockUntil = 0;
        this.scheduleScrollSync();
        this.schedulePinBadgePositionUpdate();
      }
    };
    requestAnimationFrame(animation);
  }

  private static readonly SEARCH_HIGHLIGHT_CLASS = 'timeline-search-highlight';

  private clearSearchHighlights(): void {
    const cls = TimelineManager.SEARCH_HIGHLIGHT_CLASS;
    const marks = this.conversationContainer?.querySelectorAll(`mark.${cls}`);
    if (!marks) return;
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
      parent.normalize();
    });
  }

  private highlightSearchInDOM(query: string): void {
    this.clearSearchHighlights();
    if (!query || !this.conversationContainer) return;
    const lowerQuery = query.toLowerCase();
    for (const marker of this.markers) {
      const walker = document.createTreeWalker(marker.element, NodeFilter.SHOW_TEXT);
      const matches: { node: Text; index: number }[] = [];
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const idx = node.textContent?.toLowerCase().indexOf(lowerQuery) ?? -1;
        if (idx !== -1) matches.push({ node, index: idx });
      }
      // Process in reverse to keep offsets stable
      for (let i = matches.length - 1; i >= 0; i--) {
        const { node: textNode, index: matchIdx } = matches[i];
        const after = textNode.splitText(matchIdx + query.length);
        const matchText = textNode.splitText(matchIdx);
        const mark = document.createElement('mark');
        mark.className = TimelineManager.SEARCH_HIGHLIGHT_CLASS;
        mark.textContent = matchText.textContent;
        matchText.parentNode!.replaceChild(mark, matchText);
        // keep reference to 'after' to avoid TS unused warning
        void after;
      }
    }
  }

  /**
   * Optimized debounce delay: reduced from 350ms to 200ms for better responsiveness
   * while still preventing excessive recalculations during rapid DOM changes
   */
  private debouncedRecalc = this.debounce(() => this.recalculateAndRenderMarkers(), 200);

  private debounce<T extends (...args: unknown[]) => void>(func: T, delay: number): T {
    let timeout: number | null = null;
    return ((...args: unknown[]) => {
      if (timeout) clearTimeout(timeout);
      timeout = window.setTimeout(() => func.apply(this, args), delay);
    }) as unknown as T;
  }

  private getActiveIndex(): number {
    if (!this.activeTurnId) return -1;
    return this.markers.findIndex((m) => m.id === this.activeTurnId);
  }

  private getFlowDurationMs(): number {
    try {
      const d = parseInt(localStorage.getItem('gptTimelineFlowDurationMs') || '650', 10);
      return Math.max(300, Math.min(1800, Number.isFinite(d) ? d : 650));
    } catch {
      return 650;
    }
  }

  private computeFlowDuration(fromIdx: number, toIdx: number): number {
    const base = this.getFlowDurationMs();
    if (fromIdx < 0 || toIdx < 0) return base;
    const span = Math.abs(this.yPositions[toIdx] - this.yPositions[fromIdx]);
    const H = Math.max(1, this.ui.timelineBar?.clientHeight || 1);
    // Scale duration by normalized travel distance inside the bar (bounded)
    const scale = Math.max(0.6, Math.min(1.6, span / H));
    return Math.round(base * scale);
  }

  private ensureRunnerRing(): void {
    if (!this.ui.trackContent) return;
    if (!this.runnerRing) {
      const ring = document.createElement('div');
      ring.className = 'timeline-runner-ring';
      Object.assign(ring.style, {
        position: 'absolute',
        left: '50%',
        width: '20px',
        height: '20px',
        transform: 'translate(-50%, -50%)',
        borderRadius: '9999px',
        boxShadow: '0 0 0 2px var(--timeline-dot-active-color), 0 0 12px rgba(59,130,246,.45)',
        background: 'transparent',
        pointerEvents: 'none',
        zIndex: '4',
        opacity: '0',
        transition: 'opacity 120ms ease',
      } as CSSStyleDeclaration);
      this.ui.trackContent.appendChild(ring);
      this.runnerRing = ring;
    }
  }

  private startRunner(fromIdx: number, toIdx: number, duration: number): void {
    this.ensureRunnerRing();
    if (!this.runnerRing) return;
    const y1 = Math.round(this.yPositions[fromIdx]);
    const y2 = Math.round(this.yPositions[toIdx]);
    const t0 =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    this.runnerRing.style.opacity = '1';
    const animate = () => {
      const now =
        typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      const t = Math.min(1, (now - t0) / Math.max(1, duration));
      // Use the same spring shaping as easeInOutQuad override
      const spring = (() => {
        try {
          return localStorage.getItem('gptTimelineSpring') || 'ios';
        } catch {
          return 'ios';
        }
      })();
      let eased: number;
      if (spring === 'snappy') eased = Math.min(1, t + 0.08 * Math.sin(t * 8));
      else if (spring === 'gentle') eased = t * t * (3 - 2 * t);
      else eased = t * t * (3 - 2 * t) * 0.85 + t * 0.15;
      const y = Math.round(y1 + (y2 - y1) * eased);
      if (this.runnerRing) {
        this.runnerRing.style.top = `${y}px`;
      }
      if (t < 1) {
        this.flowAnimating = true;
        requestAnimationFrame(animate);
      } else {
        this.flowAnimating = false;
        if (this.runnerRing) {
          this.runnerRing.style.opacity = '0';
        }
      }
    };
    animate();
  }

  private truncateToThreeLines(
    text: string,
    targetWidth: number,
  ): { text: string; height: number } {
    if (!this.measureEl || !this.ui.tooltip) return { text, height: 0 };
    const tip = this.ui.tooltip;
    const lineH = this.getCSSVarNumber(tip, '--timeline-tooltip-lh', 18);
    const padY = this.getCSSVarNumber(tip, '--timeline-tooltip-pad-y', 10);
    const borderW = this.getCSSVarNumber(tip, '--timeline-tooltip-border-w', 1);
    const maxH = Math.round(3 * lineH + 2 * padY + 2 * borderW);
    const ell = '...';
    const el = this.measureEl;
    el.style.width = `${Math.max(0, Math.floor(targetWidth))}px`;
    const normalized = String(text || '')
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .trim();
    el.textContent = normalized;
    let h = el.offsetHeight;
    if (h <= maxH) return { text: el.textContent, height: h };
    const raw = el.textContent;
    let lo = 0,
      hi = raw.length,
      ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      el.textContent = raw.slice(0, mid).trimEnd() + ell;
      h = el.offsetHeight;
      if (h <= maxH) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const out = ans >= raw.length ? raw : raw.slice(0, ans).trimEnd() + ell;
    el.textContent = out;
    h = el.offsetHeight;
    return { text: out, height: Math.min(h, maxH) };
  }

  private computePlacementInfo(dot: HTMLElement): { placement: 'left' | 'right'; width: number } {
    const tip = this.ui.tooltip || document.body;
    const dotRect = dot.getBoundingClientRect();
    const vw = window.innerWidth;
    const arrowOut = this.getCSSVarNumber(tip, '--timeline-tooltip-arrow-outside', 6);
    const baseGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-visual', 12);
    const boxGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-box', 8);
    const gap = baseGap + Math.max(0, arrowOut) + Math.max(0, boxGap);
    const viewportPad = 8;
    const maxW = this.getCSSVarNumber(tip, '--timeline-tooltip-max', 288);
    const minW = 160;
    const leftAvail = Math.max(0, dotRect.left - gap - viewportPad);
    const rightAvail = Math.max(0, vw - dotRect.right - gap - viewportPad);
    let placement: 'left' | 'right' = rightAvail > leftAvail ? 'right' : 'left';
    let avail = placement === 'right' ? rightAvail : leftAvail;
    const tiers = [280, 240, 200, 160];
    const hardMax = Math.max(minW, Math.min(maxW, Math.floor(avail)));
    let width = tiers.find((t) => t <= hardMax) || Math.max(minW, Math.min(hardMax, 160));
    if (width < minW && placement === 'left' && rightAvail > leftAvail) {
      placement = 'right';
      avail = rightAvail;
      const hardMax2 = Math.max(minW, Math.min(maxW, Math.floor(avail)));
      width = tiers.find((t) => t <= hardMax2) || Math.max(120, Math.min(hardMax2, minW));
    } else if (width < minW && placement === 'right' && leftAvail >= rightAvail) {
      placement = 'left';
      avail = leftAvail;
      const hardMax2 = Math.max(minW, Math.min(maxW, Math.floor(avail)));
      width = tiers.find((t) => t <= hardMax2) || Math.max(120, Math.min(hardMax2, minW));
    }
    width = Math.max(120, Math.min(width, maxW));
    return { placement, width };
  }

  private showTooltipForDot(dot: DotElement): void {
    if (!this.ui.tooltip) return;
    if (this.previewPanel?.isOpen) return;
    if (this.tooltipHideTimer) {
      clearTimeout(this.tooltipHideTimer);
      this.tooltipHideTimer = null;
    }
    const tip = this.ui.tooltip;
    tip.setAttribute('dir', 'auto');
    const dotId = dot.dataset.targetTurnId || '';
    if (tip.classList.contains('visible') && this.tooltipDotId === dotId) {
      this.refreshTooltipForDot(dot);
      return;
    }
    this.tooltipDotId = dotId;
    tip.classList.remove('visible');
    const fullText = this.buildTooltipText(dot);
    const p = this.computePlacementInfo(dot);
    const layout = this.truncateToThreeLines(fullText, p.width);
    this.renderTooltipContent(tip, dot, layout.text);
    this.placeTooltipAt(dot, p.placement, p.width, layout.height);
    tip.setAttribute('aria-hidden', 'false');
    if (this.showRafId !== null) {
      cancelAnimationFrame(this.showRafId);
      this.showRafId = null;
    }
    this.showRafId = requestAnimationFrame(() => {
      this.showRafId = null;
      tip.classList.add('visible');
    });
  }

  private placeTooltipAt(
    dot: HTMLElement,
    placement: 'left' | 'right',
    width: number,
    height: number,
  ): void {
    if (!this.ui.tooltip) return;
    const tip = this.ui.tooltip;
    const dotRect = dot.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const arrowOut = this.getCSSVarNumber(tip, '--timeline-tooltip-arrow-outside', 6);
    const baseGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-visual', 12);
    const boxGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-box', 8);
    const gap = baseGap + Math.max(0, arrowOut) + Math.max(0, boxGap);
    const viewportPad = 8;
    let left: number;
    if (placement === 'left') {
      left = Math.round(dotRect.left - gap - width);
      if (left < viewportPad) {
        const altLeft = Math.round(dotRect.right + gap);
        if (altLeft + width <= vw - viewportPad) {
          placement = 'right';
          left = altLeft;
        } else {
          const fitWidth = Math.max(120, vw - viewportPad - altLeft);
          left = altLeft;
          width = fitWidth;
        }
      }
    } else {
      left = Math.round(dotRect.right + gap);
      if (left + width > vw - viewportPad) {
        const altLeft = Math.round(dotRect.left - gap - width);
        if (altLeft >= viewportPad) {
          placement = 'left';
          left = altLeft;
        } else {
          const fitWidth = Math.max(120, vw - viewportPad - left);
          width = fitWidth;
        }
      }
    }
    // Set width first, let height auto-size to text
    tip.style.width = `${Math.floor(width)}px`;
    // If height not provided, measure after width + content set
    const autoH = !height || height <= 0 ? tip.offsetHeight : height;
    let top = Math.round(dotRect.top + dotRect.height / 2 - autoH / 2);
    top = Math.max(viewportPad, Math.min(vh - height - viewportPad, top));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.setAttribute('data-placement', placement);
  }

  private refreshTooltipForDot(dot: DotElement): void {
    if (!this.ui.tooltip) return;
    const tip = this.ui.tooltip;
    tip.setAttribute('dir', 'auto');
    if (!tip.classList.contains('visible')) return;
    const fullText = this.buildTooltipText(dot);
    const p = this.computePlacementInfo(dot);
    const layout = this.truncateToThreeLines(fullText, p.width);
    this.renderTooltipContent(tip, dot, layout.text);
    this.placeTooltipAt(dot, p.placement, p.width, layout.height);
  }

  private buildTooltipText(dot: DotElement): string {
    let fullText = (dot.getAttribute('aria-label') || '').trim();
    const id = dot.dataset.targetTurnId || '';
    // Unmounted dots have an empty aria-label because ChatGPT hasn't rendered
    // the body yet. Substitute a localized placeholder so the tooltip isn't
    // blank — without this the user can't tell "empty turn" from "still
    // loading" from "extension is broken".
    if (!fullText && dot.classList.contains('timeline-dot--unmounted')) {
      fullText = getTranslationSync('timelineUnmountedTooltip');
    }
    if (id && this.starred.has(id)) fullText = `* ${fullText}`;

    if (this.showMessageTimestampsEnabled && id && this.timestampService && this.conversationId) {
      const ts = this.timestampService.getTimestamp(this.conversationId, id as TurnId);
      if (typeof ts === 'number') {
        fullText = `${this.timestampService.formatAbsoluteTime(ts)}\n${fullText}`;
      }
    }
    return fullText;
  }

  /**
   * Paint the tooltip with a colored file-type chip prefix when the marker
   * has attachments, then the body text. Without this the tooltip read like
   *   "PDF · ap22-frq-calculus-bc.pdf 看看这个" — single string with the
   * filename indistinguishable from the user's question. Per spec, the dot
   * tooltip uses the minimal chip variant (colored dot + colored label, no
   * background box) so it doesn't dominate the tooltip.
   */
  private renderTooltipContent(tip: HTMLElement, dot: DotElement, bodyText: string): void {
    tip.textContent = '';
    const id = dot.dataset.targetTurnId || '';
    const marker = this.markerMap.get(id);
    const attachments = marker?.attachments ?? [];
    if (attachments.length > 0) {
      for (const att of attachments) {
        tip.appendChild(this.createTooltipAttachmentChip(att));
      }
    }
    if (bodyText) {
      // Body text starts after the chips. A leading space keeps inline spacing
      // natural inside the -webkit-box clamp without forcing a line break.
      const sep = document.createTextNode(attachments.length > 0 ? '  ' : '');
      tip.appendChild(sep);
      tip.appendChild(document.createTextNode(bodyText));
    }
  }

  private createTooltipAttachmentChip(att: AttachmentInfo): HTMLElement {
    const chip = document.createElement('span');
    chip.className = 'timeline-attachment-chip timeline-attachment-chip--tooltip';
    chip.dataset.fileType = att.type;
    chip.style.setProperty('--gv-att-color', ATTACHMENT_COLOR[att.type]);
    const dot = document.createElement('span');
    dot.className = 'timeline-attachment-chip__dot';
    chip.appendChild(dot);
    const label = document.createElement('span');
    label.className = 'timeline-attachment-chip__label';
    label.textContent = ATTACHMENT_LABEL[att.type];
    chip.appendChild(label);
    const name = document.createElement('span');
    name.className = 'timeline-attachment-chip__name';
    name.textContent = this.shortAttachmentName(att.name);
    chip.appendChild(name);
    return chip;
  }

  private shortAttachmentName(name: string): string {
    const stripped = name.trim();
    const dot = stripped.lastIndexOf('.');
    const stem = dot > 0 ? stripped.slice(0, dot) : stripped;
    const hasCJK = /[一-鿿]/.test(stem);
    const limit = hasCJK ? 5 : 12;
    const chars: string[] = [];
    for (const ch of stem) {
      chars.push(ch);
      if (chars.length >= limit) break;
    }
    const head = chars.join('');
    return head.length < stem.length ? `${head}…` : head;
  }

  private setProgrammaticScrollLock(duration: number): void {
    const now =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    this.scrollAnimationLockUntil = now + Math.max(1000, duration + 900);
  }

  private releaseExpiredProgrammaticScrollLock(): void {
    if (!this.isScrolling || !this.scrollAnimationLockUntil) return;
    const now =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    if (now < this.scrollAnimationLockUntil) return;
    this.isScrolling = false;
    this.scrollAnimationLockUntil = 0;
  }

  private startScrollPositionPoller(): void {
    if (this.scrollPollIntervalId !== null) return;
    this.lastObservedScrollTop = this.scrollContainer?.scrollTop ?? -1;
    this.lastObservedFirstMarkerTop =
      this.markers[0]?.element?.getBoundingClientRect().top ?? Number.NaN;
    this.scrollPollIntervalId = window.setInterval(() => {
      if (!this.scrollContainer || !this.scrollContainer.isConnected) {
        if (!this.refreshScrollContainerFromMarkers()) return;
      }
      const scrollContainer = this.scrollContainer;
      if (!scrollContainer) return;
      const nextScrollTop = scrollContainer.scrollTop || 0;
      const nextFirstMarkerTop =
        this.markers[0]?.element?.getBoundingClientRect().top ?? Number.NaN;
      const scrollTopChanged = Math.abs(nextScrollTop - this.lastObservedScrollTop) > 1;
      const firstMarkerMoved =
        Number.isFinite(nextFirstMarkerTop) &&
        (!Number.isFinite(this.lastObservedFirstMarkerTop) ||
          Math.abs(nextFirstMarkerTop - this.lastObservedFirstMarkerTop) > 1);
      if (!scrollTopChanged && !firstMarkerMoved) return;
      this.recordUserScrollActivity();
      this.lastObservedScrollTop = nextScrollTop;
      this.lastObservedFirstMarkerTop = nextFirstMarkerTop;
      this.releaseExpiredProgrammaticScrollLock();
      this.scheduleScrollSync();
      this.schedulePinBadgePositionUpdate();
    }, 250);
  }

  private refreshTimelineAfterLayoutChange(): void {
    this.updateTimelineGeometry();
    this.maybeRefreshScrollContainerFromMarkers();
    this.computeActiveByScroll();
    this.syncTimelineTrackToMain();
    this.updateVirtualRangeAndRender();
    this.updateSlider();
  }

  private scheduleScrollSync(): void {
    const now =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const elapsed = now - this.lastScrollSyncAt;
    if (elapsed >= this.scrollSyncInterval) {
      this.queueScrollSyncFrame();
      return;
    }
    if (this.scrollSyncTimerId !== null) return;
    this.scrollSyncTimerId = window.setTimeout(
      () => {
        this.scrollSyncTimerId = null;
        this.queueScrollSyncFrame();
      },
      Math.max(0, this.scrollSyncInterval - elapsed),
    );
  }

  private recordUserScrollActivity(): void {
    this.lastUserScrollAt =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  private queueScrollSyncFrame(): void {
    if (this.scrollRafId !== null) return;
    const flush = () => {
      if (this.scrollRafId === null) return;
      this.scrollRafId = null;
      if (this.scrollRafFallbackTimerId !== null) {
        window.clearTimeout(this.scrollRafFallbackTimerId);
        this.scrollRafFallbackTimerId = null;
      }
      this.runScrollSyncFrame();
    };
    this.scrollRafId = -1;
    const rafId = requestAnimationFrame(flush);
    if (this.scrollRafId !== null) this.scrollRafId = rafId;
    this.scrollRafFallbackTimerId = window.setTimeout(() => {
      if (this.scrollRafId === null) return;
      try {
        cancelAnimationFrame(this.scrollRafId);
      } catch {}
      flush();
    }, 80);
  }

  private runScrollSyncFrame(): void {
    this.scrollRafId = null;
    this.lastScrollSyncAt =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    this.releaseExpiredProgrammaticScrollLock();
    const didRefreshScrollContainer = this.maybeRefreshScrollContainerFromMarkers();
    const prevActiveId = this.activeTurnId;
    this.computeActiveByScroll();
    const activeChanged = prevActiveId !== this.activeTurnId;
    const didMoveTrack = this.syncTimelineTrackToMain();
    const needsRender =
      didRefreshScrollContainer ||
      didMoveTrack ||
      activeChanged ||
      !this.isActiveDotRendered() ||
      !this.isActiveDotVisibleInTrack();
    if (needsRender) this.updateVirtualRangeAndRender();
    this.updateActiveDotStateOnly();
    if (needsRender || didMoveTrack) this.updateSlider();
  }

  private computeActiveByScroll(): void {
    this.releaseExpiredProgrammaticScrollLock();
    if (this.isScrolling || !this.scrollContainer || this.markers.length === 0) return;
    const scrollTop = this.scrollContainer.scrollTop;
    const ref = scrollTop + this.scrollContainer.clientHeight * 0.45;
    let activeId = this.markers[0].id;
    const liveActiveId = this.shouldComputeActiveFromLiveRects()
      ? this.computeActiveByViewport()
      : null;

    if (liveActiveId) {
      activeId = liveActiveId;
    } else if (this.markerTops.length === this.markers.length && this.markerTops.length > 0) {
      const cachedIndex = Math.max(
        0,
        Math.min(this.markers.length - 1, this.upperBound(this.markerTops, ref)),
      );
      const cachedActiveId = this.markers[cachedIndex]?.id ?? activeId;
      if (this.markerTopsMatchCurrentViewport(scrollTop)) {
        activeId = cachedActiveId;
      } else {
        activeId = this.computeActiveByViewport() || cachedActiveId;
      }
    } else {
      const containerRect = this.scrollContainer.getBoundingClientRect();
      for (let i = 0; i < this.markers.length; i++) {
        const m = this.markers[i];
        const top = m.element.getBoundingClientRect().top - containerRect.top + scrollTop;
        if (top <= ref) activeId = m.id;
        else break;
      }
    }
    if (this.activeTurnId !== activeId) {
      this.maybeApplyActiveTurnFromScroll(activeId);
    }
  }

  /**
   * Gate active-dot updates with scroll-direction monotonicity. If the user is
   * actively scrolling forward and the proposed new active points BACKWARD in
   * the marker list (or vice versa), defer it briefly. If the same backward
   * candidate persists past the confirm window, apply it. This filters out
   * spurious oscillation caused by stale `markerTops` cache during fast scroll
   * — the symptom users describe as "1-2-3-4-5-6 突然变到 4".
   */
  private maybeApplyActiveTurnFromScroll(activeId: string): void {
    const now =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const directionFresh =
      this.lastScrollDirection !== 0 &&
      now - this.lastScrollDirectionAt < this.scrollDirectionFreshnessMs;
    const currentId = this.activeTurnId;
    if (!directionFresh || !currentId || currentId === activeId) {
      this.clearPendingReverseActive();
      this.applyActiveTurnFromScroll(activeId);
      return;
    }
    const fromIdx = this.markers.findIndex((m) => m.id === currentId);
    const toIdx = this.markers.findIndex((m) => m.id === activeId);
    if (fromIdx < 0 || toIdx < 0) {
      this.clearPendingReverseActive();
      this.applyActiveTurnFromScroll(activeId);
      return;
    }
    const goingForward = toIdx > fromIdx;
    const matchesDirection = (this.lastScrollDirection === 1) === goingForward;
    if (matchesDirection) {
      this.clearPendingReverseActive();
      this.applyActiveTurnFromScroll(activeId);
      return;
    }
    // Reverse jump while user is scrolling the other way — be cautious.
    if (this.pendingReverseActiveId === activeId) {
      // Already pending; let the timer flush it if it persists.
      return;
    }
    this.pendingReverseActiveId = activeId;
    this.pendingReverseActiveAt = now;
    if (this.pendingReverseActiveTimer !== null) {
      clearTimeout(this.pendingReverseActiveTimer);
    }
    this.pendingReverseActiveTimer = window.setTimeout(() => {
      this.pendingReverseActiveTimer = null;
      const pending = this.pendingReverseActiveId;
      this.pendingReverseActiveId = null;
      if (!pending) return;
      // Only apply if it still differs from the current active — by now scroll
      // sync might have already settled on a forward-direction candidate.
      if (this.activeTurnId !== pending) {
        this.applyActiveTurnFromScroll(pending);
      }
    }, this.reverseActiveConfirmDelay);
  }

  private clearPendingReverseActive(): void {
    this.pendingReverseActiveId = null;
    if (this.pendingReverseActiveTimer !== null) {
      clearTimeout(this.pendingReverseActiveTimer);
      this.pendingReverseActiveTimer = null;
    }
  }

  private shouldComputeActiveFromLiveRects(): boolean {
    return this.markers.length <= 160 || this.pinsByTurn.size > 0 || !!this.pinFocusTurnId;
  }

  private markerTopsMatchCurrentViewport(scrollTop: number): boolean {
    if (!this.scrollContainer || this.markers.length === 0 || this.markerTops.length === 0) {
      return true;
    }

    const now =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    if (now - this.lastMarkerTopsSanityCheckAt < this.markerTopsSanityCheckInterval) {
      return this.markerTopsMatchViewportCache;
    }

    this.lastMarkerTopsSanityCheckAt = now;
    const containerRect = this.scrollContainer.getBoundingClientRect();
    const expectedFirstTop = this.markerTops[0] - scrollTop + containerRect.top;
    const actualFirstTop = this.markers[0].element.getBoundingClientRect().top;
    const lastIndex = this.markerTops.length - 1;
    const expectedLastTop =
      lastIndex > 0 ? this.markerTops[lastIndex] - scrollTop + containerRect.top : expectedFirstTop;
    const actualLastTop =
      lastIndex > 0
        ? (this.markers[lastIndex]?.element.getBoundingClientRect().top ?? expectedLastTop)
        : expectedFirstTop;
    this.markerTopsMatchViewportCache =
      Math.abs(expectedFirstTop - actualFirstTop) <= 24 &&
      Math.abs(expectedLastTop - actualLastTop) <= 24;
    return this.markerTopsMatchViewportCache;
  }

  private computeActiveByViewport(): string | null {
    if (!this.scrollContainer || this.markers.length === 0) return null;
    const containerRect = this.scrollContainer.getBoundingClientRect();
    const containerHeight = this.scrollContainer.clientHeight || window.innerHeight;
    const refY = containerRect.top + containerHeight * 0.45;
    let activeId = this.markers[0].id;
    let bestTopAboveRef = Number.NEGATIVE_INFINITY;
    let nearestTopBelowRef = Number.POSITIVE_INFINITY;
    let nearestBelowId: string | null = null;
    let hasUsableRects = false;
    for (const marker of this.markers) {
      const rect = marker.element.getBoundingClientRect();
      const hasRect =
        rect.width > 0 ||
        rect.height > 0 ||
        rect.top !== 0 ||
        rect.bottom !== 0 ||
        rect.left !== 0 ||
        rect.right !== 0;
      if (!hasRect) continue;
      hasUsableRects = true;
      if (rect.top <= refY) {
        if (rect.top >= bestTopAboveRef) {
          activeId = marker.id;
          bestTopAboveRef = rect.top;
        }
      } else if (rect.top < nearestTopBelowRef) {
        nearestTopBelowRef = rect.top;
        nearestBelowId = marker.id;
      }
    }
    if (bestTopAboveRef === Number.NEGATIVE_INFINITY && nearestBelowId) activeId = nearestBelowId;
    return hasUsableRects ? activeId : null;
  }

  private applyActiveTurnFromScroll(activeId: string): void {
    if (this.activeChangeTimer) {
      clearTimeout(this.activeChangeTimer);
      this.activeChangeTimer = null;
    }
    this.pendingActiveId = null;
    this.activeTurnId = activeId;
    this.syncPinFocusWithScrolledTurn(activeId);
    this.updateActiveDotStateOnly();
    this.lastActiveChangeTime =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  private syncPinFocusWithScrolledTurn(activeId: string): void {
    if (!this.pinFocusTurnId && !this.selectedPinId && !this.pinsByTurn.size) {
      this.updatePinControlsState();
      return;
    }

    const activePins = this.pinsByTurn.get(activeId) ?? [];
    const nextFocusTurnId = activePins.length > 0 ? activeId : null;
    const focusChanged = this.pinFocusTurnId !== nextFocusTurnId;
    this.pinFocusTurnId = nextFocusTurnId;

    if (nextFocusTurnId) {
      const currentPinId = this.activePinByTurn.get(nextFocusTurnId);
      if (!currentPinId || !activePins.some((pin) => pin.id === currentPinId)) {
        this.activePinByTurn.set(nextFocusTurnId, activePins[0].id);
      }
    }

    const selectionBelongsToFocus =
      !!this.selectedPinId && !!nextFocusTurnId && this.selectedPinTurnId === nextFocusTurnId;
    const selectionChanged = !!this.selectedPinId && !selectionBelongsToFocus;
    if (selectionChanged) {
      this.selectedPinId = null;
      this.selectedPinTurnId = null;
      this.hidePinDeleteButton();
      this.renderTextPinBadges();
      return;
    }

    if (focusChanged) this.hidePinDeleteButton();
    this.updatePinControlsState();
  }

  private syncTimelineTrackToMain(): boolean {
    if (this.sliderDragging) return false;
    if (!this.ui.track || !this.scrollContainer || !this.contentHeight) return false;

    const activeIndex = this.getActiveIndex();
    if (activeIndex >= 0) {
      if (activeIndex === 0) {
        return this.setTimelineTrackScrollTop(0);
      }
      if (activeIndex === this.markers.length - 1) {
        const maxScroll = Math.max(0, this.contentHeight - (this.ui.track.clientHeight || 0));
        return this.setTimelineTrackScrollTop(maxScroll);
      }
      return this.scrollTimelineTrackToMarker(activeIndex, 'visible');
    }

    const scrollTop = this.scrollContainer.scrollTop;
    const ref = scrollTop + this.scrollContainer.clientHeight * 0.45;
    const span = Math.max(1, this.contentSpanPx || 1);
    const r = Math.max(0, Math.min(1, (ref - (this.firstUserTurnOffset || 0)) / span));
    const maxScroll = Math.max(0, this.contentHeight - (this.ui.track.clientHeight || 0));
    const target = Math.round(r * maxScroll);
    if (Math.abs((this.ui.track.scrollTop || 0) - target) <= 1) return false;
    this.ui.track.scrollTop = target;
    return true;
  }

  private setTimelineTrackScrollTop(nextScrollTop: number): boolean {
    if (!this.ui.track) return false;
    const currentScrollTop = this.ui.track.scrollTop || 0;
    const target = Math.max(0, Math.round(nextScrollTop));
    if (Math.abs(currentScrollTop - target) <= 1) return false;
    this.ui.track.scrollTop = target;
    return true;
  }

  private lowerBound(arr: number[], x: number): number {
    let lo = 0,
      hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  private upperBound(arr: number[], x: number): number {
    let lo = 0,
      hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  private updateVirtualRangeAndRender(): void {
    const localVersion = this.markersVersion;
    if (!this.ui.track || !this.ui.trackContent || this.markers.length === 0) return;
    const st = this.ui.track.scrollTop || 0;
    const vh = this.ui.track.clientHeight || 0;
    const buffer = Math.max(100, vh);
    const minY = st - buffer;
    const maxY = st + vh + buffer;
    const start = this.lowerBound(this.yPositions, minY);
    const end = Math.max(start - 1, this.upperBound(this.yPositions, maxY));

    const hiddenIndices = this.getHiddenMarkerIndices();

    let prevStart = this.visibleRange.start;
    let prevEnd = this.visibleRange.end;
    const len = this.markers.length;
    if (len > 0) {
      prevStart = Math.max(0, Math.min(prevStart, len - 1));
      prevEnd = Math.max(-1, Math.min(prevEnd, len - 1));
    }
    if (prevEnd >= prevStart) {
      for (let i = prevStart; i < Math.min(start, prevEnd + 1); i++) {
        const m = this.markers[i];
        if (m && m.dotElement) {
          m.dotElement.remove();
          m.dotElement = null;
        }
      }
      for (let i = Math.max(end + 1, prevStart); i <= prevEnd; i++) {
        const m = this.markers[i];
        if (m && m.dotElement) {
          m.dotElement.remove();
          m.dotElement = null;
        }
      }
    } else {
      // Range was reset; preserve dots owned by in-range markers, remove the rest
      const keepDots = new Set<Element>();
      for (let i = start; i <= end; i++) {
        if (this.markers[i]?.dotElement) keepDots.add(this.markers[i].dotElement!);
      }
      (this.ui.trackContent || this.ui.timelineBar)!
        .querySelectorAll('.timeline-dot')
        .forEach((n) => {
          if (!keepDots.has(n)) n.remove();
        });
      this.markers.forEach((m) => {
        if (m.dotElement && !keepDots.has(m.dotElement)) m.dotElement = null;
      });
    }

    const frag = document.createDocumentFragment();
    for (let i = start; i <= end; i++) {
      const marker = this.markers[i];
      if (!marker) continue;

      if (hiddenIndices.has(i)) {
        if (marker.dotElement) {
          marker.dotElement.remove();
          marker.dotElement = null;
        }
        continue;
      }

      const isCollapsed = this.isMarkerCollapsed(marker.id);

      // A marker is "unmounted" when none of its content channels have any
      // data: no text, no attachments, no detected generated image. This
      // happens when ChatGPT has virtualised the inner body and we have no
      // cached snapshot to fall back on. Visually dim the dot so users can
      // tell "this point exists but hasn't loaded" apart from a real
      // empty/short turn.
      const isUnmounted =
        !marker.summary && marker.attachments.length === 0 && !marker.hasGeneratedImage;

      if (!marker.dotElement) {
        const dot = document.createElement('button') as DotElement;
        dot.className = 'timeline-dot';
        dot.dataset.targetTurnId = marker.id;
        dot.dataset.markerIndex = String(i);
        dot.setAttribute('aria-label', marker.summary);
        dot.setAttribute('tabindex', '0');
        dot.setAttribute('aria-describedby', 'gpt-timeline-tooltip');
        dot.style.setProperty('--n', String(marker.n || 0));
        if (this.usePixelTop) dot.style.top = `${Math.round(this.yPositions[i])}px`;
        dot.classList.toggle('active', marker.id === this.activeTurnId);
        dot.classList.toggle('starred', !!marker.starred);
        dot.classList.toggle('collapsed', isCollapsed);
        dot.classList.toggle('timeline-dot--unmounted', isUnmounted);
        dot.setAttribute('aria-pressed', marker.starred ? 'true' : 'false');
        dot.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
        // Apply marker level
        const level = this.getMarkerLevel(marker.id);
        dot.setAttribute('data-level', String(level));
        this.updateDotIndicators(dot, marker);
        marker.dotElement = dot;
        frag.appendChild(dot);
      } else {
        marker.dotElement.dataset.markerIndex = String(i);
        marker.dotElement.setAttribute('aria-label', marker.summary);
        marker.dotElement.style.setProperty('--n', String(marker.n || 0));
        if (this.usePixelTop) marker.dotElement.style.top = `${Math.round(this.yPositions[i])}px`;
        marker.dotElement.classList.toggle('starred', !!marker.starred);
        marker.dotElement.classList.toggle('collapsed', isCollapsed);
        marker.dotElement.classList.toggle('timeline-dot--unmounted', isUnmounted);
        marker.dotElement.setAttribute('aria-pressed', marker.starred ? 'true' : 'false');
        marker.dotElement.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
        // Apply marker level
        const level = this.getMarkerLevel(marker.id);
        marker.dotElement.setAttribute('data-level', String(level));
        this.updateDotIndicators(marker.dotElement, marker);
      }
    }
    if (localVersion !== this.markersVersion) return;
    if (frag.childNodes.length) this.ui.trackContent.appendChild(frag);
    this.sortRenderedTimelineDots();
    this.visibleRange = { start, end };
    for (let i = start; i <= end; i++) {
      const marker = this.markers[i];
      if (marker) this.updatePinDotState(marker.id);
    }
    this.updateSlider();
  }

  private sortRenderedTimelineDots(): void {
    if (!this.ui.trackContent) return;
    const dots = Array.from(this.ui.trackContent.querySelectorAll<HTMLElement>('.timeline-dot'));
    if (dots.length < 2) return;

    const sortedDots = [...dots].sort((a, b) => {
      const aIndex = Number(a.dataset.markerIndex ?? Number.POSITIVE_INFINITY);
      const bIndex = Number(b.dataset.markerIndex ?? Number.POSITIVE_INFINITY);
      return aIndex - bIndex;
    });
    if (dots.every((dot, index) => dot === sortedDots[index])) return;

    const fragment = document.createDocumentFragment();
    sortedDots.forEach((dot) => fragment.appendChild(dot));
    if (this.runnerRing && this.runnerRing.parentElement === this.ui.trackContent) {
      this.ui.trackContent.insertBefore(fragment, this.runnerRing);
    } else {
      this.ui.trackContent.appendChild(fragment);
    }
  }

  private updateSlider(): void {
    if (!this.ui.slider || !this.ui.sliderHandle) return;
    if (!this.contentHeight || !this.ui.timelineBar || !this.ui.track) return;
    const barRect = this.ui.timelineBar.getBoundingClientRect();
    const barH = barRect.height || 0;
    const pad = this.getTrackPadding();
    const innerH = Math.max(0, barH - 2 * pad);
    if (this.contentHeight <= barH + 1 || innerH <= 0) {
      this.sliderAlwaysVisible = false;
      this.ui.slider.classList.remove('visible');
      this.ui.slider.style.opacity = '';
      return;
    }
    this.sliderAlwaysVisible = true;
    const railLen = Math.max(120, Math.min(240, Math.floor(barH * 0.45)));
    const railTop = Math.round(barRect.top + pad + (innerH - railLen) / 2);
    const railLeftGap = 8;
    const sliderWidth = 12;
    // In RTL, bar is on the left side; position slider to its right instead
    const left = this.rtl
      ? Math.round(barRect.right + railLeftGap)
      : Math.round(barRect.left - railLeftGap - sliderWidth);
    this.ui.slider.style.left = `${left}px`;
    this.ui.slider.style.top = `${railTop}px`;
    this.ui.slider.style.height = `${railLen}px`;
    const handleH = 22;
    const maxTop = Math.max(0, railLen - handleH);
    const range = Math.max(1, this.contentHeight - barH);
    const st = this.ui.track.scrollTop || 0;
    const r = Math.max(0, Math.min(1, st / range));
    const top = Math.round(r * maxTop);
    this.ui.sliderHandle.style.height = `${handleH}px`;
    this.ui.sliderHandle.style.top = `${top}px`;
    this.ui.slider.classList.add('visible');
    this.ui.slider.style.opacity = '';
  }

  private showSlider(): void {
    if (!this.ui.slider) return;
    this.ui.slider.classList.add('visible');
    if (this.sliderFadeTimer) {
      clearTimeout(this.sliderFadeTimer);
      this.sliderFadeTimer = null;
    }
    this.updateSlider();
  }

  private hideSliderDeferred(): void {
    if (this.sliderDragging || this.sliderAlwaysVisible) return;
    if (this.sliderFadeTimer) clearTimeout(this.sliderFadeTimer);
    this.sliderFadeTimer = window.setTimeout(() => {
      this.sliderFadeTimer = null;
      this.ui.slider?.classList.remove('visible');
    }, this.sliderFadeDelay);
  }

  private handleSliderDrag(e: PointerEvent): void {
    if (!this.sliderDragging || !this.ui.timelineBar || !this.ui.track) return;
    const barRect = this.ui.timelineBar.getBoundingClientRect();
    const barH = barRect.height || 0;
    const railLen =
      parseFloat(this.ui.slider!.style.height || '0') ||
      Math.max(120, Math.min(240, Math.floor(barH * 0.45)));
    const handleH = this.ui.sliderHandle!.getBoundingClientRect().height || 22;
    const maxTop = Math.max(0, railLen - handleH);
    const delta = e.clientY - this.sliderStartClientY;
    let top = Math.max(
      0,
      Math.min(maxTop, this.sliderStartTop + delta - (parseFloat(this.ui.slider!.style.top) || 0)),
    );
    const r = maxTop > 0 ? top / maxTop : 0;
    const range = Math.max(1, this.contentHeight - barH);
    this.ui.track.scrollTop = Math.round(r * range);
    this.updateVirtualRangeAndRender();
    this.showSlider();
    this.updateSlider();
  }

  private endSliderDrag(_e: PointerEvent): void {
    this.sliderDragging = false;
    try {
      window.removeEventListener('pointermove', this.onSliderMove!);
    } catch {}
    this.onSliderMove = null;
    this.onSliderUp = null;
    this.hideSliderDeferred();
  }

  private toggleDraggable(enabled: boolean): void {
    this.draggable = enabled;
    // Cursor is managed dynamically by onBarCursorMove; just update the flag
    if (!this.ui.timelineBar) return;
    if (!this.draggable) {
      this.ui.timelineBar.style.cursor = '';
    }
  }

  private toggleMarkerLevel(enabled: boolean): void {
    this.markerLevelEnabled = enabled;
    // Hide context menu when feature is disabled
    if (!enabled) {
      this.hideContextMenu();
    }
    // Trigger re-layout to show/hide collapsed states
    this.updateTimelineGeometry();
    this.updateVirtualRangeAndRender();
  }

  private handleBarDrag(e: PointerEvent): void {
    if (!this.barDragging) return;
    const dx = e.clientX - this.barStartPos.x;
    const dy = e.clientY - this.barStartPos.y;
    this.ui.timelineBar!.style.left = `${this.barStartOffset.x + dx}px`;
    this.ui.timelineBar!.style.top = `${this.barStartOffset.y + dy}px`;
    this.positionPinControls();
  }

  private endBarDrag(_e: PointerEvent): void {
    this.barDragging = false;
    this.savePosition();
    window.removeEventListener('pointermove', this.onBarPointerMove!);
  }

  private savePosition(): void {
    if (!this.ui.timelineBar) return;
    const rect = this.ui.timelineBar.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Save position as percentage of viewport for responsive design
    const position = {
      version: 2,
      topPercent: (rect.top / viewportHeight) * 100,
      leftPercent: (rect.left / viewportWidth) * 100,
    };

    const g = globalThis as ExtGlobal;
    if (g.chrome?.storage?.sync?.set) {
      g.chrome.storage.sync.set({ [StorageKeys.TIMELINE_POSITION]: position });
    } else if (g.browser?.storage?.sync?.set) {
      g.browser.storage.sync.set({ [StorageKeys.TIMELINE_POSITION]: position });
    }
  }

  /**
   * Apply position with boundary checks to keep timeline visible
   */
  private applyRTLUpdate(language?: string | null): void {
    const wasRTL = this.rtl;
    this.rtl = applyRTLClass(language);
    if (wasRTL !== this.rtl) {
      // Reset inline position so the CSS default for the new direction takes effect
      if (this.ui.timelineBar) {
        this.ui.timelineBar.style.top = '';
        this.ui.timelineBar.style.left = '';
      }
      this.updateSlider();
      this.previewPanel?.reposition();
      this.positionPinControls();
    }
  }

  private applyPosition(top: number, left: number): void {
    if (!this.ui.timelineBar) return;

    const barWidth = this.ui.timelineBar.offsetWidth || 24; // fallback to default width
    const barHeight = this.ui.timelineBar.offsetHeight || 100;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Clamp to viewport bounds (with small padding)
    const padding = 10;
    const clampedTop = Math.max(padding, Math.min(top, viewportHeight - barHeight - padding));
    const clampedLeft = Math.max(padding, Math.min(left, viewportWidth - barWidth - padding));

    this.ui.timelineBar.style.top = `${clampedTop}px`;
    this.ui.timelineBar.style.left = `${clampedLeft}px`;
    this.previewPanel?.reposition();
    this.positionPinControls();
  }

  /**
   * Reapply position from storage (for window resize)
   */
  private async reapplyPosition(): Promise<void> {
    if (!this.ui.timelineBar) return;

    const g = globalThis as ExtGlobal;
    if (!g.chrome?.storage?.sync && !g.browser?.storage?.sync) return;

    let res: Record<string, unknown> | null = null;
    try {
      res = await new Promise((resolve) => {
        if (g.chrome?.storage?.sync?.get) {
          g.chrome.storage.sync.get(
            { [StorageKeys.TIMELINE_POSITION]: null },
            (items: Record<string, unknown>) => {
              if (g.chrome.runtime?.lastError) {
                console.error(
                  `[Timeline] chrome.storage.get failed: ${g.chrome.runtime.lastError.message}`,
                );
                resolve(null);
              } else {
                resolve(items);
              }
            },
          );
        } else {
          g.browser?.storage?.sync
            ?.get({ [StorageKeys.TIMELINE_POSITION]: null })
            .then(resolve)
            .catch((error: Error) => {
              console.error(`[Timeline] browser.storage.get failed: ${error.message}`);
              resolve(null);
            });
        }
      });
    } catch (error) {
      console.error('[Timeline] reapplyPosition storage access failed:', error);
      return;
    }

    const position = res?.[StorageKeys.TIMELINE_POSITION] as
      | { version?: number; topPercent?: number; leftPercent?: number; top?: number; left?: number }
      | undefined;
    if (!position) return;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // v2 format: use percentage (responsive)
    if (
      position.version === 2 &&
      position.topPercent !== undefined &&
      position.leftPercent !== undefined
    ) {
      const top = (position.topPercent / 100) * viewportHeight;
      const left = (position.leftPercent / 100) * viewportWidth;
      this.applyPosition(top, left);
    }
    // v1 format: keep absolute position (no resize adjustment for legacy)
    else if (position.top !== undefined && position.left !== undefined) {
      this.applyPosition(position.top, position.left);
    }
  }

  private hideTooltip(immediate = false): void {
    if (!this.ui.tooltip) return;
    const doHide = () => {
      this.ui.tooltip!.classList.remove('visible');
      this.ui.tooltip!.setAttribute('aria-hidden', 'true');
      this.tooltipDotId = null;
      this.tooltipHideTimer = null;
    };
    if (immediate) return doHide();
    if (this.tooltipHideTimer) clearTimeout(this.tooltipHideTimer);
    this.tooltipHideTimer = window.setTimeout(doHide, this.tooltipHideDelay);
  }

  private async toggleStar(turnId: string): Promise<void> {
    const id = String(turnId || '');
    if (!id) return;

    const wasStarred = this.starred.has(id);

    if (wasStarred) {
      this.starred.delete(id);
      this.starredAtMap.delete(id);
    } else {
      this.starred.add(id);
    }

    this.saveStars();

    // Update global starred messages service
    if (wasStarred) {
      // Remove from global storage
      await StarredMessagesService.removeStarredMessage(this.conversationId!, id);
    } else {
      // Add to global storage with full message info
      const m = this.markerMap.get(id);
      if (m) {
        const conversationTitle = this.getConversationTitle();
        const now = Date.now();
        const message: StarredMessage = {
          turnId: id,
          content: m.summary,
          conversationId: this.conversationId!,
          conversationUrl: window.location.href,
          conversationTitle,
          starredAt: now,
        };
        this.starredAtMap.set(id, now);
        await StarredMessagesService.addStarredMessage(message);
      }
    }

    // Update UI for ALL markers with this ID (handle duplicates)
    const isStarredNow = this.starred.has(id);
    this.markers.forEach((m) => {
      if (m.id === id) {
        m.starred = isStarredNow;
        if (m.dotElement) {
          m.dotElement.classList.toggle('starred', isStarredNow);
          m.dotElement.setAttribute('aria-pressed', isStarredNow ? 'true' : 'false');
          this.updateDotIndicators(m.dotElement, m);
          // Only refresh tooltip if this specific dot is actively hovered/focused
          // (checked internally by refreshTooltipForDot)
          this.refreshTooltipForDot(m.dotElement);
        }
      }
    });
    // Push the new starred state through to the preview panel so its row
    // star button flips state immediately after a click.
    this.previewPanel?.updateMarkers(
      this.markers.map((m, i) => ({
        id: m.id,
        summary: m.summary,
        index: i,
        starred: m.starred,
        starredAt: m.starred ? this.starredAtMap.get(m.id) : undefined,
        attachments: m.attachments,
      })),
    );
  }

  /**
   * Save starred messages to localStorage using DRY helper
   */
  private saveStars(): void {
    const key = this.getStarsStorageKey();
    if (!key) return;
    this.safeLocalStorageSet(key, JSON.stringify(Array.from(this.starred)));
  }

  /**
   * Load starred messages from localStorage using DRY helper
   */
  private async loadStars(): Promise<void> {
    this.starred.clear();
    const key = this.getStarsStorageKey();
    if (!key) return;

    const fallbackKeys = [this.getRouteStarsStorageKey(), this.getLegacyStarsStorageKey()].filter(
      (candidate): candidate is string => Boolean(candidate && candidate !== key),
    );

    let raw = this.safeLocalStorageGet(key);
    if (!raw) {
      for (const fallbackKey of fallbackKeys) {
        raw = this.safeLocalStorageGet(fallbackKey);
        if (raw) {
          this.safeLocalStorageSet(key, raw);
          break;
        }
      }
    }
    if (!raw) return;

    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        arr.forEach((id: unknown) => this.starred.add(String(id)));
      }
    } catch (error) {
      console.warn('[Timeline] Failed to parse starred messages:', error);
    }
  }

  // ===== Marker Level Methods =====

  private getLevelsStorageKey(): string | null {
    return this.conversationId ? getLegacyTimelineLevelsStorageKey(this.conversationId) : null;
  }

  /* Load marker levels from legacy localStorage */
  private loadMarkerLevels(): void {
    this.markerLevels.clear();
    const key = this.getLevelsStorageKey();
    if (!key) return;

    const raw = this.safeLocalStorageGet(key);
    if (!raw) return;

    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      Object.entries(obj).forEach(([turnId, level]) => {
        if (level === 1 || level === 2 || level === 3) {
          this.markerLevels.set(turnId, level);
        }
      });
    } catch (error) {
      console.warn('[Timeline] Failed to parse marker levels:', error);
    }
  }

  /* Save marker levels to legacy localStorage and mirrored extension storage */
  private saveMarkerLevels(): void {
    if (this.timelineHierarchyStorageKey === StorageKeys.TIMELINE_HIERARCHY) {
      this.persistTimelineHierarchyToLegacyStorage();
    }
    void this.persistTimelineHierarchyToExtensionStorage();
  }

  // ===== Collapsed Markers Methods =====

  private getCollapsedStorageKey(): string | null {
    return this.conversationId ? getLegacyTimelineCollapsedStorageKey(this.conversationId) : null;
  }

  private loadCollapsedMarkers(): void {
    this.collapsedMarkers.clear();
    const key = this.getCollapsedStorageKey();
    if (!key) return;

    const raw = this.safeLocalStorageGet(key);
    if (!raw) return;

    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        arr.forEach((id: unknown) => this.collapsedMarkers.add(String(id)));
      }
    } catch (error) {
      console.warn('[Timeline] Failed to parse collapsed markers:', error);
    }
  }

  private saveCollapsedMarkers(): void {
    if (this.timelineHierarchyStorageKey === StorageKeys.TIMELINE_HIERARCHY) {
      this.persistTimelineHierarchyToLegacyStorage();
    }
    void this.persistTimelineHierarchyToExtensionStorage();
  }

  private hasTimelineHierarchyData(): boolean {
    return this.markerLevels.size > 0 || this.collapsedMarkers.size > 0;
  }

  private buildTimelineHierarchyConversationData(): TimelineHierarchyConversationData | null {
    if (!this.conversationId || !this.hasTimelineHierarchyData()) {
      return null;
    }

    const levels: Record<string, MarkerLevel> = {};
    this.markerLevels.forEach((level, turnId) => {
      levels[turnId] = level;
    });

    return {
      conversationUrl: window.location.href,
      levels,
      collapsed: Array.from(this.collapsedMarkers),
      updatedAt: Date.now(),
    };
  }

  private buildLegacyTimelineHierarchyConversationData(): TimelineHierarchyConversationData | null {
    if (!this.conversationId) {
      return null;
    }

    const levels: Record<string, MarkerLevel> = {};
    const levelsKey = this.getLevelsStorageKey();
    if (levelsKey) {
      const rawLevels = this.safeLocalStorageGet(levelsKey);
      if (rawLevels) {
        try {
          const parsedLevels = JSON.parse(rawLevels) as Record<string, unknown>;
          Object.entries(parsedLevels).forEach(([turnId, level]) => {
            if (level === 1 || level === 2 || level === 3) {
              levels[turnId] = level;
            }
          });
        } catch (error) {
          console.warn('[Timeline] Failed to parse legacy marker levels:', error);
        }
      }
    }

    let collapsed: string[] = [];
    const collapsedKey = this.getCollapsedStorageKey();
    if (collapsedKey) {
      const rawCollapsed = this.safeLocalStorageGet(collapsedKey);
      if (rawCollapsed) {
        try {
          const parsedCollapsed = JSON.parse(rawCollapsed);
          if (Array.isArray(parsedCollapsed)) {
            collapsed = parsedCollapsed.map((turnId: unknown) => String(turnId));
          }
        } catch (error) {
          console.warn('[Timeline] Failed to parse legacy collapsed markers:', error);
        }
      }
    }

    if (Object.keys(levels).length === 0 && collapsed.length === 0) {
      return null;
    }

    return {
      conversationUrl: window.location.href,
      levels,
      collapsed,
      updatedAt: Date.now(),
    };
  }

  private applyTimelineHierarchyConversationData(
    conversationData: TimelineHierarchyConversationData | null,
  ): void {
    this.markerLevels.clear();
    this.collapsedMarkers.clear();

    if (!conversationData) {
      return;
    }

    Object.entries(conversationData.levels).forEach(([turnId, level]) => {
      this.markerLevels.set(turnId, level);
    });
    conversationData.collapsed.forEach((turnId) => this.collapsedMarkers.add(turnId));
  }

  private async loadTimelineHierarchyStorageContext(): Promise<void> {
    this.timelineHierarchyAccountScope = null;
    this.timelineHierarchyStorageKey = StorageKeys.TIMELINE_HIERARCHY;

    try {
      const context = detectAccountContextFromDocument(window.location.href, document);
      if (!context.routeUserId && !context.email) {
        return;
      }
      const scope = await accountIsolationService.resolveAccountScope({
        pageUrl: window.location.href,
        routeUserId: context.routeUserId,
        email: context.email,
      });

      this.timelineHierarchyAccountScope = scope;
      this.timelineHierarchyStorageKey = getTimelineHierarchyStorageKey(scope.accountKey);
    } catch (error) {
      console.warn('[Timeline] Failed to resolve timeline hierarchy storage scope:', error);
      this.timelineHierarchyAccountScope = null;
      this.timelineHierarchyStorageKey = StorageKeys.TIMELINE_HIERARCHY;
    }
  }

  private persistTimelineHierarchyToLegacyStorage(): void {
    const levelsKey = this.getLevelsStorageKey();
    if (levelsKey) {
      const levels: Record<string, MarkerLevel> = {};
      this.markerLevels.forEach((level, turnId) => {
        levels[turnId] = level;
      });
      this.safeLocalStorageSet(levelsKey, JSON.stringify(levels));
    }

    const collapsedKey = this.getCollapsedStorageKey();
    if (collapsedKey) {
      this.safeLocalStorageSet(collapsedKey, JSON.stringify(Array.from(this.collapsedMarkers)));
    }
  }

  private async loadTimelineHierarchyFromExtensionStorage(): Promise<void> {
    if (!this.conversationId || typeof chrome === 'undefined' || !chrome.storage?.local?.get) {
      return;
    }

    try {
      const storageValues = (await chrome.storage.local.get(
        getTimelineHierarchyStorageKeysToRead(this.timelineHierarchyAccountScope?.accountKey),
      )) as Record<string, unknown>;
      const data = resolveTimelineHierarchyDataForStorageScope(
        storageValues,
        this.timelineHierarchyAccountScope?.accountKey,
        this.timelineHierarchyAccountScope?.routeUserId ?? null,
      );
      const conversationData = data.conversations[this.conversationId] || null;

      if (conversationData) {
        this.applyTimelineHierarchyConversationData(conversationData);
        if (this.timelineHierarchyStorageKey === StorageKeys.TIMELINE_HIERARCHY) {
          this.persistTimelineHierarchyToLegacyStorage();
        }
        return;
      }

      if (this.timelineHierarchyStorageKey !== StorageKeys.TIMELINE_HIERARCHY) {
        const legacyConversationData = this.buildLegacyTimelineHierarchyConversationData();
        if (legacyConversationData) {
          this.applyTimelineHierarchyConversationData(legacyConversationData);
          await this.persistTimelineHierarchyToExtensionStorage();
          return;
        }
      }

      if (this.hasTimelineHierarchyData()) {
        await this.persistTimelineHierarchyToExtensionStorage();
      }
    } catch (error) {
      console.warn('[Timeline] Failed to load timeline hierarchy from extension storage:', error);
    }
  }

  private async persistTimelineHierarchyToExtensionStorage(): Promise<void> {
    if (!this.conversationId || typeof chrome === 'undefined' || !chrome.storage?.local?.get) {
      return;
    }

    try {
      const storageValues = (await chrome.storage.local.get(
        getTimelineHierarchyStorageKeysToRead(this.timelineHierarchyAccountScope?.accountKey),
      )) as Record<string, unknown>;
      const existing = resolveTimelineHierarchyDataForStorageScope(
        storageValues,
        this.timelineHierarchyAccountScope?.accountKey,
        this.timelineHierarchyAccountScope?.routeUserId ?? null,
      );
      const conversations = { ...existing.conversations };
      const currentConversationData = this.buildTimelineHierarchyConversationData();

      if (currentConversationData) {
        conversations[this.conversationId] = currentConversationData;
      } else {
        delete conversations[this.conversationId];
      }

      await chrome.storage.local.set({
        [this.timelineHierarchyStorageKey]: { conversations },
      });
    } catch (error) {
      console.warn('[Timeline] Failed to persist timeline hierarchy to extension storage:', error);
    }
  }

  private isMarkerCollapsed(turnId: string): boolean {
    return this.collapsedMarkers.has(turnId);
  }

  private toggleCollapse(turnId: string): void {
    if (this.collapsedMarkers.has(turnId)) {
      this.collapsedMarkers.delete(turnId);
    } else {
      this.collapsedMarkers.add(turnId);
    }
    this.saveCollapsedMarkers();
    this.updateTimelineGeometry();
    this.updateVirtualRangeAndRender();
  }

  private getHiddenMarkerIndices(): Set<number> {
    const hidden = new Set<number>();

    // If marker level feature is disabled, no markers are hidden
    if (!this.markerLevelEnabled) {
      return hidden;
    }

    for (let i = 0; i < this.markers.length; i++) {
      // Skip markers that are already hidden by a parent collapse
      if (hidden.has(i)) continue;

      const marker = this.markers[i];
      const level = this.getMarkerLevel(marker.id);

      // If this marker is collapsed, hide all subsequent lower-level markers
      if (this.collapsedMarkers.has(marker.id)) {
        for (let j = i + 1; j < this.markers.length; j++) {
          const nextMarker = this.markers[j];
          const nextLevel = this.getMarkerLevel(nextMarker.id);

          // Stop when we reach a marker of same or higher level (lower number)
          if (nextLevel <= level) {
            break;
          }

          // Hide this marker (only direct descendants of this collapsed parent)
          hidden.add(j);
        }
      }
    }

    return hidden;
  }

  private calculateEffectiveBaseN(markerIndex: number, _hiddenIndices: Set<number>): number {
    const marker = this.markers[markerIndex];
    if (!marker) return 0;

    const baseN = marker.baseN ?? marker.n ?? 0;

    // If this marker is not collapsed, just return its baseN
    if (!this.collapsedMarkers.has(marker.id)) {
      return baseN;
    }

    // Find the range of hidden children
    const level = this.getMarkerLevel(marker.id);
    let childContribution = 0;

    for (let j = markerIndex + 1; j < this.markers.length; j++) {
      const nextMarker = this.markers[j];
      const nextLevel = this.getMarkerLevel(nextMarker.id);

      // Stop when we reach a marker of same or higher level
      if (nextLevel <= level) {
        break;
      }

      // Add half of child's contribution based on level difference
      const childBaseN = nextMarker.baseN ?? nextMarker.n ?? 0;
      const prevBaseN = j > 0 ? (this.markers[j - 1].baseN ?? this.markers[j - 1].n ?? 0) : 0;
      const childLength = childBaseN - prevBaseN;
      const levelDiff = nextLevel - level;
      childContribution += childLength * Math.pow(0.5, levelDiff);
    }

    return baseN + childContribution;
  }

  private calculateCollapsedPositions(
    hiddenIndices: Set<number>,
    pad: number,
    usableC: number,
  ): { desiredY: number[]; effectiveBaseNs: number[] } {
    const N = this.markers.length;
    const desiredY: number[] = new Array(N).fill(-1);
    const effectiveBaseNs: number[] = new Array(N).fill(0);

    // First pass: calculate effective baseN for all visible markers
    const visibleMarkers: { index: number; effectiveN: number }[] = [];

    for (let i = 0; i < N; i++) {
      if (hiddenIndices.has(i)) continue;

      const effectiveN = this.calculateEffectiveBaseN(i, hiddenIndices);
      effectiveBaseNs[i] = effectiveN;
      visibleMarkers.push({ index: i, effectiveN });
    }

    // Sort visible markers by their effective baseN (maintains relative order based on length)
    visibleMarkers.sort((a, b) => a.effectiveN - b.effectiveN);

    // Calculate total effective range
    if (visibleMarkers.length === 0) {
      return { desiredY, effectiveBaseNs };
    }

    const minEffectiveN = visibleMarkers[0].effectiveN;
    const maxEffectiveN = visibleMarkers[visibleMarkers.length - 1].effectiveN;
    const effectiveRange = maxEffectiveN - minEffectiveN;

    // Distribute positions proportionally
    for (const vm of visibleMarkers) {
      let normalizedN: number;
      if (effectiveRange > 0) {
        normalizedN = (vm.effectiveN - minEffectiveN) / effectiveRange;
      } else {
        normalizedN = visibleMarkers.indexOf(vm) / Math.max(1, visibleMarkers.length - 1);
      }

      desiredY[vm.index] = pad + normalizedN * usableC;
    }

    return { desiredY, effectiveBaseNs };
  }

  /**
   * Check if a marker can be collapsed (has lower-level children)
   */
  private canCollapseMarker(turnId: string): boolean {
    const markerIndex = this.markers.findIndex((m) => m.id === turnId);
    if (markerIndex < 0 || markerIndex >= this.markers.length - 1) return false;

    const level = this.getMarkerLevel(turnId);

    const nextMarker = this.markers[markerIndex + 1];
    if (!nextMarker) return false;

    const nextLevel = this.getMarkerLevel(nextMarker.id);
    return nextLevel > level;
  }

  private getMarkerLevel(turnId: string): MarkerLevel {
    return this.markerLevels.get(turnId) || 1;
  }

  private setMarkerLevel(turnId: string, level: MarkerLevel): void {
    if (level === 1) {
      // Level 1 is default, remove from storage to save space
      this.markerLevels.delete(turnId);
    } else {
      this.markerLevels.set(turnId, level);
    }
    this.saveMarkerLevels();

    // Update all dots with this turnId
    this.markers.forEach((marker) => {
      if (marker.id === turnId && marker.dotElement) {
        marker.dotElement.setAttribute('data-level', String(level));
      }
    });
  }

  private showContextMenu(dot: DotElement, x: number, y: number): void {
    this.hideContextMenu();

    const turnId = dot.dataset.targetTurnId;
    if (!turnId) return;

    const currentLevel = this.getMarkerLevel(turnId);
    const isCollapsed = this.isMarkerCollapsed(turnId);
    const canCollapse = this.canCollapseMarker(turnId);

    const menu = document.createElement('div');
    menu.className = 'timeline-context-menu';

    const title = document.createElement('div');
    title.className = 'timeline-context-menu-title';
    title.textContent = getTranslationSync('timelineLevelTitle');
    menu.appendChild(title);

    const levels: { level: MarkerLevel; label: string }[] = [
      { level: 1, label: getTranslationSync('timelineLevel1') },
      { level: 2, label: getTranslationSync('timelineLevel2') },
      { level: 3, label: getTranslationSync('timelineLevel3') },
    ];

    levels.forEach(({ level, label }) => {
      const item = document.createElement('button');
      item.className = 'timeline-context-menu-item';
      if (level === currentLevel) {
        item.classList.add('active');
      }
      item.setAttribute('data-level', String(level));

      const indicator = document.createElement('span');
      indicator.className = 'level-indicator';
      const dotEl = document.createElement('span');
      dotEl.className = 'level-dot';
      indicator.appendChild(dotEl);
      item.appendChild(indicator);

      const labelSpan = document.createElement('span');
      labelSpan.textContent = label;
      item.appendChild(labelSpan);

      if (level === currentLevel) {
        const check = document.createElement('span');
        check.className = 'check-icon';
        check.textContent = 'v';
        item.appendChild(check);
      }

      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setMarkerLevel(turnId, level);
        this.hideContextMenu();
      });

      menu.appendChild(item);
    });

    if (canCollapse || isCollapsed) {
      // Add separator
      const separator = document.createElement('div');
      separator.className = 'timeline-context-menu-separator';
      menu.appendChild(separator);

      const collapseItem = document.createElement('button');
      collapseItem.className = 'timeline-context-menu-item collapse-item';

      const icon = document.createElement('span');
      icon.className = 'collapse-icon';
      icon.textContent = isCollapsed ? '+' : '-';
      collapseItem.appendChild(icon);

      const collapseLabel = document.createElement('span');
      collapseLabel.textContent = isCollapsed
        ? getTranslationSync('timelineExpand')
        : getTranslationSync('timelineCollapse');
      collapseItem.appendChild(collapseLabel);

      collapseItem.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleCollapse(turnId);
        this.hideContextMenu();
      });

      menu.appendChild(collapseItem);
    }

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    document.body.appendChild(menu);
    this.contextMenu = menu;
    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;

    let left = x;
    let top = y;

    if (left + menuWidth > vw - 10) {
      left = vw - menuWidth - 10;
    }
    if (top + menuHeight > vh - 10) {
      top = vh - menuHeight - 10;
    }

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    document.body.appendChild(menu);
    this.contextMenu = menu;
  }

  private hideContextMenu(): void {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
  }

  private cancelLongPress(): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    if (this.pressTargetDot) {
      this.pressTargetDot.classList.remove('holding');
    }
    this.pressTargetDot = null;
    this.pressStartPos = null;
    this.longPressTriggered = false;
  }

  /**
   * Initialize keyboard shortcuts for timeline navigation
   */
  private async initKeyboardShortcuts(): Promise<void> {
    try {
      await keyboardShortcutService.init();

      // Register shortcut handler with queue support
      this.shortcutUnsubscribe = keyboardShortcutService.on((action, event) => {
        if (action === 'timeline:previous') {
          this.enqueueNavigation('previous', event.repeat);
        } else if (action === 'timeline:next') {
          this.enqueueNavigation('next', event.repeat);
        } else if (action === 'timeline:first') {
          this.navigateToFirstNode();
        } else if (action === 'timeline:last') {
          this.navigateToLastNode();
        }
      });
    } catch (error) {
      console.warn('[Timeline] Failed to initialize keyboard shortcuts:', error);
    }
  }

  /**
   * Enqueue navigation action (supports rapid key presses)
   */
  private enqueueNavigation(direction: 'previous' | 'next', isRepeat: boolean = false): void {
    // Prevent accumulation during long presses
    if (isRepeat && this.navigationQueue.length > 0) {
      return;
    }
    // Limit queue size for rapid tapping as well
    if (this.navigationQueue.length >= 3) {
      return;
    }

    if (!this.canEnqueueNavigation(direction)) {
      return;
    }

    this.navigationQueue.push(direction);
    this.processNavigationQueue();
  }

  private canEnqueueNavigation(direction: 'previous' | 'next'): boolean {
    if (this.markers.length === 0) return false;

    const currentIndex = this.getActiveIndex();
    if (currentIndex < 0) return true;

    const isAtStart = currentIndex === 0;
    const isAtEnd = currentIndex === this.markers.length - 1;

    const isBoundaryBlocked =
      (direction === 'previous' && isAtStart) || (direction === 'next' && isAtEnd);
    if (!isBoundaryBlocked) return true;

    return this.shouldAttemptRefreshForNavigation();
  }

  private shouldAttemptRefreshForNavigation(): boolean {
    if (!this.userTurnSelector) return false;

    const documentCount = document.querySelectorAll(this.userTurnSelector).length;
    const containersDisconnected =
      (this.conversationContainer ? !this.conversationContainer.isConnected : true) ||
      (this.scrollContainer ? !this.scrollContainer.isConnected : true);

    return containersDisconnected || documentCount > this.markers.length;
  }

  private getScrollContainerForElement(element: HTMLElement): HTMLElement {
    let p: HTMLElement | null = element;
    while (p && p !== document.body) {
      const st = getComputedStyle(p);
      if (st.overflowY === 'auto' || st.overflowY === 'scroll') {
        return p;
      }
      p = p.parentElement;
    }

    return (
      (document.scrollingElement as HTMLElement | null) ||
      (document.documentElement as HTMLElement | null) ||
      (document.body as unknown as HTMLElement)
    );
  }

  private shouldRefreshForInteraction(targetElement: HTMLElement | null): boolean {
    if (this.shouldAttemptRefreshForNavigation()) return true;

    if (targetElement && !targetElement.isConnected) return true;

    if (
      targetElement &&
      this.conversationContainer &&
      !this.conversationContainer.contains(targetElement)
    ) {
      return true;
    }

    if (!targetElement || !this.scrollContainer) return false;

    const expectedScrollContainer = this.getScrollContainerForElement(targetElement);
    return expectedScrollContainer !== this.scrollContainer;
  }

  private maybeRefreshMarkersForInteraction(targetElement: HTMLElement | null): boolean {
    if (!this.userTurnSelector) return false;
    if (!this.shouldRefreshForInteraction(targetElement)) return false;

    const refreshed = this.refreshCriticalElementsFromDocument();
    if (!refreshed) return false;

    this.recalculateAndRenderMarkers();
    return true;
  }

  /**
   * Process navigation queue (one at a time)
   */
  private async processNavigationQueue(): Promise<void> {
    if (this.isNavigating || this.navigationQueue.length === 0) return;

    this.isNavigating = true;
    const direction = this.navigationQueue.shift()!;

    if (direction === 'previous') {
      await this.navigateToPreviousNode();
    } else {
      await this.navigateToNextNode();
    }

    this.isNavigating = false;

    // Process next item in queue
    if (this.navigationQueue.length > 0) {
      this.processNavigationQueue();
    }
  }

  /**
   * Perform navigation to a target node
   * Shared logic for previous/next navigation
   */
  private async performNodeNavigation(targetIndex: number, currentIndex: number): Promise<void> {
    const markerBeforeRefresh = this.markers[targetIndex];
    this.maybeRefreshMarkersForInteraction(markerBeforeRefresh?.element || null);

    if (targetIndex < 0 || targetIndex >= this.markers.length) return;

    // Clear any pending scroll updates to prevent interference
    if (this.activeChangeTimer) {
      clearTimeout(this.activeChangeTimer);
      this.activeChangeTimer = null;
      this.pendingActiveId = null;
    }

    const targetMarker = this.markers[targetIndex];
    if (!targetMarker?.element) return;

    if (this.scrollMode === 'flow' && currentIndex >= 0) {
      // Flow mode: animate with queue support
      const duration = this.computeFlowDuration(currentIndex, targetIndex);
      this.startRunner(currentIndex, targetIndex, duration);
      this.smoothScrollTo(targetMarker.element, duration, targetMarker.id);
      await new Promise<void>((resolve) => setTimeout(resolve, duration));
    } else {
      // Jump mode: instant, no wait
      this.smoothScrollTo(targetMarker.element, 0, targetMarker.id);
    }

    this.activeTurnId = targetMarker.id;
    this.updateActiveDotUI();
  }

  /**
   * Navigate to previous timeline node (k or custom shortcut)
   */
  private async navigateToPreviousNode(): Promise<void> {
    if (this.markers.length === 0) return;

    this.maybeRefreshMarkersForNavigation('previous');
    const currentIndex = this.getActiveIndex();
    const targetIndex = currentIndex <= 0 ? 0 : currentIndex - 1;

    await this.performNodeNavigation(targetIndex, currentIndex);
  }

  /**
   * Navigate to next timeline node (j or custom shortcut)
   */
  private async navigateToNextNode(): Promise<void> {
    if (this.markers.length === 0) return;

    this.maybeRefreshMarkersForNavigation('next');
    const currentIndex = this.getActiveIndex();
    const targetIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, this.markers.length - 1);

    await this.performNodeNavigation(targetIndex, currentIndex);
  }

  /**
   * Navigate to first timeline node (gg)
   */
  private async navigateToFirstNode(): Promise<void> {
    if (this.markers.length === 0) return;

    this.maybeRefreshMarkersForNavigation('previous');
    this.navigationQueue.length = 0;
    const currentIndex = this.getActiveIndex();

    await this.performNodeNavigation(0, currentIndex);
  }

  /**
   * Navigate to last timeline node (GG)
   */
  private async navigateToLastNode(): Promise<void> {
    if (this.markers.length === 0) return;

    this.maybeRefreshMarkersForNavigation('next');
    this.navigationQueue.length = 0;
    const currentIndex = this.getActiveIndex();

    await this.performNodeNavigation(this.markers.length - 1, currentIndex);
  }

  private maybeRefreshMarkersForNavigation(direction: 'previous' | 'next'): void {
    if (!this.userTurnSelector) return;

    const currentIndex = this.getActiveIndex();
    const isAtStart = currentIndex === 0;
    const isAtEnd = currentIndex >= 0 && currentIndex === this.markers.length - 1;

    const shouldAttemptRefresh =
      (direction === 'previous' && isAtStart) || (direction === 'next' && isAtEnd);
    if (!shouldAttemptRefresh) return;

    if (!this.shouldAttemptRefreshForNavigation()) return;

    const refreshed = this.refreshCriticalElementsFromDocument();
    if (!refreshed) return;

    this.recalculateAndRenderMarkers();
  }

  private isTimelineScrollEventTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return (
      target === this.ui.track ||
      target === this.ui.trackContent ||
      !!target.closest?.('.gpt-timeline-bar, .timeline-preview-panel, .timeline-left-slider')
    );
  }

  private getDocumentScrollElement(): HTMLElement {
    return (
      (document.scrollingElement as HTMLElement | null) ||
      (document.documentElement as HTMLElement | null) ||
      (document.body as unknown as HTMLElement)
    );
  }

  private isDocumentScrollEventTarget(target: EventTarget | null): boolean {
    const documentScroller = this.getDocumentScrollElement();
    return (
      !target ||
      target === document ||
      target === window ||
      target === documentScroller ||
      target === document.documentElement ||
      target === document.body
    );
  }

  private shouldRefreshScrollContainerFromEvent(target: EventTarget | null): boolean {
    if (
      this.scrollContainer &&
      target === this.scrollContainer &&
      this.scrollContainer.isConnected &&
      this.isScrollableElement(this.scrollContainer)
    ) {
      return false;
    }

    if (
      target instanceof HTMLElement &&
      target !== this.scrollContainer &&
      this.isScrollableElement(target)
    ) {
      const firstTurn = this.userTurnSelector
        ? (document.querySelector(this.userTurnSelector) as HTMLElement | null)
        : null;
      if (firstTurn && (target.contains(firstTurn) || firstTurn.contains(target))) {
        return true;
      }
    }

    const currentLooksFresh =
      !!this.scrollContainer &&
      this.scrollContainer.isConnected &&
      this.isScrollableElement(this.scrollContainer);
    if (!currentLooksFresh) return true;

    const now =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    return now - this.lastScrollContainerRefreshAt >= this.scrollContainerRefreshInterval;
  }

  private isScrollableElement(element: HTMLElement | null): element is HTMLElement {
    if (!element) return false;
    return element.scrollHeight > element.clientHeight + 1;
  }

  private replaceScrollContainer(nextScrollContainer: HTMLElement): boolean {
    if (nextScrollContainer === this.scrollContainer) return false;

    if (this.scrollContainer && this.onScroll) {
      try {
        this.scrollContainer.removeEventListener('scroll', this.onScroll);
      } catch {}
    }

    this.scrollContainer = nextScrollContainer;
    this.lastObservedScrollTop = this.scrollContainer.scrollTop || 0;

    if (this.onScroll) {
      this.scrollContainer.addEventListener('scroll', this.onScroll, { passive: true });
    }

    if (this.intersectionObserver && this.scrollContainer) {
      try {
        this.intersectionObserver.disconnect();
        this.intersectionObserver = new IntersectionObserver(
          () => {
            this.scheduleScrollSync();
          },
          { root: this.scrollContainer, threshold: 0.1, rootMargin: '-40% 0px -59% 0px' },
        );
        this.updateIntersectionObserverTargetsFromMarkers();
      } catch {}
    }

    return true;
  }

  private refreshMarkerTopsForCurrentScrollContainer(): boolean {
    if (!this.scrollContainer || this.markers.length === 0) return false;
    const nextTops = this.markers.map((marker) =>
      this.computeElementTopInScrollContainer(marker.element),
    );
    const changed =
      nextTops.length !== this.markerTops.length ||
      nextTops.some((top, index) => Math.abs(top - (this.markerTops[index] ?? Number.NaN)) > 1);
    this.markerTops = nextTops;
    this.lastMarkerTopsSanityCheckAt = 0;
    this.markerTopsMatchViewportCache = true;
    return changed;
  }

  private refreshScrollContainerForElement(element: HTMLElement | null | undefined): boolean {
    if (!element) return false;
    const nextScrollContainer = this.getScrollContainerForElement(element);
    if (!nextScrollContainer) return false;
    const containerChanged = this.replaceScrollContainer(nextScrollContainer);
    const markerTopsChanged = this.refreshMarkerTopsForCurrentScrollContainer();
    return containerChanged || markerTopsChanged;
  }

  private refreshScrollContainerFromMarkers(): boolean {
    return this.refreshScrollContainerForElement(this.markers[0]?.element || null);
  }

  private maybeRefreshScrollContainerFromMarkers(): boolean {
    const firstMarker = this.markers[0];
    if (!firstMarker?.element) return false;

    const now =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const currentLooksStale =
      !this.scrollContainer ||
      !this.scrollContainer.isConnected ||
      this.scrollContainer.scrollHeight <= this.scrollContainer.clientHeight + 1;

    if (
      !currentLooksStale &&
      now - this.lastScrollContainerRefreshAt < this.scrollContainerRefreshInterval
    ) {
      return false;
    }

    this.lastScrollContainerRefreshAt = now;
    return this.refreshScrollContainerForElement(firstMarker.element);
  }

  private adoptScrollContainerFromScrollEvent(target: EventTarget | null): boolean {
    if (!this.userTurnSelector) return false;

    const firstTurn = document.querySelector(this.userTurnSelector) as HTMLElement | null;
    if (!firstTurn) return false;

    let nextScrollContainer: HTMLElement | null = null;

    if (this.isDocumentScrollEventTarget(target)) {
      const documentScroller = this.getDocumentScrollElement();
      if (this.isScrollableElement(documentScroller)) {
        nextScrollContainer = documentScroller;
      }
    } else if (target instanceof HTMLElement && this.isScrollableElement(target)) {
      if (target.contains(firstTurn) || firstTurn.contains(target)) {
        nextScrollContainer = target;
      }
    }

    if (!nextScrollContainer) {
      nextScrollContainer = this.getScrollContainerForElement(firstTurn);
    }

    if (!nextScrollContainer || !this.replaceScrollContainer(nextScrollContainer)) return false;

    this.refreshMarkerTopsForCurrentScrollContainer();
    this.updateTimelineGeometry();
    this.syncTimelineTrackToMain();
    this.updateVirtualRangeAndRender();
    this.updateSlider();
    return true;
  }

  private refreshCriticalElementsFromDocument(): boolean {
    if (!this.userTurnSelector) return false;

    const firstTurn = document.querySelector(this.userTurnSelector) as HTMLElement | null;
    if (!firstTurn) return false;

    const nextConversationContainer =
      (document.querySelector('main') as HTMLElement | null) || (document.body as HTMLElement);
    this.conversationContainer = nextConversationContainer;

    const nextScrollContainer = this.getScrollContainerForElement(firstTurn);

    const scrollContainerChanged = this.scrollContainer !== nextScrollContainer;
    if (scrollContainerChanged) {
      if (this.scrollContainer && this.onScroll) {
        try {
          this.scrollContainer.removeEventListener('scroll', this.onScroll);
        } catch {}
      }
      this.scrollContainer = nextScrollContainer;
      if (this.scrollContainer && this.onScroll) {
        this.scrollContainer.addEventListener('scroll', this.onScroll, { passive: true });
      }
    }

    if (this.mutationObserver && this.conversationContainer) {
      try {
        this.mutationObserver.disconnect();
        this.mutationObserver.observe(this.conversationContainer, {
          childList: true,
          subtree: true,
        });
      } catch {}
    }

    if (this.intersectionObserver && this.scrollContainer) {
      try {
        this.intersectionObserver.disconnect();
        this.intersectionObserver = new IntersectionObserver(
          () => {
            this.scheduleScrollSync();
          },
          { root: this.scrollContainer, threshold: 0.1, rootMargin: '-40% 0px -59% 0px' },
        );
      } catch {}
    }

    return true;
  }

  /**
   * Handle starred message navigation with optimized performance
   * Strategy: Quick check if markers ready, otherwise retry with exponential backoff
   */
  private handleStarredMessageNavigation(): void {
    try {
      const hash = window.location.hash;
      if (!hash.startsWith('#gv-turn-')) return;

      const turnId = hash.replace('#gv-turn-', '');
      if (!turnId) return;

      console.log('[Timeline] Handling starred message navigation, turnId:', turnId);

      let attempts = 0;
      const maxAttempts = 20;

      const checkAndScroll = (): boolean => {
        if (this.markers.length === 0) return false;

        const marker = this.markerMap.get(turnId);
        if (marker && marker.element) {
          console.log('[Timeline] Found target marker, scrolling');

          // Minimal delay for DOM readiness
          const liveElement = marker.element;
          setTimeout(() => {
            this.smoothScrollTo(liveElement, 800, marker.id);

            // Clear hash after scroll completes
            setTimeout(() => {
              window.history.replaceState(
                null,
                '',
                window.location.pathname + window.location.search,
              );
            }, 900);
          }, 100);
          return true;
        }
        return false;
      };

      // Optimized retry logic with exponential backoff
      const retry = () => {
        if (checkAndScroll()) return;

        attempts++;
        if (attempts >= maxAttempts) {
          console.warn('[Timeline] Failed to find starred message');
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
          return;
        }

        // Exponential backoff: 100ms, 200ms, 300ms, 300ms, 300ms...
        const delay = Math.min(attempts * 100, 300);
        setTimeout(retry, delay);
      };

      // Quick first attempt if markers might be ready
      if (this.markers.length > 0) {
        if (checkAndScroll()) return;
      }

      // Start retry sequence with minimal initial delay
      setTimeout(retry, 200);
    } catch (error) {
      console.error('[Timeline] Failed to handle starred message navigation:', error);
    }
  }

  destroy(): void {
    // Stop hiding ChatGPT's native prompt-TOC once our timeline goes away.
    try {
      document.body.classList.remove('gv-timeline-active');
    } catch {}

    // Persist any pending text-cache writes before tearing the manager down
    // (URL change between conversations triggers destroy → new TimelineManager,
    // so an in-flight debounced save would otherwise drop on the floor).
    try {
      this.turnTextCache.flushSync();
    } catch {}

    // Unsubscribe from the API-capture service so we don't leak a listener
    // per URL navigation. Without this, every conversation switch (which
    // tears down this manager and spawns a fresh one) would add one more
    // dangling closure to the singleton's listener list, fed by every
    // future capture event.
    if (this.cachePrimerDispose) {
      try {
        this.cachePrimerDispose();
      } catch {}
      this.cachePrimerDispose = null;
    }

    // Cleanup keyboard shortcuts
    if (this.shortcutUnsubscribe) {
      try {
        this.shortcutUnsubscribe();
        this.shortcutUnsubscribe = null;
      } catch (error) {
        console.error('[Timeline] Failed to unsubscribe from keyboard shortcuts:', error);
      }
    }

    // Clear navigation queue
    this.navigationQueue = [];
    this.isNavigating = false;

    // Cleanup EventBus subscriptions (Observer pattern cleanup)
    this.eventBusUnsubscribers.forEach((unsubscribe) => {
      try {
        unsubscribe();
      } catch (error) {
        console.error('[Timeline] Failed to unsubscribe from EventBus:', error);
      }
    });
    this.eventBusUnsubscribers = [];

    if (this.onGvTurnHashChange) {
      window.removeEventListener('hashchange', this.onGvTurnHashChange);
      this.onGvTurnHashChange = null;
    }

    // Ensure draggable listeners are removed
    try {
      this.toggleDraggable(false);
    } catch {}
    // Remove bar pointerdown and cursor listeners (always attached)
    try {
      if (this.onBarPointerDown)
        this.ui.timelineBar?.removeEventListener('pointerdown', this.onBarPointerDown);
    } catch {}
    try {
      if (this.onBarCursorMove)
        this.ui.timelineBar?.removeEventListener('pointermove', this.onBarCursorMove);
    } catch {}
    // Remove any in-flight resize listeners
    try {
      if (this.onResizeMove) window.removeEventListener('pointermove', this.onResizeMove);
    } catch {}
    try {
      if (this.onResizeUp) window.removeEventListener('pointerup', this.onResizeUp);
    } catch {}
    // Also remove any in-flight drag listeners
    try {
      if (this.onBarPointerMove) window.removeEventListener('pointermove', this.onBarPointerMove);
    } catch {}
    try {
      if (this.onBarPointerUp) window.removeEventListener('pointerup', this.onBarPointerUp);
    } catch {}
    try {
      this.mutationObserver?.disconnect();
    } catch {}
    try {
      this.resizeObserver?.disconnect();
    } catch {}
    try {
      this.intersectionObserver?.disconnect();
    } catch {}
    this.visibleUserTurns.clear();
    if (this.ui.timelineBar && this.onTimelineBarClick) {
      try {
        this.ui.timelineBar.removeEventListener('click', this.onTimelineBarClick);
      } catch {}
    }
    try {
      window.removeEventListener('storage', this.onStorage!);
    } catch {}
    if (this.onChromeStorageChanged && typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      try {
        chrome.storage.onChanged.removeListener(this.onChromeStorageChanged);
      } catch {}
      this.onChromeStorageChanged = null;
    }
    // Cleanup context menu
    this.hideContextMenu();
    try {
      this.ui.timelineBar?.removeEventListener('contextmenu', this.onContextMenu!);
    } catch {}
    try {
      document.removeEventListener('click', this.onDocumentClick!);
    } catch {}
    try {
      this.ui.timelineBar?.removeEventListener('pointerdown', this.onPointerDown!);
    } catch {}
    try {
      window.removeEventListener('pointermove', this.onPointerMove!);
    } catch {}
    try {
      window.removeEventListener('pointerup', this.onPointerUp!);
    } catch {}
    try {
      window.removeEventListener('pointercancel', this.onPointerCancel!);
    } catch {}
    try {
      this.ui.timelineBar?.removeEventListener('pointerleave', this.onPointerLeave!);
    } catch {}
    if (this.scrollContainer && this.onScroll) {
      try {
        this.scrollContainer.removeEventListener('scroll', this.onScroll);
      } catch {}
    }
    if (this.onDocumentScroll) {
      try {
        document.removeEventListener('scroll', this.onDocumentScroll, { capture: true });
      } catch {}
      try {
        window.removeEventListener('scroll', this.onDocumentScroll);
      } catch {}
    }
    if (this.ui.timelineBar) {
      try {
        this.ui.timelineBar.removeEventListener('wheel', this.onTimelineWheel!);
      } catch {}
      try {
        this.ui.timelineBar.removeEventListener('pointerenter', this.onBarEnter!);
      } catch {}
      try {
        this.ui.timelineBar.removeEventListener('pointerleave', this.onBarLeave!);
      } catch {}
      try {
        this.ui.slider?.removeEventListener('pointerenter', this.onSliderEnter!);
      } catch {}
      try {
        this.ui.slider?.removeEventListener('pointerleave', this.onSliderLeave!);
      } catch {}
    }
    try {
      this.ui.sliderHandle?.removeEventListener('pointerdown', this.onSliderDown!);
    } catch {}
    try {
      window.removeEventListener('resize', this.onWindowResize!);
    } catch {}
    if (this.onVisualViewportResize && window.visualViewport) {
      try {
        window.visualViewport.removeEventListener('resize', this.onVisualViewportResize);
      } catch {}
      this.onVisualViewportResize = null;
    }
    if (this.scrollRafId !== null) {
      try {
        cancelAnimationFrame(this.scrollRafId);
      } catch {}
      this.scrollRafId = null;
    }
    if (this.scrollRafFallbackTimerId !== null) {
      try {
        window.clearTimeout(this.scrollRafFallbackTimerId);
      } catch {}
      this.scrollRafFallbackTimerId = null;
    }
    if (this.scrollSyncTimerId !== null) {
      try {
        window.clearTimeout(this.scrollSyncTimerId);
      } catch {}
      this.scrollSyncTimerId = null;
    }
    if (this.deferredMarkerRecalcTimerId !== null) {
      try {
        window.clearTimeout(this.deferredMarkerRecalcTimerId);
      } catch {}
      this.deferredMarkerRecalcTimerId = null;
    }
    if (this.pendingMarkerOrderTimerId !== null) {
      try {
        window.clearTimeout(this.pendingMarkerOrderTimerId);
      } catch {}
      this.pendingMarkerOrderTimerId = null;
    }
    if (this.scrollPollIntervalId !== null) {
      try {
        window.clearInterval(this.scrollPollIntervalId);
      } catch {}
      this.scrollPollIntervalId = null;
    }
    try {
      this.ui.timelineBar?.remove();
    } catch {}
    try {
      if (this.onPinToggleClick) {
        this.pinToggleButton?.removeEventListener('click', this.onPinToggleClick);
      }
      if (this.onPinPrevClick) {
        this.pinPrevButton?.removeEventListener('click', this.onPinPrevClick);
      }
      if (this.onPinNextClick) {
        this.pinNextButton?.removeEventListener('click', this.onPinNextClick);
      }
      if (this.onPinDeleteClick) {
        this.pinDeleteButton?.removeEventListener('click', this.onPinDeleteClick);
      }
      if (this.onDocumentPinClick) {
        document.removeEventListener('click', this.onDocumentPinClick, true);
      }
      this.pinControls?.remove();
      this.pinBadgeLayer?.remove();
      document.body.classList.remove('timeline-pin-picking');
    } catch {}
    if (this.pinBadgePositionRaf !== null) {
      try {
        cancelAnimationFrame(this.pinBadgePositionRaf);
      } catch {}
      this.pinBadgePositionRaf = null;
    }
    this.pinControls = null;
    this.pinPrevButton = null;
    this.pinNextButton = null;
    this.pinToggleButton = null;
    this.pinBadgeLayer = null;
    this.pinDeleteButton = null;
    this.selectedPinId = null;
    this.selectedPinTurnId = null;
    this.pinBadges.clear();
    this.onPinToggleClick = null;
    this.onPinPrevClick = null;
    this.onPinNextClick = null;
    this.onPinDeleteClick = null;
    this.onDocumentPinClick = null;
    this.pinMode = false;
    try {
      this.ui.tooltip?.remove();
    } catch {}
    try {
      this.measureEl?.remove();
    } catch {}
    try {
      if (this.ui.slider) {
        this.ui.slider.style.pointerEvents = 'none';
        this.ui.slider.remove();
      }
      const stray = document.querySelector('.timeline-left-slider');
      if (stray) {
        (stray as HTMLElement).style.pointerEvents = 'none';
        stray.remove();
      }
    } catch {}
    this.ui.slider = null;
    this.ui.sliderHandle = null;
    this.clearSearchHighlights();
    this.previewPanel?.destroy();
    this.previewPanel = null;
    document.body.classList.remove(GV_RTL_CLASS);
    this.ui = { timelineBar: null, tooltip: null };
    this.markers = [];
    this.markerTops = [];
    this.activeTurnId = null;
    this.scrollContainer = null;
    this.conversationContainer = null;
    this.onDocumentScroll = null;
    if (this.activeChangeTimer) {
      clearTimeout(this.activeChangeTimer);
      this.activeChangeTimer = null;
    }
    if (this.tooltipHideTimer) {
      clearTimeout(this.tooltipHideTimer);
      this.tooltipHideTimer = null;
    }
    if (this.resizeIdleTimer) {
      clearTimeout(this.resizeIdleTimer);
      this.resizeIdleTimer = null;
    }
    try {
      if (this.resizeIdleRICId && 'cancelIdleCallback' in window) {
        (window as Window & { cancelIdleCallback: (id: number) => void }).cancelIdleCallback(
          this.resizeIdleRICId,
        );
        this.resizeIdleRICId = null;
      }
    } catch {}
    if (this.sliderFadeTimer) {
      clearTimeout(this.sliderFadeTimer);
      this.sliderFadeTimer = null;
    }
    if (this.timestampStartupTimer) {
      clearTimeout(this.timestampStartupTimer);
      this.timestampStartupTimer = null;
    }
    this.pendingActiveId = null;
  }

  private updateTimestampTracking(markerIds: string[]): void {
    if (!this.timestampTrackingReady) {
      markerIds.forEach((markerId) => this.seenTurnIds.add(markerId));
      const shouldResetDelay = markerIds.length > 0 || this.seenTurnIds.size > 0;
      this.scheduleTimestampTrackingReady(shouldResetDelay);
      return;
    }

    markerIds.forEach((markerId) => {
      if (this.seenTurnIds.has(markerId)) return;
      this.seenTurnIds.add(markerId);
      this.recordTimestampForTurn(markerId);
    });
  }

  private scheduleTimestampTrackingReady(resetDelay: boolean): void {
    if (this.timestampTrackingReady) return;

    if (resetDelay && this.timestampStartupTimer !== null) {
      clearTimeout(this.timestampStartupTimer);
      this.timestampStartupTimer = null;
    }

    if (this.timestampStartupTimer !== null) return;

    this.timestampStartupTimer = window.setTimeout(() => {
      this.timestampTrackingReady = true;
      this.timestampStartupTimer = null;
    }, this.initialTimestampSnapshotDelay);
  }

  private recordTimestampForTurn(turnId: string): void {
    if (!this.timestampService || !this.conversationId) return;
    if (this.timestampService.getTimestamp(this.conversationId, turnId as TurnId) !== null) return;

    this.timestampService.recordTimestamp(this.conversationId, turnId as TurnId).catch(() => {});
  }

  private maybeAdoptDraftRouteTimestamps(markerIds: string[]): void {
    if (
      !this.timestampService ||
      !this.conversationId ||
      !this.pendingDraftTimestampSourceConversationId ||
      markerIds.length === 0
    ) {
      return;
    }

    const sourceConversationId = this.pendingDraftTimestampSourceConversationId;
    const latestDraftTimestamp =
      this.timestampService.getLatestTimestampForConversation(sourceConversationId);

    this.pendingDraftTimestampSourceConversationId = null;

    if (
      latestDraftTimestamp == null ||
      Date.now() - latestDraftTimestamp > this.draftTimestampAdoptionWindowMs
    ) {
      return;
    }

    this.timestampService
      .adoptTimestamps(
        sourceConversationId,
        this.conversationId,
        markerIds.map((markerId) => markerId as TurnId),
      )
      .catch(() => {});
  }

  private computeDraftTimestampSourceConversationId(previousUrl: string | null): string | null {
    if (!previousUrl) return null;

    const previousNativeConversationId = extractConversationIdFromUrl(previousUrl);
    const currentNativeConversationId = extractConversationIdFromUrl(window.location.href);

    if (previousNativeConversationId || !currentNativeConversationId) {
      return null;
    }

    return buildConversationIdFromUrl(previousUrl);
  }

  private shouldIgnoreTimestampMutations(records: MutationRecord[]): boolean {
    if (records.length === 0) return false;

    return records.every((record) => {
      if (record.type !== 'childList') return false;

      const changedNodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
      if (changedNodes.length === 0) return false;

      return changedNodes.every((node) => this.isTimestampMutationNode(node));
    });
  }

  private isTimestampMutationNode(node: Node): boolean {
    if (node instanceof HTMLElement) {
      return node.classList.contains('gv-timestamp') || !!node.closest('.gv-timestamp');
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return !!node.parentElement?.closest('.gv-timestamp');
    }

    return false;
  }
}
