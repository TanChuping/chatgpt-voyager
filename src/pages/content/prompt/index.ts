/* Prompt Manager content module
 * - Injects a floating trigger button using the extension icon
 * - Opens a small anchored panel above the trigger (default)
 * - Panel supports: i18n language switch, add prompt, tag chips, search, copy, import/export
 * - Optional lock to pin panel position; when locked, panel is draggable and persisted
 */
import DOMPurify from 'dompurify';
import JSZip from 'jszip';
import 'katex/dist/katex.min.css';
import type { marked as MarkedFn } from 'marked';
import browser from 'webextension-polyfill';

import { PROJECT_REPOSITORY_URL } from '@/core/constants/project';
import { logger } from '@/core/services/LoggerService';
import { exportBackupableSyncSettings } from '@/core/services/SettingsBackupService';
import { promptStorageService } from '@/core/services/StorageService';
import {
  DEFAULT_SUPPORT_GOAL,
  SUPPORT_GOAL_REFRESH_MS,
  formatSupportAmount,
  getSupportGoalProgress,
  loadSupportGoal,
  type SupportGoalData,
} from '@/core/services/SupportGoalService';
import { type StorageKey, StorageKeys } from '@/core/types/common';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';
import { migrateFromLocalStorage } from '@/core/utils/storageMigration';
import { EXTENSION_VERSION } from '@/core/utils/version';
import {
  getTimelineHierarchyStorageKeysToRead,
  resolveTimelineHierarchyDataForStorageScope,
} from '@/pages/content/timeline/hierarchyStorage';
import { normalizeTimelineHierarchyData } from '@/pages/content/timeline/hierarchyTypes';
import { getCurrentLanguage, getTranslationSync, initI18n, setCachedLanguage } from '@/utils/i18n';
import {
  APP_LANGUAGES,
  APP_LANGUAGE_LABELS,
  type AppLanguage,
  isAppLanguage,
  normalizeLanguage,
} from '@/utils/language';
import type { TranslationKey } from '@/utils/translations';

import { insertTextIntoChatInput } from '../chatInput/index';
import { createFolderStorageAdapter } from '../folder/storage/FolderStorageAdapter';
import { expandInputCollapseIfNeeded } from '../inputCollapse/index';
import { extractPlainTitle } from './compactTitle';
import { parsePromptImportPayload } from './importPayload';
import { activatePromptText } from './promptClickAction';
import { getScrollHintState } from './scrollHint';

type PromptItem = {
  id: string;
  text: string;
  tags: string[];
  createdAt: number;
  updatedAt?: number;
  /**
   * Optional user-authored label used as the headline in compact list view.
   * Falls back to `extractPlainTitle(text)` when absent so existing prompts
   * render without any migration. Introduced for issue #586 feedback item 4c.
   */
  name?: string;
};

type PanelPosition = { top: number; left: number };
type TriggerPosition = { bottom: number; right: number };

const STORAGE_KEYS = {
  items: StorageKeys.PROMPT_ITEMS,
  locked: StorageKeys.PROMPT_PANEL_LOCKED,
  position: StorageKeys.PROMPT_PANEL_POSITION,
  triggerPos: StorageKeys.PROMPT_TRIGGER_POSITION,
  language: StorageKeys.LANGUAGE, // reuse global language key
  theme: StorageKeys.PROMPT_THEME,
} as const;

const ID = {
  trigger: 'gv-pm-trigger',
  panel: 'gv-pm-panel',
} as const;

type PMTheme = 'light' | 'dark';
type PMViewMode = 'compact' | 'comfortable';

function getThemeIconSvg(theme: PMTheme): string {
  if (theme === 'dark') {
    return [
      '<svg class="gv-pm-theme-icon" viewBox="0 0 24 24" aria-hidden="true">',
      '<path d="M12 3v2.4M12 18.6V21M4.64 4.64l1.7 1.7M17.66 17.66l1.7 1.7M3 12h2.4M18.6 12H21M4.64 19.36l1.7-1.7M17.66 6.34l1.7-1.7"/>',
      '<circle cx="12" cy="12" r="4.2"/>',
      '</svg>',
    ].join('');
  }
  return [
    '<svg class="gv-pm-theme-icon" viewBox="0 0 24 24" aria-hidden="true">',
    '<path d="M21 12.8A8.4 8.4 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"/>',
    '</svg>',
  ].join('');
}

function detectPageTheme(): PMTheme {
  if (
    document.querySelector('.theme-host.dark-theme') ||
    document.body.classList.contains('dark-theme') ||
    document.documentElement.classList.contains('dark') ||
    document.body.getAttribute('data-theme') === 'dark'
  ) {
    return 'dark';
  }
  if (
    document.querySelector('.theme-host.light-theme') ||
    document.body.classList.contains('light-theme') ||
    document.documentElement.classList.contains('light') ||
    document.body.getAttribute('data-theme') === 'light'
  ) {
    return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getRuntimeUrl(path: string): string {
  // Try the standard Web Extensions API first (mainly for Firefox)
  try {
    return browser.runtime.getURL(path);
  } catch {
    const win = window as Window & { chrome?: { runtime?: { getURL?: (path: string) => string } } };
    return win.chrome?.runtime?.getURL?.(path) || path;
  }
}

function safeParseJSON<T>(raw: string, fallback: T): T {
  try {
    const v = JSON.parse(raw);
    return v as T;
  } catch {
    return fallback;
  }
}

// Use centralized i18n system
function createI18n() {
  return {
    t: (key: TranslationKey): string => getTranslationSync(key),
    set: async (lang: AppLanguage) => {
      try {
        // Check if extension context is still valid
        if (!browser.runtime?.id) {
          // Extension context invalidated, skip
          return;
        }
        setCachedLanguage(lang);
        await browser.storage.sync.set({ language: lang });
        return;
      } catch (e) {
        try {
          await browser.storage.local.set({ language: lang });
          return;
        } catch (localError) {
          // Silently ignore extension context errors
          if (
            isExtensionContextInvalidatedError(e) ||
            isExtensionContextInvalidatedError(localError)
          ) {
            return;
          }
          console.warn('[PromptManager] Failed to set language:', e, localError);
        }
      }
    },
    get: async (): Promise<AppLanguage> => await getCurrentLanguage(),
  };
}

function uid(): string {
  // FNV-1a-ish hash over timestamp + rand
  const seed = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Storage adapter - uses chrome.storage.local for cross-domain data sharing
 * Falls back to localStorage if chrome.storage is unavailable
 */
const pmLogger = logger.createChild('PromptManager');

const normalizeVersionString = (version?: string | null): string | null => {
  if (!version) return null;
  const trimmed = version.trim();
  return trimmed ? trimmed.replace(/^v/i, '') : null;
};

async function readStorage<T>(key: StorageKey, fallback: T): Promise<T> {
  const result = await promptStorageService.get<T>(key);
  if (result.success) {
    return result.data;
  }
  pmLogger.debug(`Key not found: ${key}, using fallback`);
  return fallback;
}

async function writeStorage<T>(key: StorageKey, value: T): Promise<void> {
  const result = await promptStorageService.set(key, value);
  if (!result.success) {
    pmLogger.error(`Failed to write key: ${key}`, {
      error: result.error?.message || 'Unknown error',
      errorDetails: result.error,
    });
  }
}

function createEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

function elFromHTML(html: string): HTMLElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild as HTMLElement;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createSupportPanel(i18n: ReturnType<typeof createI18n>): HTMLElement {
  const wrap = createEl('div', 'gv-pm-support-wrap');
  const button = createEl('button', 'gv-pm-support-btn');
  button.type = 'button';
  button.textContent = '?';
  button.title = i18n.t('supportMysteryButton');
  button.setAttribute('aria-label', i18n.t('supportMysteryButton'));
  button.setAttribute('aria-haspopup', 'dialog');

  const popover = createEl('div', 'gv-pm-support-popover gv-hidden');
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', i18n.t('supportMysteryButton'));
  document.body.appendChild(popover);

  let pinned = false;
  let loaded = false;
  let hoveringButton = false;
  let hoveringPopover = false;
  let closeTimer: number | null = null;
  let refreshTimer: number | null = null;
  let selectedPayment: 'wechat' | 'alipay' = 'wechat';
  let supportLanguage: AppLanguage = 'en';
  let currentGoal: SupportGoalData | null = null;

  const getGoalCopy = (goal: SupportGoalData) => {
    const useChinese = supportLanguage === 'zh';
    return {
      title: useChinese ? goal.titleZh || goal.title : goal.titleEn || goal.title,
      description: useChinese ? goal.descriptionZh || goal.description : goal.descriptionEn || goal.description,
    };
  };

  const renderGoal = (goal: SupportGoalData) => {
    currentGoal = goal;
    popover.textContent = '';
    if (!goal.enabled) {
      popover.classList.add('gv-hidden');
      return;
    }

    const copy = getGoalCopy(goal);
    const title = createEl('div', 'gv-pm-support-title');
    title.textContent = copy.title;
    const description = createEl('p', 'gv-pm-support-copy');
    description.textContent = copy.description;
    const children = [title, description] as HTMLElement[];

    if (goal.imageUrl) {
      const image = createEl('img', 'gv-pm-support-image');
      image.src = goal.imageUrl;
      image.alt = copy.title;
      children.push(image);
    }

    const progress = getSupportGoalProgress(goal);
    const meta = createEl('div', 'gv-pm-support-meta');
    const amount = createEl('span');
    amount.textContent = `${formatSupportAmount(goal.current, goal.currency)} / ${formatSupportAmount(goal.target, goal.currency)}`;
    const percent = createEl('span');
    percent.textContent = `${progress}%`;
    meta.append(amount, percent);

    const bar = createEl('div', 'gv-pm-support-bar');
    const fill = createEl('div', 'gv-pm-support-bar-fill');
    fill.style.width = `${progress}%`;
    bar.appendChild(fill);

    const actions = createEl('div', 'gv-pm-support-actions');
    const kofiLink = createEl('a', 'gv-pm-support-kofi');
    kofiLink.href = goal.kofiUrl;
    kofiLink.target = '_blank';
    kofiLink.rel = 'noopener noreferrer';
    kofiLink.textContent = 'Ko-fi';
    actions.appendChild(kofiLink);

    const paymentOptions = [
      { key: 'wechat' as const, label: '\u5fae\u4fe1', url: goal.wechatQrUrl },
      { key: 'alipay' as const, label: '\u652f\u4ed8\u5b9d', url: goal.alipayQrUrl },
    ].filter((option) => option.url);
    if (!paymentOptions.some((option) => option.key === selectedPayment)) {
      selectedPayment = paymentOptions[0]?.key ?? 'wechat';
    }

    const layout = createEl('div', 'gv-pm-support-layout');
    const main = createEl('div', 'gv-pm-support-main');
    main.append(...children, meta, bar, actions);
    layout.appendChild(main);

    if (paymentOptions.length > 0) {
      const side = createEl('div', 'gv-pm-support-side');
      const payments = createEl('div', 'gv-pm-support-payments');
      const tabs = createEl('div', 'gv-pm-support-payment-tabs');
      const activePayment =
        paymentOptions.find((option) => option.key === selectedPayment) ?? paymentOptions[0];

      for (const option of paymentOptions) {
        const tab = createEl('button', 'gv-pm-support-payment-tab');
        tab.type = 'button';
        tab.textContent = option.label;
        tab.setAttribute('aria-pressed', String(option.key === activePayment.key));
        tab.addEventListener('click', () => {
          selectedPayment = option.key;
          renderGoal(goal);
          positionPopover();
        });
        tabs.appendChild(tab);
      }

      const code = createEl('div', `gv-pm-support-payment gv-pm-support-payment-${activePayment.key}`);
      const img = createEl('img');
      img.src = activePayment.url;
      img.alt = `${activePayment.label} QR`;
      code.appendChild(img);
      payments.append(tabs, code);
      side.appendChild(payments);
      layout.appendChild(side);
    }

    popover.appendChild(layout);
  };

  void i18n.get().then((lang) => {
    supportLanguage = lang;
    if (currentGoal) renderGoal(currentGoal);
  });

  wrap.addEventListener('gv-pm-language-change', (event) => {
    const next = (event as CustomEvent<AppLanguage>).detail;
    if (!isAppLanguage(next)) return;
    supportLanguage = next;
    if (currentGoal) renderGoal(currentGoal);
  });

  const positionPopover = () => {
    const margin = 12;
    const buttonRect = button.getBoundingClientRect();
    const panelTheme =
      document.getElementById(ID.panel)?.getAttribute('data-gv-theme') || detectPageTheme();
    popover.setAttribute('data-gv-theme', panelTheme);
    popover.style.maxHeight = `${Math.max(240, window.innerHeight - margin * 2)}px`;
    popover.style.left = `${margin}px`;
    popover.style.top = `${margin}px`;

    const rect = popover.getBoundingClientRect();
    const left = Math.min(
      window.innerWidth - rect.width - margin,
      Math.max(margin, buttonRect.right - rect.width),
    );
    const aboveTop = buttonRect.top - rect.height - 8;
    const belowTop = buttonRect.bottom + 8;
    const top =
      aboveTop >= margin
        ? aboveTop
        : Math.min(window.innerHeight - rect.height - margin, Math.max(margin, belowTop));

    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  };

  const refreshGoal = (force = false) => {
    void loadSupportGoal({ force }).then((goal) => {
      renderGoal(goal);
      if (!popover.classList.contains('gv-hidden')) positionPopover();
    });
  };
  const startRefreshTimer = () => {
    if (refreshTimer !== null) return;
    refreshTimer = window.setInterval(() => refreshGoal(true), SUPPORT_GOAL_REFRESH_MS);
  };
  const stopRefreshTimer = () => {
    if (refreshTimer === null) return;
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  };

  const open = () => {
    if (closeTimer !== null) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
    }
    popover.classList.remove('gv-hidden');
    if (!loaded) {
      loaded = true;
      renderGoal(DEFAULT_SUPPORT_GOAL);
    }
    positionPopover();
    refreshGoal();
    startRefreshTimer();
  };
  const close = (force = false) => {
    if (closeTimer !== null) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
    }
    if (!force && (pinned || hoveringButton || hoveringPopover)) return;
    popover.classList.add('gv-hidden');
    stopRefreshTimer();
  };
  const scheduleClose = () => {
    if (closeTimer !== null) window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => close(), 180);
  };

  button.addEventListener('mouseenter', () => {
    hoveringButton = true;
    open();
  });
  button.addEventListener('mouseleave', () => {
    hoveringButton = false;
    scheduleClose();
  });
  popover.addEventListener('mouseenter', () => {
    hoveringPopover = true;
    open();
  });
  popover.addEventListener('mouseleave', () => {
    hoveringPopover = false;
    scheduleClose();
  });
  button.addEventListener('click', () => {
    pinned = !pinned;
    if (pinned) open();
    else if (!hoveringButton && !hoveringPopover) close(true);
    button.setAttribute('aria-expanded', String(pinned));
  });

  wrap.append(button, popover);
  return wrap;
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function collectAllTags(items: PromptItem[]): string[] {
  const set = new Set<string>();
  for (const it of items) for (const t of it.tags || []) set.add(String(t).toLowerCase());
  return Array.from(set).sort();
}

function copyText(text: string): Promise<void> {
  try {
    return navigator.clipboard.writeText(text);
  } catch {
    return new Promise<void>((resolve) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {}
      ta.remove();
      resolve();
    });
  }
}

function computeAnchoredPosition(
  trigger: HTMLElement,
  panel: HTMLElement,
): { top: number; left: number } {
  const rect = trigger.getBoundingClientRect();
  const vw = window.innerWidth;
  const pad = 8;
  const panelW = Math.min(380, Math.max(300, panel.getBoundingClientRect().width || 320));
  const tentativeLeft = Math.min(vw - panelW - pad, Math.max(pad, rect.left + rect.width - panelW));
  const top = Math.max(pad, rect.top - (panel.getBoundingClientRect().height || 360) - 10);
  return { top, left: Math.round(tentativeLeft) };
}

export async function startPromptManager(): Promise<{ destroy: () => void }> {
  let marked!: typeof MarkedFn;
  try {
    // Check if the prompt manager should be hidden.
    let pmHiddenByUser = false;
    let promptInsertOnClick = false;

    try {
      const result = await browser.storage.sync.get({ gvHidePromptManager: false });
      pmHiddenByUser = result?.gvHidePromptManager === true;
    } catch (error) {
      pmLogger.warn(
        'Failed to check hide prompt manager setting, continuing with default behavior',
        { error },
      );
    }

    try {
      const result = await browser.storage.sync.get({
        [StorageKeys.PROMPT_INSERT_ON_CLICK]: false,
      });
      promptInsertOnClick = result?.[StorageKeys.PROMPT_INSERT_ON_CLICK] === true;
    } catch (error) {
      pmLogger.warn('Failed to check prompt click mode setting, falling back to copy behavior', {
        error,
      });
    }

    if (pmHiddenByUser) {
      pmLogger.info('Prompt Manager is hidden by user settings');
      return { destroy: () => {} };
    }

    // Monkey patch console.warn to suppress KaTeX quirks mode warning in content script
    const originalWarn = console.warn;
    console.warn = function (...args) {
      const message = args[0];
      if (
        typeof message === 'string' &&
        (message.includes("KaTeX doesn't work in quirks mode") ||
          message.includes('unicodeTextInMathMode') ||
          message.includes('LaTeX-incompatible input and strict mode'))
      ) {
        return;
      }
      return originalWarn.apply(console, args);
    };

    // Migrate data from localStorage to chrome.storage.local (one-time migration)
    try {
      const keysToMigrate = [
        STORAGE_KEYS.items,
        STORAGE_KEYS.locked,
        STORAGE_KEYS.position,
        STORAGE_KEYS.triggerPos,
      ];

      const migrationResult = await migrateFromLocalStorage(keysToMigrate, promptStorageService, {
        deleteAfterMigration: false, // Keep localStorage as backup
        skipExisting: true, // Skip if already migrated
      });

      if (migrationResult.migratedKeys.length > 0) {
        pmLogger.info('Migrated prompt data from localStorage to chrome.storage.local', {
          migratedKeys: migrationResult.migratedKeys,
        });
      }

      if (migrationResult.errors.length > 0) {
        pmLogger.warn('Some keys failed to migrate', { errors: migrationResult.errors });
      }
    } catch (migrationError) {
      pmLogger.error('Migration failed, continuing with current storage', { migrationError });
      // Continue even if migration fails - data will still work from current storage
    }

    // Dynamic imports to prevent side effects on unsupported pages
    // Dynamic imports to prevent side effects on unsupported pages
    marked = (await import('marked')).marked;
    const { default: markedKatex } = await import('marked-katex-extension');

    // markdown config: respect single newlines as <br> and KaTeX inline/display math
    try {
      marked.use(
        markedKatex({
          throwOnError: false,
          output: 'html',
          trust: true, // Trust the rendering environment (content script context)
          strict: false, // Disable strict mode checks including quirks mode detection
        }),
      );
      marked.setOptions({ breaks: true });
    } catch {}
    // Initialize centralized i18n system
    await initI18n();
    const i18n = createI18n();

    // Prevent duplicate injection
    if (document.getElementById(ID.trigger)) return { destroy: () => {} };

    // Trigger button
    const trigger = createEl('button', 'gv-pm-trigger');
    trigger.id = ID.trigger;
    trigger.setAttribute('aria-label', 'Prompt Manager');
    const img = document.createElement('img');
    img.width = 52;
    img.height = 52;
    img.alt = 'pm';
    img.src = getRuntimeUrl('icon-128.png');
    img.addEventListener(
      'error',
      () => {
        // dev fallback
        const devUrl = getRuntimeUrl('icon-128.png');
        if (img.src !== devUrl) img.src = devUrl;
      },
      { once: true },
    );
    trigger.appendChild(img);
    document.body.appendChild(trigger);
    // Helper: place trigger near a target element (e.g. ChatGPT FAB touch target)
    function placeTriggerNextToHost(): void {
      try {
        const candidates = Array.from(
          document.querySelectorAll('span.mat-mdc-button-touch-target'),
        ) as HTMLElement[];
        if (!candidates.length) return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const pick = candidates
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter((x) => x.r.width > 0 && x.r.height > 0)
          // choose the element closest to bottom-right corner
          .sort((a, b) => a.r.bottom + a.r.right - (b.r.bottom + b.r.right))
          .reduce((_, x) => x, undefined as { el: HTMLElement; r: DOMRect } | undefined);
        if (!pick) return;
        const r = pick.r;
        const th = trigger.getBoundingClientRect().height || 36;
        const gap = 10;
        const right = Math.max(6, Math.round(vw - r.left + gap));
        const bottom = Math.max(6, Math.round(vh - (r.top + r.height / 2 + th / 2)));
        trigger.style.right = `${right}px`;
        trigger.style.bottom = `${bottom}px`;
      } catch {}
    }

    // Helper: constrain trigger position to viewport bounds
    function constrainTriggerPosition(): void {
      try {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const rect = trigger.getBoundingClientRect();
        const tw = rect.width || 44;
        const th = rect.height || 44;
        const minPad = 6;

        // Parse current position
        const currentRight = parseFloat(trigger.style.right || '18') || 18;
        const currentBottom = parseFloat(trigger.style.bottom || '18') || 18;

        // Calculate constraints (ensure at least minPad from edges)
        const maxRight = vw - tw - minPad;
        const maxBottom = vh - th - minPad;

        // Constrain position
        const right = Math.max(minPad, Math.min(currentRight, maxRight));
        const bottom = Math.max(minPad, Math.min(currentBottom, maxBottom));

        trigger.style.right = `${Math.round(right)}px`;
        trigger.style.bottom = `${Math.round(bottom)}px`;
      } catch {}
    }

    // Restore trigger position if saved; otherwise place next to host button
    try {
      const pos = await readStorage<TriggerPosition | null>(STORAGE_KEYS.triggerPos, null);
      if (pos && Number.isFinite(pos.bottom) && Number.isFinite(pos.right)) {
        trigger.style.bottom = `${Math.max(6, Math.round(pos.bottom))}px`;
        trigger.style.right = `${Math.max(6, Math.round(pos.right))}px`;
        // Constrain position after restore to handle window resize/split screen
        requestAnimationFrame(constrainTriggerPosition);
      } else {
        // defer a bit to wait for host DOM
        placeTriggerNextToHost();
        requestAnimationFrame(placeTriggerNextToHost);
        window.setTimeout(placeTriggerNextToHost, 350);
      }
    } catch {
      placeTriggerNextToHost();
    }

    // Panel root
    const panel = createEl('div', 'gv-pm-panel gv-hidden');
    panel.id = ID.panel;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    document.body.appendChild(panel);

    // Build panel DOM
    const header = createEl('div', 'gv-pm-header');
    const dragHandle = createEl('div', 'gv-pm-drag');

    const titleRow = createEl('div', 'gv-pm-title-row');
    const title = createEl('div', 'gv-pm-title');
    const titleText = document.createElement('span');
    titleText.textContent = 'GPT-Voyager';
    title.appendChild(titleText);

    const manifestVersion = chrome?.runtime?.getManifest?.()?.version;
    const versionBadge = document.createElement('span');
    versionBadge.className = 'gv-pm-version';
    versionBadge.title = manifestVersion
      ? `${i18n.t('extensionVersion')} ${manifestVersion}`
      : i18n.t('extensionVersion');
    versionBadge.textContent = manifestVersion ?? '...';

    // Theme toggle
    const themeToggle = createEl('button', 'gv-pm-theme-toggle');
    themeToggle.setAttribute('type', 'button');
    let currentPMTheme: PMTheme = detectPageTheme();

    function applyPMTheme(theme: PMTheme) {
      currentPMTheme = theme;
      panel.setAttribute('data-gv-theme', theme);
      themeToggle.classList.toggle('gv-pm-theme-dark', theme === 'dark');
      themeToggle.innerHTML = getThemeIconSvg(theme);
      themeToggle.title = theme === 'dark' ? i18n.t('pm_theme_light') : i18n.t('pm_theme_dark');
      themeToggle.setAttribute('aria-label', themeToggle.title);
    }

    applyPMTheme(currentPMTheme);

    // Load saved theme preference
    (async () => {
      try {
        const result = await browser.storage.sync.get(STORAGE_KEYS.theme);
        const saved = result[STORAGE_KEYS.theme];
        if (saved === 'light' || saved === 'dark') {
          applyPMTheme(saved);
        }
      } catch {
        // Ignore and keep detected theme.
      }
    })();

    themeToggle.addEventListener('click', async () => {
      const newTheme: PMTheme = currentPMTheme === 'dark' ? 'light' : 'dark';
      // Enable smooth color transition on all panel children
      panel.classList.add('gv-pm-transitioning');
      applyPMTheme(newTheme);
      setTimeout(() => panel.classList.remove('gv-pm-transitioning'), 450);
      try {
        await browser.storage.sync.set({ [STORAGE_KEYS.theme]: newTheme });
      } catch {
        try {
          await browser.storage.local.set({ [STORAGE_KEYS.theme]: newTheme });
        } catch {
          // Ignore
        }
      }
    });

    titleRow.appendChild(title);
    titleRow.appendChild(themeToggle);
    titleRow.appendChild(versionBadge);
    const controls = createEl('div', 'gv-pm-controls');

    const langSel = createEl('select', 'gv-pm-lang');
    for (const lang of APP_LANGUAGES) {
      const opt = createEl('option');
      opt.value = lang;
      opt.textContent = APP_LANGUAGE_LABELS[lang];
      langSel.appendChild(opt);
    }
    // Set initial language value asynchronously
    i18n
      .get()
      .then((lang) => {
        langSel.value = lang;
      })
      .catch(() => {
        langSel.value = 'en';
      });

    const lockBtn = createEl('button', 'gv-pm-lock');
    lockBtn.setAttribute('aria-pressed', 'false');
    lockBtn.setAttribute('data-icon', '🔓');
    lockBtn.title = i18n.t('pm_lock');

    const addBtn = createEl('button', 'gv-pm-add');
    addBtn.textContent = i18n.t('pm_add');

    const viewModeBtn = createEl('button', 'gv-pm-view-mode');
    viewModeBtn.setAttribute('type', 'button');
    // Title, aria-label, and data-icon are set in applyViewModeUI() below.

    controls.appendChild(langSel);
    controls.appendChild(addBtn);
    controls.appendChild(lockBtn);
    header.appendChild(dragHandle);
    header.appendChild(titleRow);
    header.appendChild(controls);

    // Search wrap hosts the search input and, on its right edge, the
    // compact/comfortable view-mode toggle. Keeping the toggle here instead of
    // the header controls row prevents the "Voyager" title from being squeezed
    // into ellipsis, and keeps it adjacent to the list it governs.
    const searchWrap = createEl('div', 'gv-pm-search');
    const searchInput = createEl('input') as HTMLInputElement;
    searchInput.type = 'search';
    searchInput.placeholder = i18n.t('pm_search_placeholder');
    searchWrap.appendChild(searchInput);
    searchWrap.appendChild(viewModeBtn);

    const tagsWrapOuter = createEl('div', 'gv-pm-tags-wrap');
    const tagsWrap = createEl('div', 'gv-pm-tags');
    const tagsScrollHint = createEl('div', 'gv-pm-tags-scroll-hint');
    tagsScrollHint.setAttribute('aria-hidden', 'true');
    tagsScrollHint.textContent = '>';
    tagsWrapOuter.appendChild(tagsWrap);
    tagsWrapOuter.appendChild(tagsScrollHint);

    const list = createEl('div', 'gv-pm-list');

    const footer = createEl('div', 'gv-pm-footer');
    const importInput = createEl('input') as HTMLInputElement;
    importInput.type = 'file';
    importInput.accept = '.json,application/json';
    importInput.className = 'gv-pm-import-input';

    // Backup button - primary action
    const backupBtn = createEl('button', 'gv-pm-backup-btn');
    backupBtn.textContent = i18n.t('pm_backup');
    backupBtn.title = i18n.t('pm_backup_tooltip');

    // Primary actions container
    const primaryActions = createEl('div', 'gv-pm-footer-actions');
    primaryActions.appendChild(backupBtn);

    // Secondary actions container
    const secondaryActions = createEl('div', 'gv-pm-footer-secondary');

    const importBtn = createEl('button', 'gv-pm-import-btn');
    importBtn.textContent = i18n.t('pm_import');

    const exportBtn = createEl('button', 'gv-pm-export-btn');
    exportBtn.textContent = i18n.t('pm_export');

    const settingsBtn = createEl('button', 'gv-pm-settings');
    settingsBtn.textContent = i18n.t('pm_settings');
    settingsBtn.title = i18n.t('pm_settings_tooltip');

    const projectLink = createEl('a', 'gv-pm-project-link');
    projectLink.href = PROJECT_REPOSITORY_URL;
    projectLink.target = '_blank';
    projectLink.rel = 'noopener noreferrer';
    projectLink.title = i18n.t('starProject');
    projectLink.setAttribute('aria-label', i18n.t('starProject'));
    projectLink.textContent = i18n.t('starProject');

    const supportPanel = createSupportPanel(i18n);

    secondaryActions.appendChild(importBtn);
    secondaryActions.appendChild(exportBtn);
    secondaryActions.appendChild(settingsBtn);

    const supportActions = createEl('div', 'gv-pm-footer-support');
    supportActions.appendChild(projectLink);
    supportActions.appendChild(supportPanel);

    footer.appendChild(primaryActions);
    footer.appendChild(secondaryActions);
    footer.appendChild(supportActions);
    footer.appendChild(importInput);

    const addForm = elFromHTML(
      `<form class="gv-pm-add-form gv-hidden">
        <input class="gv-pm-input-name" type="text" maxlength="60" placeholder="${escapeHtml(
          i18n.t('pm_name_placeholder') || 'Name (optional)',
        )}" />
        <textarea class="gv-pm-input-text" placeholder="${escapeHtml(
          i18n.t('pm_prompt_placeholder') || 'Prompt text',
        )}" rows="3"></textarea>
        <input class="gv-pm-input-tags" type="text" placeholder="${escapeHtml(
          i18n.t('pm_tags_placeholder') || 'Tags (comma separated)',
        )}" />
        <div class="gv-pm-add-actions">
          <span class="gv-pm-inline-hint" aria-live="polite"></span>
          <button type="submit" class="gv-pm-save">${escapeHtml(i18n.t('pm_save') || 'Save')}</button>
          <button type="button" class="gv-pm-cancel">${escapeHtml(
            i18n.t('pm_cancel') || 'Cancel',
          )}</button>
        </div>
      </form>`,
    );

    // Notice as floating toast (not in footer layout)
    const notice = createEl('div', 'gv-pm-notice');

    panel.appendChild(header);
    panel.appendChild(searchWrap);
    panel.appendChild(tagsWrapOuter);
    panel.appendChild(addForm);
    panel.appendChild(list);
    panel.appendChild(footer);
    panel.appendChild(notice);

    // State
    let items: PromptItem[] = await readStorage<PromptItem[]>(STORAGE_KEYS.items, []);
    let open = false;
    let selectedTags: Set<string> = new Set<string>();
    let locked = !!(await readStorage<boolean>(STORAGE_KEYS.locked, false));
    let savedPos = await readStorage<PanelPosition | null>(STORAGE_KEYS.position, null);
    let dragging = false;
    let dragOffset = { x: 0, y: 0 };
    let draggingTrigger = false;
    let editingId: string | null = null;
    let expandedItems: Set<string> = new Set<string>(); // Track expanded prompt items
    let viewMode: PMViewMode = 'compact';

    function setNotice(text: string, kind: 'ok' | 'err' = 'ok') {
      notice.textContent = text || '';
      notice.classList.toggle('ok', kind === 'ok');
      notice.classList.toggle('err', kind === 'err');
      if (text) {
        window.setTimeout(() => {
          if (notice.textContent === text) notice.textContent = '';
        }, 1800);
      }
    }

    function setInlineHint(text: string, kind: 'ok' | 'err' = 'err'): void {
      const hint = addForm.querySelector('.gv-pm-inline-hint') as HTMLSpanElement | null;
      if (!hint) return;
      hint.textContent = text || '';
      hint.classList.toggle('ok', kind === 'ok');
      hint.classList.toggle('err', kind === 'err');
    }

    function syncTagScrollHint(): void {
      const { isOverflowing, showHint } = getScrollHintState(
        tagsWrap.scrollTop,
        tagsWrap.clientHeight,
        tagsWrap.scrollHeight,
      );
      tagsWrapOuter.classList.toggle('gv-pm-tags-scrollable', isOverflowing);
      tagsWrapOuter.classList.toggle('gv-pm-tags-scroll-end', !showHint);
    }

    /* Fast, interactive hover tooltip for compact rows.
     *
     * Opens ~250 ms after mouseenter. Closes ~150 ms after mouseleave 鈥?long
     * enough for the user to cross the gap onto the tooltip itself, where
     * they can read the full prompt and scroll long content. Entering the
     * tooltip cancels any pending hide; leaving the tooltip schedules one.
     * A singleton element is reused across rows. */
    const TOOLTIP_OPEN_DELAY_MS = 250;
    const TOOLTIP_HIDE_GRACE_MS = 150;
    let tooltipEl: HTMLDivElement | null = null;
    let tooltipOpenTimer: number | null = null;
    let tooltipHideTimer: number | null = null;
    let tooltipTargetHovered = false;
    let tooltipSelfHovered = false;

    function clearOpenTimer(): void {
      if (tooltipOpenTimer !== null) {
        window.clearTimeout(tooltipOpenTimer);
        tooltipOpenTimer = null;
      }
    }

    function clearHideTimer(): void {
      if (tooltipHideTimer !== null) {
        window.clearTimeout(tooltipHideTimer);
        tooltipHideTimer = null;
      }
    }

    function actuallyHideTooltip(): void {
      clearOpenTimer();
      clearHideTimer();
      tooltipTargetHovered = false;
      tooltipSelfHovered = false;
      if (tooltipEl) {
        tooltipEl.classList.remove('gv-pm-tooltip-visible');
      }
    }

    // External callers (closePanel, destroy, scroll listeners) want a hard
    // dismiss; row/tooltip mouse handlers use scheduleHide with grace.
    const hideTooltip = actuallyHideTooltip;

    function scheduleHide(): void {
      clearHideTimer();
      tooltipHideTimer = window.setTimeout(() => {
        tooltipHideTimer = null;
        if (!tooltipSelfHovered && !tooltipTargetHovered) {
          actuallyHideTooltip();
        }
      }, TOOLTIP_HIDE_GRACE_MS);
    }

    function ensureTooltipEl(): HTMLDivElement {
      if (tooltipEl) return tooltipEl;
      const el = document.createElement('div');
      el.className = 'gv-pm-tooltip';
      el.setAttribute('role', 'tooltip');
      // Entering the tooltip cancels any pending hide; leaving schedules it.
      // This is what lets the user glide from row 鈫?gap 鈫?tooltip and scroll.
      el.addEventListener('mouseenter', () => {
        tooltipSelfHovered = true;
        clearHideTimer();
      });
      el.addEventListener('mouseleave', () => {
        tooltipSelfHovered = false;
        scheduleHide();
      });
      document.body.appendChild(el);
      tooltipEl = el;
      return el;
    }

    function showTooltip(target: HTMLElement, fullText: string): void {
      const el = ensureTooltipEl();
      // Reset scroll so each open starts at the top of the content.
      el.scrollTop = 0;
      el.textContent = fullText;
      el.setAttribute('data-gv-theme', panel.getAttribute('data-gv-theme') || '');

      // Position: prefer above the target, fall back to below if clipped.
      // Measurement requires the element to be laid out, so reveal first then
      // adjust; CSS keeps it invisible until the `-visible` class is applied.
      el.style.left = '0px';
      el.style.top = '0px';
      el.style.visibility = 'hidden';
      el.classList.add('gv-pm-tooltip-visible');
      const targetRect = target.getBoundingClientRect();
      const tipRect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pad = 8;

      let left = targetRect.left;
      if (left + tipRect.width > vw - pad) left = vw - pad - tipRect.width;
      if (left < pad) left = pad;

      let top = targetRect.top - tipRect.height - 6;
      if (top < pad) {
        top = targetRect.bottom + 6;
        if (top + tipRect.height > vh - pad) top = Math.max(pad, vh - pad - tipRect.height);
      }

      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
      el.style.visibility = '';
    }

    function attachPromptTooltip(target: HTMLElement, fullText: string, _host: HTMLElement): void {
      target.addEventListener('mouseenter', () => {
        tooltipTargetHovered = true;
        clearHideTimer();
        clearOpenTimer();
        tooltipOpenTimer = window.setTimeout(() => {
          tooltipOpenTimer = null;
          if (tooltipTargetHovered) showTooltip(target, fullText);
        }, TOOLTIP_OPEN_DELAY_MS);
      });
      target.addEventListener('mouseleave', () => {
        tooltipTargetHovered = false;
        // Cancel a pending open (user left before it showed) 鈥?otherwise give
        // them the grace window to cross onto the tooltip.
        if (tooltipOpenTimer !== null) {
          clearOpenTimer();
          actuallyHideTooltip();
          return;
        }
        scheduleHide();
      });
      // A click/press activates the prompt; dismiss the hover preview immediately.
      target.addEventListener('mousedown', actuallyHideTooltip);
    }

    // Dismiss on scroll or panel-wide events so the tooltip never ends up
    // orphaned when the list scrolls under it. Exception: scrolling *inside*
    // the tooltip itself (long prompts now paginate within max-height) must
    // keep it open 鈥?otherwise the interactive preview is useless.
    const tooltipScrollTargets: Array<HTMLElement | Window> = [list, window];
    const onTooltipDismiss = (ev: Event) => {
      const t = ev.target as Node | null;
      if (tooltipEl && t && (t === tooltipEl || tooltipEl.contains(t))) return;
      actuallyHideTooltip();
    };
    for (const target of tooltipScrollTargets) {
      target.addEventListener('scroll', onTooltipDismiss, { passive: true, capture: true });
    }

    function applyViewModeUI(): void {
      panel.setAttribute('data-gv-view', viewMode);
      const isCompact = viewMode === 'compact';
      viewModeBtn.classList.toggle('gv-pm-view-mode-compact', isCompact);
      viewModeBtn.setAttribute('data-icon', isCompact ? '\u2630' : '\u25a6');
      // Tooltip describes the action the click will perform, not the current state.
      const nextTip = isCompact
        ? i18n.t('pm_view_comfortable') || 'Switch to comfortable view'
        : i18n.t('pm_view_compact') || 'Switch to compact list';
      viewModeBtn.title = nextTip;
      viewModeBtn.setAttribute('aria-label', nextTip);
      viewModeBtn.setAttribute('aria-pressed', isCompact ? 'true' : 'false');
    }

    applyViewModeUI();

    // Load saved view mode preference. Prefer sync (follows theme pattern),
    // but fall back to local 鈥?keeps symmetry with the write path, which
    // writes to local when sync is unavailable (Safari, sync-disabled
    // profiles). Without this fallback, those environments lose the user's
    // choice on every reload.
    (async () => {
      let saved: unknown = null;
      try {
        const result = await browser.storage.sync.get(StorageKeys.PROMPT_VIEW_MODE);
        saved = result[StorageKeys.PROMPT_VIEW_MODE];
      } catch {
        // Fall through to local
      }
      if (saved !== 'compact' && saved !== 'comfortable') {
        try {
          const result = await browser.storage.local.get(StorageKeys.PROMPT_VIEW_MODE);
          saved = result[StorageKeys.PROMPT_VIEW_MODE];
        } catch {
          // Keep default on failure
        }
      }
      if (saved === 'compact' || saved === 'comfortable') {
        viewMode = saved;
        applyViewModeUI();
        renderList();
      }
    })();

    viewModeBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      viewMode = viewMode === 'compact' ? 'comfortable' : 'compact';
      applyViewModeUI();
      renderList();
      try {
        await browser.storage.sync.set({ [StorageKeys.PROMPT_VIEW_MODE]: viewMode });
      } catch {
        try {
          await browser.storage.local.set({ [StorageKeys.PROMPT_VIEW_MODE]: viewMode });
        } catch {
          // Ignore persistence failures; UI state still updates.
        }
      }
      try {
        (ev.currentTarget as HTMLButtonElement)?.blur?.();
      } catch {}
    });

    function renderTags(): void {
      const all = collectAllTags(items);
      tagsWrap.innerHTML = '';
      const allBtn = createEl('button', 'gv-pm-tag');
      allBtn.textContent = i18n.t('pm_all_tags') || 'All';
      allBtn.classList.toggle('active', selectedTags.size === 0);
      allBtn.addEventListener('click', () => {
        selectedTags = new Set();
        renderTags();
        renderList();
      });
      tagsWrap.appendChild(allBtn);
      for (const tag of all) {
        const btn = createEl('button', 'gv-pm-tag');
        btn.textContent = tag;
        btn.classList.toggle('active', selectedTags.has(tag));
        btn.addEventListener('click', () => {
          if (selectedTags.has(tag)) selectedTags.delete(tag);
          else selectedTags.add(tag);
          renderTags();
          renderList();
        });
        tagsWrap.appendChild(btn);
      }
      requestAnimationFrame(syncTagScrollHint);
    }

    function renderList(): void {
      // Rebuilding the list destroys every row's DOM. Any pending hover-open
      // timer would fire against a detached target (getBoundingClientRect()
      // returns zeros 鈫?tooltip mispositioned) and any visible tooltip would
      // display stale content. Close it up front so every re-render starts
      // from a clean state.
      hideTooltip();

      // Preserve the user's scroll position across the wipe-and-rebuild.
      // Without this, actions like expand/collapse, search, tag filter,
      // view-mode toggle, and cloud-sync updates all snap the list back to
      // the top 鈥?most painful on the expand button, which fires a re-render
      // right as the user is reading further down the list.
      const savedScrollTop = list.scrollTop;

      const q = (searchInput.value || '').trim().toLowerCase();
      const selectedTagList = Array.from(selectedTags);
      const filtered = items.filter((it) => {
        const okTag =
          selectedTagList.length === 0 || selectedTagList.every((t) => it.tags.includes(t));
        if (!okTag) return false;
        if (!q) return true;
        // Include the user-authored name so searching for the label shown in
        // compact mode always finds the prompt even when the Markdown body
        // doesn't contain that string.
        return (
          it.text.toLowerCase().includes(q) ||
          it.tags.some((t) => t.includes(q)) ||
          (it.name ? it.name.toLowerCase().includes(q) : false)
        );
      });
      list.innerHTML = '';
      if (filtered.length === 0) {
        const empty = createEl('div', 'gv-pm-empty');
        empty.textContent = i18n.t('pm_empty') || 'No prompts yet';
        list.appendChild(empty);
        // Nothing to scroll back to; avoid setting scrollTop on an empty list.
        return;
      }
      const frag = document.createDocumentFragment();
      for (const it of filtered) {
        const row = createEl('div', 'gv-pm-item');

        // Create text container with expand/collapse functionality
        const textContainer = createEl('div', 'gv-pm-item-text-container');
        const textBtn = createEl('button', 'gv-pm-item-text');

        // Compact mode collapses each prompt to a single-line plaintext title
        // to maximize density; expanding promotes the row back to the rich
        // Markdown preview used in comfortable mode.
        const isExpanded = expandedItems.has(it.id);
        const compactCollapsed = viewMode === 'compact' && !isExpanded;
        if (compactCollapsed) {
          row.classList.add('gv-pm-item-compact');
        }

        // Render Markdown + KaTeX preview (sanitized)
        const md = document.createElement('div');
        md.className = 'gv-md';

        if (compactCollapsed) {
          md.classList.add('gv-pm-compact-title');
          // User-authored `name` takes precedence so prompts can be labeled
          // independently of their Markdown body.
          md.textContent = (it.name && it.name.trim()) || extractPlainTitle(it.text);
          // Attach a lightweight, fast-opening hover tooltip for peek.
          attachPromptTooltip(textBtn, it.text, panel);
        } else {
          // Apply collapsed class if not expanded (comfortable mode: 5-line clamp)
          if (!isExpanded) {
            md.classList.add('gv-md-collapsed');
          }
        }

        // Insert element into DOM first, then render to ensure KaTeX can detect document mode correctly
        textBtn.appendChild(md);

        if (!compactCollapsed) {
          // Defer rendering to next frame to ensure element is fully attached
          requestAnimationFrame(() => {
            try {
              const out = marked.parse(it.text as string);
              if (typeof out === 'string') {
                md.innerHTML = DOMPurify.sanitize(out);
              } else {
                out
                  .then((html: string) => {
                    md.innerHTML = DOMPurify.sanitize(html);
                  })
                  .catch(() => {
                    md.textContent = it.text;
                  });
              }
            } catch {
              md.textContent = it.text;
            }
          });
        }

        textBtn.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          void activatePromptText(it.text, promptInsertOnClick, {
            copyText,
            expandInputCollapseIfNeeded,
            insertTextIntoChatInput,
          }).then((result) => {
            setNotice(
              result === 'inserted'
                ? i18n.t('pm_inserted') || 'Inserted'
                : i18n.t('pm_copied') || 'Copied',
              'ok',
            );
          });
        });
        textBtn.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          void activatePromptText(it.text, promptInsertOnClick, {
            copyText,
            expandInputCollapseIfNeeded,
            insertTextIntoChatInput,
          }).then((result) => {
            setNotice(
              result === 'inserted'
                ? i18n.t('pm_inserted') || 'Inserted'
                : i18n.t('pm_copied') || 'Copied',
              'ok',
            );
          });
        });

        // Add expand/collapse button
        const expandBtn = createEl('button', 'gv-pm-expand-btn');
        expandBtn.innerHTML = isExpanded ? '-' : '+';
        expandBtn.title = isExpanded
          ? i18n.t('pm_collapse') || 'Collapse'
          : i18n.t('pm_expand') || 'Expand';
        expandBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (expandedItems.has(it.id)) {
            expandedItems.delete(it.id);
          } else {
            expandedItems.add(it.id);
          }
          renderList();
        });

        textContainer.appendChild(textBtn);
        // In compact mode the expand button is moved into the right-side
        // actions cluster (see below) so all right-aligned controls form a
        // single group and can't overlap each other. In comfortable mode
        // it stays inline with the text for progressive disclosure.
        if (!compactCollapsed) {
          textContainer.appendChild(expandBtn);
        }

        // Edit button
        const editBtn = createEl('button', 'gv-pm-edit');
        editBtn.setAttribute('aria-label', i18n.t('pm_edit') || 'Edit');
        editBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          // Start inline edit using the add form fields
          (addForm.querySelector('.gv-pm-input-name') as HTMLInputElement).value = it.name ?? '';
          (addForm.querySelector('.gv-pm-input-text') as HTMLTextAreaElement).value = it.text;
          (addForm.querySelector('.gv-pm-input-tags') as HTMLInputElement).value = (
            it.tags || []
          ).join(', ');
          addForm.classList.remove('gv-hidden');
          (addForm.querySelector('.gv-pm-input-name') as HTMLInputElement).focus();
          editingId = it.id;
        });
        const bottom = createEl('div', 'gv-pm-bottom');
        const meta = createEl('div', 'gv-pm-item-meta');
        for (const t of it.tags) {
          const chip = createEl('span', 'gv-pm-chip');
          chip.textContent = t;
          chip.addEventListener('click', () => {
            if (selectedTags.has(t)) selectedTags.delete(t);
            else selectedTags.add(t);
            renderTags();
            renderList();
          });
          meta.appendChild(chip);
        }
        // Actions container at row bottom-right
        const actions = createEl('div', 'gv-pm-actions');
        const del = createEl('button', 'gv-pm-del');
        del.title = i18n.t('pm_delete') || 'Delete';
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          // inline confirm popover (floating)
          if (document.body.querySelector('.gv-pm-confirm')) return; // one at a time
          const pop = document.createElement('div');
          pop.className = 'gv-pm-confirm';
          const msg = document.createElement('span');
          msg.textContent = i18n.t('pm_delete_confirm') || 'Delete this prompt?';
          const yes = document.createElement('button');
          yes.className = 'gv-pm-confirm-yes';
          yes.textContent = i18n.t('pm_delete') || 'Delete';
          const no = document.createElement('button');
          no.textContent = i18n.t('pm_cancel') || 'Cancel';
          pop.appendChild(msg);
          pop.appendChild(yes);
          pop.appendChild(no);
          document.body.appendChild(pop);
          // position near button
          const r = del.getBoundingClientRect();
          const vw = window.innerWidth;
          const side: 'left' | 'right' = r.right + 220 > vw ? 'left' : 'right';
          const top = Math.max(8, r.top + window.scrollY - 6);
          const left =
            side === 'right'
              ? r.right + window.scrollX + 10
              : r.left + window.scrollX - pop.offsetWidth - 10;
          pop.style.top = `${Math.round(top)}px`;
          pop.style.left = `${Math.round(Math.max(8, left))}px`;
          pop.setAttribute('data-side', side);
          const cleanup = () => {
            try {
              pop.remove();
            } catch {}
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('click', onOutside, true);
          };
          const onOutside = (ev: MouseEvent) => {
            const t = ev.target as HTMLElement;
            if (!t.closest('.gv-pm-confirm')) cleanup();
          };
          const onKey = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape') cleanup();
          };
          window.addEventListener('click', onOutside, true);
          window.addEventListener('keydown', onKey, { passive: true });
          no.addEventListener('click', (ev) => {
            ev.stopPropagation();
            cleanup();
          });
          yes.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            items = items.filter((x) => x.id !== it.id);
            await writeStorage(STORAGE_KEYS.items, items);
            cleanup();
            renderTags();
            renderList();
            setNotice(i18n.t('pm_deleted') || 'Deleted', 'ok');
          });
        });

        // Append text container instead of textBtn
        row.appendChild(textContainer);

        // In compact mode, expand sits at the left of edit/del so the cluster
        // In compact mode, actions stay grouped on the right without overlap.
        if (compactCollapsed) {
          actions.appendChild(expandBtn);
        }
        actions.appendChild(editBtn);
        actions.appendChild(del);
        bottom.appendChild(meta);
        bottom.appendChild(actions);
        row.appendChild(bottom);
        frag.appendChild(row);
      }
      list.appendChild(frag);
      // Restore scroll position after the DOM is laid out. Clamped to the
      // new scrollHeight so a re-filter that shrinks the list doesn't leave
      // us at an impossible offset.
      const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight);
      list.scrollTop = Math.min(savedScrollTop, maxScroll);
      // KaTeX rendered during Markdown step, no post-typeset needed
    }

    function openPanel(): void {
      open = true;
      panel.classList.remove('gv-hidden');
      if (locked && savedPos) {
        // Clamp the saved position to the current viewport. Without this, a
        // panel pinned on a wider screen renders past the edge after the user
        // narrows the window 鈥?and since dragging/the unlock button are gated
        // on `!locked`, the user gets stuck. See #635.
        const pad = 8;
        const rect = panel.getBoundingClientRect();
        const panelW = rect.width || 320;
        const panelH = rect.height || 360;
        const left = Math.max(pad, Math.min(savedPos.left, window.innerWidth - panelW - pad));
        const top = Math.max(pad, Math.min(savedPos.top, window.innerHeight - panelH - pad));
        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(top)}px`;
      } else {
        // measure after making visible
        const pos = computeAnchoredPosition(trigger, panel);
        panel.style.left = `${pos.left}px`;
        panel.style.top = `${pos.top}px`;
      }
      requestAnimationFrame(syncTagScrollHint);
    }

    function closePanel(): void {
      open = false;
      panel.classList.add('gv-hidden');
      hideTooltip();
    }

    function applyLockUI(): void {
      lockBtn.classList.toggle('active', locked);
      lockBtn.setAttribute('aria-pressed', locked ? 'true' : 'false');
      lockBtn.setAttribute('data-icon', locked ? '🔒' : '🔓');
      lockBtn.title = locked ? i18n.t('pm_unlock') || 'Unlock' : i18n.t('pm_lock') || 'Lock';
      panel.classList.toggle('gv-locked', locked);
    }

    function refreshUITexts(): void {
      // Keep custom icon + label
      titleText.textContent = 'GPT-Voyager';
      addBtn.textContent = i18n.t('pm_add');
      searchInput.placeholder = i18n.t('pm_search_placeholder');
      importBtn.textContent = i18n.t('pm_import');
      exportBtn.textContent = i18n.t('pm_export');
      backupBtn.textContent = i18n.t('pm_backup');
      backupBtn.title = i18n.t('pm_backup_tooltip');
      void i18n.get();

      settingsBtn.textContent = i18n.t('pm_settings');
      settingsBtn.title = i18n.t('pm_settings_tooltip');
      projectLink.textContent = i18n.t('starProject');
      projectLink.title = i18n.t('starProject');
      projectLink.setAttribute('aria-label', i18n.t('starProject'));
      const supportButton = supportPanel.querySelector('.gv-pm-support-btn');
      if (supportButton) {
        supportButton.textContent = '?';
        supportButton.setAttribute('title', i18n.t('supportMysteryButton'));
        supportButton.setAttribute('aria-label', i18n.t('supportMysteryButton'));
      }
      supportPanel.dispatchEvent(
        new CustomEvent<AppLanguage>('gv-pm-language-change', {
          detail: normalizeLanguage(langSel.value),
        }),
      );
      const supportPopover = supportPanel.querySelector('.gv-pm-support-popover');
      if (supportPopover) supportPopover.setAttribute('aria-label', i18n.t('supportMysteryButton'));
      (addForm.querySelector('.gv-pm-input-name') as HTMLInputElement).placeholder =
        i18n.t('pm_name_placeholder');
      (addForm.querySelector('.gv-pm-input-text') as HTMLTextAreaElement).placeholder =
        i18n.t('pm_prompt_placeholder');
      (addForm.querySelector('.gv-pm-input-tags') as HTMLInputElement).placeholder =
        i18n.t('pm_tags_placeholder');
      (addForm.querySelector('.gv-pm-save') as HTMLButtonElement).textContent = i18n.t('pm_save');
      (addForm.querySelector('.gv-pm-cancel') as HTMLButtonElement).textContent =
        i18n.t('pm_cancel');
      applyLockUI();
      applyViewModeUI();
      renderTags();
      renderList();
    }

    function onReposition(): void {
      if (!open) return;
      if (locked) {
        // Don't re-anchor when locked, but do keep the panel inside the viewport
        // so a window resize can't strand the unlock button off-screen (#635).
        const pad = 8;
        const rect = panel.getBoundingClientRect();
        const left = Math.max(pad, Math.min(rect.left, window.innerWidth - rect.width - pad));
        const top = Math.max(pad, Math.min(rect.top, window.innerHeight - rect.height - pad));
        if (left !== rect.left || top !== rect.top) {
          panel.style.left = `${Math.round(left)}px`;
          panel.style.top = `${Math.round(top)}px`;
        }
        return;
      }
      const pos = computeAnchoredPosition(trigger, panel);
      panel.style.left = `${pos.left}px`;
      panel.style.top = `${pos.top}px`;
    }

    function beginDrag(ev: PointerEvent): void {
      if (locked) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      dragOffset = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      try {
        panel.setPointerCapture?.(ev.pointerId);
      } catch {}
    }

    async function endDrag(_ev: PointerEvent): Promise<void> {
      if (!dragging) return;
      dragging = false;
      const rect = panel.getBoundingClientRect();
      savedPos = { left: rect.left, top: rect.top };
      await writeStorage(STORAGE_KEYS.position, savedPos);
    }

    function onDragMove(ev: PointerEvent): void {
      if (dragging) {
        const x = ev.clientX - dragOffset.x;
        const y = ev.clientY - dragOffset.y;
        panel.style.left = `${Math.round(x)}px`;
        panel.style.top = `${Math.round(y)}px`;
      } else if (draggingTrigger) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const rect = trigger.getBoundingClientRect();
        const w = rect.width || 36;
        const h = rect.height || 36;
        const right = Math.max(6, Math.min(vw - 6 - w, vw - ev.clientX - w / 2));
        const bottom = Math.max(6, Math.min(vh - 6 - h, vh - ev.clientY - h / 2));
        trigger.style.right = `${Math.round(right)}px`;
        trigger.style.bottom = `${Math.round(bottom)}px`;
      }
    }

    // Events
    trigger.addEventListener('click', async () => {
      // Suppress click after a drag gesture
      if (triggerWasDragged) {
        triggerWasDragged = false;
        return;
      }

      if (open) closePanel();
      else {
        openPanel();
        renderTags();
        renderList();
      }
    });

    // Handle window resize - constrain trigger and reposition panel
    // Handle window resize - constrain trigger and reposition panel
    const onWindowResize = () => {
      constrainTriggerPosition();
      onReposition();
      syncTagScrollHint();
    };
    window.addEventListener('resize', onWindowResize, { passive: true });

    window.addEventListener('scroll', onReposition, { passive: true });
    tagsWrap.addEventListener('scroll', syncTagScrollHint, { passive: true });

    // Close when clicking outside of the manager (panel/trigger/confirm are exceptions)
    const onWindowPointerDown = (ev: PointerEvent) => {
      if (!open) return;
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(`#${ID.panel}`)) return;
      if (target.closest(`#${ID.trigger}`)) return;
      if (target.closest('.gv-pm-confirm')) return;
      // The hover-preview tooltip lives on document.body so users can
      // interact with it (scroll long prompts, select text). Without this
      // exclusion, clicking its scrollbar would be treated as an outside
      // click and close the whole panel.
      if (target.closest('.gv-pm-tooltip')) return;
      closePanel();
    };
    window.addEventListener('pointerdown', onWindowPointerDown, { capture: true });

    // Close on Escape
    const onWindowKeyDown = (ev: KeyboardEvent) => {
      if (!open) return;
      if (ev.key === 'Escape') closePanel();
    };
    window.addEventListener('keydown', onWindowKeyDown, { passive: true });

    lockBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      locked = !locked;
      await writeStorage(STORAGE_KEYS.locked, locked);
      applyLockUI();
      try {
        (ev.currentTarget as HTMLButtonElement)?.blur?.();
      } catch {}
      if (locked) {
        const rect = panel.getBoundingClientRect();
        savedPos = { left: rect.left, top: rect.top };
        await writeStorage(STORAGE_KEYS.position, savedPos);
      } else {
        onReposition();
      }
    });
    panel.addEventListener('pointerdown', (ev: PointerEvent) => {
      const target = ev.target as HTMLElement;
      if (target.closest('.gv-pm-drag')) beginDrag(ev);
    });
    window.addEventListener('pointermove', onDragMove, { passive: true });
    window.addEventListener('pointerup', endDrag, { passive: true });

    // Trigger drag (always draggable)
    let triggerDragStartPos: { x: number; y: number } | null = null;
    let triggerWasDragged = false;
    trigger.addEventListener('pointerdown', (ev: PointerEvent) => {
      if (typeof ev.button === 'number' && ev.button !== 0) return;
      draggingTrigger = true;
      triggerWasDragged = false;
      triggerDragStartPos = { x: ev.clientX, y: ev.clientY };
      try {
        trigger.setPointerCapture?.(ev.pointerId);
      } catch {}
    });

    const onTriggerDragEnd = async (ev: PointerEvent) => {
      if (draggingTrigger) {
        draggingTrigger = false;
        // Only save if the trigger actually moved (threshold: 5px)
        if (triggerDragStartPos) {
          const dx = Math.abs(ev.clientX - triggerDragStartPos.x);
          const dy = Math.abs(ev.clientY - triggerDragStartPos.y);
          if (dx > 5 || dy > 5) {
            triggerWasDragged = true;
            const r = parseFloat((trigger.style.right || '').replace('px', '')) || 18;
            const b = parseFloat((trigger.style.bottom || '').replace('px', '')) || 18;
            await writeStorage(STORAGE_KEYS.triggerPos, { right: r, bottom: b });
          }
        }
        triggerDragStartPos = null;
      }
    };
    window.addEventListener('pointerup', onTriggerDragEnd, { passive: true });

    langSel.addEventListener('change', async () => {
      const next = langSel.value;
      if (!isAppLanguage(next)) return;
      await i18n.set(next);
      refreshUITexts();
    });

    // Listen to external language changes (popup/options)
    // Note: The centralized i18n system already handles storage changes,
    // we just need to update the UI when language changes
    const storageChangeHandler = (
      changes: Record<string, browser.Storage.StorageChange>,
      area: string,
    ) => {
      // Handle language changes from sync storage
      const nextRaw = changes[StorageKeys.LANGUAGE]?.newValue;
      if (area === 'sync' && typeof nextRaw === 'string') {
        try {
          langSel.value = normalizeLanguage(nextRaw);
        } catch {}
        refreshUITexts();
      }
      // Handle hide prompt manager setting changes
      if (area === 'sync' && changes?.gvHidePromptManager) {
        const shouldHide = changes.gvHidePromptManager.newValue === true;
        pmHiddenByUser = shouldHide;
        pmLogger.info('Hide prompt manager setting changed', { shouldHide });
        if (shouldHide) {
          // Hide trigger and panel
          trigger.style.display = 'none';
          panel.classList.add('gv-hidden');
          open = false;
        } else {
          // Show trigger
          trigger.style.display = '';
        }
      }
      if (area === 'sync' && changes[StorageKeys.PROMPT_INSERT_ON_CLICK]) {
        promptInsertOnClick = changes[StorageKeys.PROMPT_INSERT_ON_CLICK].newValue === true;
      }
      if ((area === 'sync' || area === 'local') && changes[StorageKeys.PROMPT_VIEW_MODE]) {
        const nextMode = changes[StorageKeys.PROMPT_VIEW_MODE].newValue;
        if ((nextMode === 'compact' || nextMode === 'comfortable') && nextMode !== viewMode) {
          viewMode = nextMode;
          applyViewModeUI();
          renderList();
        }
      }
      // Handle prompt data changes from cloud sync (local storage)
      if (area === 'local' && changes?.gvPromptItems) {
        pmLogger.info('Prompt data changed in chrome.storage.local, reloading...');
        const newItems = changes.gvPromptItems.newValue;
        if (Array.isArray(newItems)) {
          items = newItems;
          renderTags();
          renderList();
          setNotice(i18n.t('syncSuccess') || 'Synced', 'ok');
        }
      }
    };

    try {
      browser.storage.onChanged.addListener(storageChangeHandler);
    } catch {}

    addBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      editingId = null;
      // Reset every field before opening. Without this, state from a cancelled
      // edit (especially the optional name, which sits at the top and is easy
      // to overlook) would leak into the new prompt.
      (addForm.querySelector('.gv-pm-input-name') as HTMLInputElement).value = '';
      (addForm.querySelector('.gv-pm-input-text') as HTMLTextAreaElement).value = '';
      (addForm.querySelector('.gv-pm-input-tags') as HTMLInputElement).value = '';
      setInlineHint('');
      addForm.classList.remove('gv-hidden');
      (addForm.querySelector('.gv-pm-input-text') as HTMLTextAreaElement)?.focus();
    });

    settingsBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        // Check if extension context is still valid
        if (!browser.runtime?.id) {
          // Extension context invalidated, show fallback message
          setNotice(
            i18n.t('pm_settings_fallback') || '璇风偣鍑绘祻瑙堝櫒宸ュ叿鏍忎腑鐨勬墿灞曞浘鏍囨墦寮€璁剧疆',
            'err',
          );
          return;
        }

        // Send message to background to open popup
        const response = (await browser.runtime.sendMessage({ type: 'gv.openPopup' })) as {
          ok?: boolean;
        };
        if (!response?.ok) {
          // If programmatic opening failed, show a helpful message
          setNotice(
            i18n.t('pm_settings_fallback') || '璇风偣鍑绘祻瑙堝櫒宸ュ叿鏍忎腑鐨勬墿灞曞浘鏍囨墦寮€璁剧疆',
            'err',
          );
        }
      } catch (err) {
        // Silently handle extension context errors
        if (isExtensionContextInvalidatedError(err)) {
          setNotice(
            i18n.t('pm_settings_fallback') || '璇风偣鍑绘祻瑙堝櫒宸ュ叿鏍忎腑鐨勬墿灞曞浘鏍囨墦寮€璁剧疆',
            'err',
          );
          return;
        }
        console.warn('[PromptManager] Failed to open settings:', err);
        setNotice(
          i18n.t('pm_settings_fallback') || '璇风偣鍑绘祻瑙堝櫒宸ュ叿鏍忎腑鐨勬墿灞曞浘鏍囨墦寮€璁剧疆',
          'err',
        );
      }
    });

    (addForm.querySelector('.gv-pm-cancel') as HTMLButtonElement).addEventListener(
      'click',
      (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        editingId = null;
        addForm.classList.add('gv-hidden');
      },
    );
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameRaw = (addForm.querySelector('.gv-pm-input-name') as HTMLInputElement).value;
      const name = nameRaw.trim();
      const text = (addForm.querySelector('.gv-pm-input-text') as HTMLTextAreaElement).value;
      const tagsRaw = (addForm.querySelector('.gv-pm-input-tags') as HTMLInputElement).value;
      const tags = dedupeTags((tagsRaw || '').split(',').map((s) => s.trim()));
      if (!text.trim()) return;
      if (editingId) {
        const dup = items.some(
          (x) => x.id !== editingId && x.text.trim().toLowerCase() === text.trim().toLowerCase(),
        );
        if (dup) {
          setInlineHint(i18n.t('pm_duplicate') || 'Duplicate prompt', 'err');
          return;
        }
        const target = items.find((x) => x.id === editingId);
        if (target) {
          target.text = text;
          target.tags = tags;
          if (name) target.name = name;
          else delete target.name;
          target.updatedAt = Date.now();
          await writeStorage(STORAGE_KEYS.items, items);
          setNotice(i18n.t('pm_saved') || 'Saved', 'ok');
        }
        editingId = null;
      } else {
        // prevent duplicates (case-insensitive, same text)
        const exists = items.some((x) => x.text.trim().toLowerCase() === text.trim().toLowerCase());
        if (exists) {
          setInlineHint(i18n.t('pm_duplicate') || 'Duplicate prompt', 'err');
          return;
        }
        const it: PromptItem = { id: uid(), text, tags, createdAt: Date.now() };
        if (name) it.name = name;
        items = [it, ...items];
        await writeStorage(STORAGE_KEYS.items, items);
      }
      (addForm.querySelector('.gv-pm-input-name') as HTMLInputElement).value = '';
      (addForm.querySelector('.gv-pm-input-text') as HTMLTextAreaElement).value = '';
      (addForm.querySelector('.gv-pm-input-tags') as HTMLInputElement).value = '';
      setInlineHint('');
      addForm.classList.add('gv-hidden');
      renderTags();
      renderList();
    });

    searchInput.addEventListener('input', () => renderList());

    exportBtn.addEventListener('click', async () => {
      try {
        const data = await readStorage<PromptItem[]>(STORAGE_KEYS.items, []);
        const payload = {
          format: 'gpt-voyager.prompts.v1',
          exportedAt: new Date().toISOString(),
          items: data,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `prompts-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch {
        setNotice('Export failed', 'err');
      }
    });

    // Backup button handler - creates timestamp folder with all data
    backupBtn.addEventListener('click', async () => {
      try {
        // Read prompts
        const prompts = await readStorage<PromptItem[]>(STORAGE_KEYS.items, []);
        const promptPayload = {
          format: 'gpt-voyager.prompts.v1',
          exportedAt: new Date().toISOString(),
          version: EXTENSION_VERSION,
          items: prompts,
        };

        // Read folders (Safari-compatible: uses storage adapter)
        const folderStorage = createFolderStorageAdapter();
        const folderData = (await folderStorage.loadData('gvFolderData')) || {
          folders: [],
          folderContents: {},
        };

        // Create folder export payload with correct format
        const folderPayload = {
          format: 'gpt-voyager.folders.v1',
          exportedAt: new Date().toISOString(),
          version: EXTENSION_VERSION,
          data: {
            folders: folderData.folders || [],
            folderContents: folderData.folderContents || {},
          },
        };

        const settingsPayload = await exportBackupableSyncSettings();
        const settingsCount = Object.keys(settingsPayload.data).length;

        // Count conversations
        const conversationCount = Object.values(folderData.folderContents || {}).reduce(
          (sum: number, convs: unknown) => sum + (Array.isArray(convs) ? convs.length : 0),
          0,
        );

        let timelineHierarchyData = normalizeTimelineHierarchyData(null);
        try {
          const timelineHierarchyStorage = (await chrome.storage.local.get(
            getTimelineHierarchyStorageKeysToRead(),
          )) as Record<string, unknown>;
          timelineHierarchyData =
            resolveTimelineHierarchyDataForStorageScope(timelineHierarchyStorage);
        } catch (error) {
          console.warn('[PromptManager] Failed to load timeline hierarchy backup data:', error);
        }
        const timelineHierarchyPayload = {
          format: 'gpt-voyager.timeline-hierarchy.v1' as const,
          exportedAt: new Date().toISOString(),
          version: EXTENSION_VERSION,
          data: timelineHierarchyData,
        };

        // Create metadata
        const metadata = {
          version: EXTENSION_VERSION,
          timestamp: new Date().toISOString(),
          includesSettings: true,
          includesPrompts: true,
          includesFolders: true,
          settingsCount,
          promptCount: prompts.length,
          folderCount: folderData.folders?.length || 0,
          conversationCount,
          timelineHierarchyConversationCount: Object.keys(timelineHierarchyData.conversations || {})
            .length,
        };

        // Generate timestamp for folder/file name
        const pad = (n: number) => String(n).padStart(2, '0');
        const d = new Date();
        const timestamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
        const folderName = `backup-${timestamp}`;

        // Check File System Access API support
        if ('showDirectoryPicker' in window) {
          // Modern browsers (Chrome, Edge) - use File System Access API
          const dirHandle = await (
            window as Window & {
              showDirectoryPicker: (opts?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
            }
          ).showDirectoryPicker({ mode: 'readwrite' });
          if (!dirHandle) {
            setNotice(i18n.t('pm_backup_cancelled') || 'Backup cancelled', 'err');
            return;
          }

          const backupDir = await dirHandle.getDirectoryHandle(folderName, { create: true });

          // Write files
          const promptsFile = await backupDir.getFileHandle('prompts.json', { create: true });
          const promptsWritable = await promptsFile.createWritable();
          await promptsWritable.write(JSON.stringify(promptPayload, null, 2));
          await promptsWritable.close();

          const foldersFile = await backupDir.getFileHandle('folders.json', { create: true });
          const foldersWritable = await foldersFile.createWritable();
          await foldersWritable.write(JSON.stringify(folderPayload, null, 2));
          await foldersWritable.close();

          const settingsFile = await backupDir.getFileHandle('settings.json', { create: true });
          const settingsWritable = await settingsFile.createWritable();
          await settingsWritable.write(JSON.stringify(settingsPayload, null, 2));
          await settingsWritable.close();

          const metaFile = await backupDir.getFileHandle('metadata.json', { create: true });
          const metaWritable = await metaFile.createWritable();
          await metaWritable.write(JSON.stringify(metadata, null, 2));
          await metaWritable.close();

          const timelineHierarchyFile = await backupDir.getFileHandle('timeline-hierarchy.json', {
            create: true,
          });
          const timelineHierarchyWritable = await timelineHierarchyFile.createWritable();
          await timelineHierarchyWritable.write(JSON.stringify(timelineHierarchyPayload, null, 2));
          await timelineHierarchyWritable.close();

          setNotice(
            `Backed up ${prompts.length} prompts, ${folderData.folders?.length || 0} folders`,
            'ok',
          );
        } else {
          // Fallback for Firefox, Safari - download as ZIP file
          const zip = new JSZip();

          // Add files to ZIP
          zip.file('prompts.json', JSON.stringify(promptPayload, null, 2));
          zip.file('folders.json', JSON.stringify(folderPayload, null, 2));
          zip.file('settings.json', JSON.stringify(settingsPayload, null, 2));
          zip.file('metadata.json', JSON.stringify(metadata, null, 2));
          zip.file('timeline-hierarchy.json', JSON.stringify(timelineHierarchyPayload, null, 2));

          // Generate ZIP file
          const zipBlob = await zip.generateAsync({ type: 'blob' });

          // Download ZIP file
          const url = URL.createObjectURL(zipBlob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${folderName}.zip`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);

          setNotice(
            `Downloaded ${folderName}.zip (${prompts.length} prompts, ${folderData.folders?.length || 0} folders)`,
            'ok',
          );
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          setNotice(i18n.t('pm_backup_cancelled') || 'Backup cancelled', 'err');
        } else {
          console.error('[PromptManager] Backup failed:', err);
          setNotice(i18n.t('pm_backup_error') || 'Backup failed', 'err');
        }
      }
    });

    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async () => {
      const file = importInput.files && importInput.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = safeParseJSON<unknown>(text, null);
        const parsedImport = parsePromptImportPayload(json);

        if (parsedImport.status === 'invalid') {
          setNotice(i18n.t('pm_import_invalid') || 'Invalid file format', 'err');
          return;
        }

        if (parsedImport.status === 'empty') {
          setNotice(i18n.t('pm_import_empty') || 'Import file contains no prompts', 'err');
          return;
        }

        const valid: PromptItem[] = parsedImport.items.map((item) => {
          const it: PromptItem = {
            id: uid(),
            text: item.text,
            tags: item.tags,
            createdAt: Date.now(),
          };
          if (item.name) it.name = item.name;
          return it;
        });

        // Merge by text equality (case-insensitive). Local fields win over
        // the import 鈥?except `name`, which we inherit from the import only
        // when the local item doesn't already have one (strictly additive).
        const map = new Map<string, PromptItem>();
        for (const it of items) map.set(it.text.toLowerCase(), it);
        for (const it of valid) {
          const k = it.text.toLowerCase();
          if (map.has(k)) {
            const prev = map.get(k)!;
            const mergedTags = dedupeTags([...(prev.tags || []), ...(it.tags || [])]);
            prev.tags = mergedTags;
            if (!prev.name && it.name) prev.name = it.name;
            prev.updatedAt = Date.now();
            map.set(k, prev);
          } else {
            map.set(k, it);
          }
        }

        items = Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        await writeStorage(STORAGE_KEYS.items, items);
        setNotice(
          (i18n.t('pm_import_success') || 'Imported').replace('{count}', String(valid.length)),
          'ok',
        );
        renderTags();
        renderList();
      } catch {
        setNotice(i18n.t('pm_import_invalid') || 'Invalid file format', 'err');
      } finally {
        importInput.value = '';
      }
    });

    // Initialize
    refreshUITexts();

    // Return destroy function
    return {
      destroy: () => {
        try {
          window.removeEventListener('resize', onWindowResize);
          window.removeEventListener('scroll', onReposition);
          window.removeEventListener('pointerdown', onWindowPointerDown, { capture: true });
          window.removeEventListener('keydown', onWindowKeyDown);
          window.removeEventListener('pointermove', onDragMove);
          window.removeEventListener('pointerup', endDrag);
          window.removeEventListener('pointerup', onTriggerDragEnd);
          tagsWrap.removeEventListener('scroll', syncTagScrollHint);

          chrome.storage?.onChanged?.removeListener(storageChangeHandler);

          // Tear down the fast-tooltip singleton: cancel pending timer, remove
          // the DOM element, and detach the capture-phase scroll listeners
          // attached to `list` and `window`. Without this, every re-init (SPA
          // nav / extension reload) would leak an orphan tooltip + listener.
          hideTooltip();
          if (tooltipEl) {
            try {
              tooltipEl.remove();
            } catch {}
            tooltipEl = null;
          }
          for (const target of tooltipScrollTargets) {
            try {
              target.removeEventListener('scroll', onTooltipDismiss, { capture: true });
            } catch {}
          }

          trigger.remove();
          panel.remove();
          document.querySelectorAll('.gv-pm-confirm').forEach((el) => el.remove());
          document.querySelectorAll('.gv-pm-support-popover').forEach((el) => el.remove());
        } catch (e) {
          console.error('[PromptManager] Destroy error:', e);
        }
      },
    };
  } catch (err) {
    try {
      if (isExtensionContextInvalidatedError(err)) {
        return { destroy: () => {} };
      }
      console.error('Prompt Manager init failed', err);
    } catch {}
    return { destroy: () => {} };
  }
}

export default { startPromptManager };
