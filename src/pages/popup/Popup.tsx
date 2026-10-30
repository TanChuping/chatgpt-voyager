import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/* The popup font-family picker calls into the chatFontFamily content-script
   feature via chrome.storage; see src/pages/content/chatFontFamily/index.ts. */

import { Check, ChevronRight, RotateCcw, Star } from 'lucide-react';
import browser from 'webextension-polyfill';

import { PROJECT_REPOSITORY_URL } from '@/core/constants/project';
import {
  DEFAULT_SUPPORT_GOAL,
  SUPPORT_GOAL_REFRESH_MS,
  type SupportGoalData,
  formatSupportAmount,
  getSupportGoalProgress,
  loadSupportGoal,
} from '@/core/services/SupportGoalService';
import { StorageKeys } from '@/core/types/common';
import {
  DEFAULT_SINGLE_CONV_EXPORT_FORMAT,
  type SingleConvExportFormat,
  isSingleConvExportFormat,
} from '@/features/singleConvExport';

import { DarkModeToggle } from '../../components/DarkModeToggle';
import { LanguageSwitcher } from '../../components/LanguageSwitcher';
import { Button } from '../../components/ui/button';
import { Label } from '../../components/ui/label';
import { Select } from '../../components/ui/select';
import { Switch } from '../../components/ui/switch';
import { useLanguage } from '../../contexts/LanguageContext';
import { StarredHistory } from './components/StarredHistory';
import WidthSlider from './components/WidthSlider';

type ScrollMode = 'jump' | 'flow';
type FormulaCopyFormat = 'latex' | 'unicodemath' | 'no-dollar' | 'notion' | 'desmos';
type PromptViewMode = 'compact' | 'comfortable';
/**
 * Mirror of `FontPreset` in `src/pages/content/chatFontFamily/index.ts`.
 * Keep in sync — both ends validate against this list.
 */
type FontPreset = 'default' | 'claude' | 'gemini' | 'custom';
const FONT_PRESETS: readonly FontPreset[] = ['default', 'claude', 'gemini', 'custom'] as const;

/**
 * 4 MB upper bound on imported font size. chrome.storage.local has an 5 MB
 * total quota for unlimitedStorage-free extensions; we want headroom for
 * the rest of the extension's local data (turn text cache etc.). Most
 * woff2 fonts are 80–300 KB, so this is generous.
 */
const MAX_CUSTOM_FONT_BYTES = 4 * 1024 * 1024;

const LEGACY_BASELINE_PX = 1200;
const CHAT_PERCENT = { min: 30, max: 100, defaultValue: 70 };
const CHAT_FONT_SIZE = { min: 80, max: 150, defaultValue: 100 };
const CODE_FONT_SIZE = { min: 80, max: 150, defaultValue: 100 };
const CHAT_LINE_HEIGHT = { min: 120, max: 220, defaultValue: 160 };
const CHAT_PARAGRAPH_SPACING = { min: 0, max: 32, defaultValue: 12 };
const EDIT_PERCENT = { min: 30, max: 100, defaultValue: 60 };
const FOLDER_SPACING = { min: 0, max: 16, defaultValue: 2 };
const FOLDER_TREE_INDENT = { min: -8, max: 32, defaultValue: -8 };

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

const normalizePercent = (value: unknown, fallback: number, min: number, max: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value > max) return clamp((value / LEGACY_BASELINE_PX) * 100, min, max);
  return clamp(value, min, max);
};

const normalizeNumber = (value: unknown, fallback: number, min: number, max: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
};

function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/^\*\./, '');
}

function toMatchPatterns(domain: string): string[] {
  const normalized = normalizeDomain(domain);
  if (!normalized) return [];
  return [`https://*.${normalized}/*`, `http://*.${normalized}/*`];
}

/**
 * Measure a classic scrollbar (Windows/Linux take layout width for it) and
 * expose it as `--gv-sbw` so `.gv-main` can keep both side margins equal.
 * Overlay scrollbars measure 0. Presentation only.
 */
function compensateScrollbar(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return undefined;
  const update = () => {
    el.style.setProperty('--gv-sbw', `${Math.max(0, el.offsetWidth - el.clientWidth)}px`);
  };
  update();
  window.addEventListener('resize', update);
  return () => window.removeEventListener('resize', update);
}

function ToggleRow({
  id,
  title,
  description,
  checked,
  onChange,
}: {
  id: string;
  title: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="gv-row">
      <Label htmlFor={id} className="gv-row__text">
        <span className="gv-row__title">{title}</span>
        {description ? <span className="gv-row__desc">{description}</span> : null}
      </Label>
      <Switch id={id} checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </div>
  );
}

/* ── Grouped-list primitives (presentation only) ─────────────────────────── */

function Section({
  title,
  index,
  children,
}: {
  title: string;
  /** Position in the entrance stagger (capped at 5 steps). */
  index: number;
  children: React.ReactNode;
}) {
  return (
    <section
      className="gv-section"
      style={{ '--gv-i': Math.min(Math.max(index, 0), 5) } as React.CSSProperties}
    >
      <h2 className="gv-section-label">{title}</h2>
      {children}
    </section>
  );
}

function Group({ children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="gv-group" {...rest}>
      {children}
    </div>
  );
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="gv-section-label">{children}</h3>;
}

function Footnote({ children }: { children: React.ReactNode }) {
  return <p className="gv-footnote">{children}</p>;
}

type SegmentOption = { value: string; label: string; onSelect: () => void };

/** Pill segmented control; the selected thumb slides on a spring. */
function Segmented({ value, options }: { value: string; options: SegmentOption[] }) {
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  return (
    <div
      className="gv-seg"
      style={{ '--gv-seg-count': options.length, '--gv-seg-index': index } as React.CSSProperties}
    >
      <span className="gv-seg__thumb" aria-hidden="true" />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="gv-seg__item"
          aria-pressed={option.value === value}
          onClick={option.onSelect}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Row that opens another view. */
function NavRow({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button type="button" className="gv-row gv-row--action" onClick={onClick}>
      <span className="gv-row__title min-w-0 flex-1">{title}</span>
      <span className="gv-row__trail" aria-hidden="true">
        <ChevronRight strokeWidth={2} />
      </span>
    </button>
  );
}

/** One-shot action row; the icon turns once as acknowledgement. */
function ResetRow({ title, onReset }: { title: string; onReset: () => void }) {
  const [turns, setTurns] = useState(0);
  return (
    <button
      type="button"
      className="gv-row gv-row--action"
      onClick={() => {
        onReset();
        setTurns((count) => count + 1);
      }}
    >
      <span className="gv-row__title min-w-0 flex-1">{title}</span>
      <span className="gv-row__trail" aria-hidden="true">
        <RotateCcw
          key={turns}
          className={turns > 0 ? 'gv-spin-once' : undefined}
          strokeWidth={1.8}
        />
      </span>
    </button>
  );
}

function SupportPopover({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [goal, setGoal] = useState<SupportGoalData>(DEFAULT_SUPPORT_GOAL);
  const closeTimerRef = useRef<number | null>(null);
  const hoveringButtonRef = useRef(false);
  const hoveringPopoverRef = useRef(false);
  const progress = getSupportGoalProgress(goal);

  const clearCloseTimer = () => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const openPopover = () => {
    clearCloseTimer();
    setOpen(true);
  };

  const scheduleClose = () => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      if (!pinned && !hoveringButtonRef.current && !hoveringPopoverRef.current) {
        setOpen(false);
      }
    }, 180);
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const refresh = (force = false) =>
      void loadSupportGoal({ force }).then((data) => {
        if (!cancelled) setGoal(data);
      });

    refresh();
    const interval = window.setInterval(() => refresh(true), SUPPORT_GOAL_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [open]);

  useEffect(() => () => clearCloseTimer(), []);

  const visible = open && goal.enabled;

  return (
    <div className="relative">
      <button
        type="button"
        className="gv-footer-link"
        aria-expanded={visible}
        onMouseEnter={() => {
          hoveringButtonRef.current = true;
          openPopover();
        }}
        onMouseLeave={() => {
          hoveringButtonRef.current = false;
          scheduleClose();
        }}
        onClick={() => {
          setPinned((value) => {
            const next = !value;
            if (next) openPopover();
            else if (!hoveringButtonRef.current && !hoveringPopoverRef.current) setOpen(false);
            return next;
          });
        }}
      >
        {label}
      </button>
      {visible ? (
        <div
          className="gv-popover fixed bottom-12 left-1/2 z-50 max-h-[calc(100vh-4rem)] w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 overflow-y-auto p-4 text-left"
          onMouseEnter={() => {
            hoveringPopoverRef.current = true;
            openPopover();
          }}
          onMouseLeave={() => {
            hoveringPopoverRef.current = false;
            scheduleClose();
          }}
        >
          <div className="mb-3">
            <p className="text-fg text-sm leading-[1.35] font-semibold">{goal.title}</p>
            <p className="text-fg-2 mt-1 text-[12.5px] leading-[1.55]">{goal.description}</p>
          </div>
          {goal.imageUrl ? (
            <img
              src={goal.imageUrl}
              alt={goal.title}
              className="bg-well mb-3 max-h-36 w-full rounded-[10px] object-cover"
            />
          ) : null}
          <div className="space-y-2">
            <div className="text-fg-2 flex items-center justify-between text-xs font-medium tabular-nums">
              <span>
                {formatSupportAmount(goal.current, goal.currency)} /{' '}
                {formatSupportAmount(goal.target, goal.currency)}
              </span>
              <span>{progress}%</span>
            </div>
            <div className="bg-well-2 h-1.5 overflow-hidden rounded-full">
              <div
                className="bg-primary h-full rounded-full transition-[width] duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
          <div className="mt-4 grid gap-3">
            <a
              href={goal.kofiUrl}
              target="_blank"
              rel="noreferrer"
              className="gv-btn bg-primary text-primary-foreground hover:bg-primary-hover inline-flex h-8 items-center justify-center rounded-[9px] px-4 text-[13px] font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_1px_2px_rgba(0,0,0,0.12)]"
            >
              Ko-fi
            </a>
          </div>
          {goal.wechatQrUrl || goal.alipayQrUrl ? (
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              {goal.wechatQrUrl ? (
                <div className="bg-well text-fg-3 flex flex-col items-center justify-center overflow-hidden rounded-[10px] text-center text-[11px] leading-tight">
                  <img
                    src={goal.wechatQrUrl}
                    alt="WeChat QR"
                    className="aspect-square w-full object-cover"
                  />
                  <span className="py-1.5">微信</span>
                </div>
              ) : null}
              {goal.alipayQrUrl ? (
                <div className="bg-well text-fg-3 flex flex-col items-center justify-center overflow-hidden rounded-[10px] text-center text-[11px] leading-tight">
                  <img
                    src={goal.alipayQrUrl}
                    alt="Alipay QR"
                    className="aspect-square w-full object-cover"
                  />
                  <span className="py-1.5">支付宝</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function Popup() {
  const { t } = useLanguage();
  const [showStarredHistory, setShowStarredHistory] = useState(false);
  const [extVersion, setExtVersion] = useState('');

  const [timelineEnabled, setTimelineEnabled] = useState(true);
  const [timelineMode, setTimelineMode] = useState<ScrollMode>('flow');
  const [timelineHidden, setTimelineHidden] = useState(false);
  const [timelineDraggable, setTimelineDraggable] = useState(false);
  const [timelinePreviewPinned, setTimelinePreviewPinned] = useState(false);
  const [timelineMarkerLevel, setTimelineMarkerLevel] = useState(false);
  const [forkEnabled, setForkEnabled] = useState(false);

  const [folderEnabled, setFolderEnabled] = useState(true);
  const [folderFloating, setFolderFloating] = useState(false);
  const [hideArchived, setHideArchived] = useState(false);
  const [folderProjectEnabled, setFolderProjectEnabled] = useState(false);
  const [folderHeaderButtonEnabled, setFolderHeaderButtonEnabled] = useState(false);
  const [folderBelowProjects, setFolderBelowProjects] = useState(false);
  const [folderSpacing, setFolderSpacing] = useState(FOLDER_SPACING.defaultValue);
  const [folderTreeIndent, setFolderTreeIndent] = useState(FOLDER_TREE_INDENT.defaultValue);

  const [chatWidthEnabled, setChatWidthEnabled] = useState(false);
  const [chatWidth, setChatWidth] = useState(CHAT_PERCENT.defaultValue);
  const [chatFontSizeEnabled, setChatFontSizeEnabled] = useState(false);
  const [chatFontSize, setChatFontSize] = useState(CHAT_FONT_SIZE.defaultValue);
  const [codeFontSizeEnabled, setCodeFontSizeEnabled] = useState(false);
  const [codeFontSize, setCodeFontSize] = useState(CODE_FONT_SIZE.defaultValue);
  const [longCodeBlockCollapse, setLongCodeBlockCollapse] = useState(false);
  const [chatLineHeightEnabled, setChatLineHeightEnabled] = useState(false);
  const [chatLineHeight, setChatLineHeight] = useState(CHAT_LINE_HEIGHT.defaultValue);
  const [chatParagraphSpacingEnabled, setChatParagraphSpacingEnabled] = useState(false);
  const [chatParagraphSpacing, setChatParagraphSpacing] = useState(
    CHAT_PARAGRAPH_SPACING.defaultValue,
  );
  const [fontFamilyEnabled, setFontFamilyEnabled] = useState(false);
  const [fontFamily, setFontFamily] = useState<FontPreset>('default');
  /**
   * Human-readable name shown next to the "Custom" option. Mirror of
   * `gvChatCustomFontName` in storage.sync. Empty string when no font
   * has been imported on this device yet (even if another device has
   * imported one — the bytes don't sync across devices).
   */
  const [customFontName, setCustomFontName] = useState<string>('');
  /**
   * Transient status line under the import button — last import success
   * or failure message. Not persisted; recomputed on each file pick.
   */
  const [customFontStatus, setCustomFontStatus] = useState<string>('');
  const customFontInputRef = useRef<HTMLInputElement | null>(null);
  const [editInputWidthEnabled, setEditInputWidthEnabled] = useState(false);
  const [editInputWidth, setEditInputWidth] = useState(EDIT_PERCENT.defaultValue);
  const [railToggleEnabled, setRailToggleEnabled] = useState(true);
  const [quotaRingEnabled, setQuotaRingEnabled] = useState(true);
  const [driveAutoAllowEnabled, setDriveAutoAllowEnabled] = useState(false);

  const [ctrlEnterSend, setCtrlEnterSend] = useState(false);
  const [safariEnterFix, setSafariEnterFix] = useState(false);
  const [inputCollapse, setInputCollapse] = useState(false);
  const [inputCollapseWhenNotEmpty, setInputCollapseWhenNotEmpty] = useState(false);
  const [vimMode, setVimMode] = useState(false);
  const [plainTextInput, setPlainTextInput] = useState(false);
  const [draftAutoSave, setDraftAutoSave] = useState(false);
  const [preventAutoScroll, setPreventAutoScroll] = useState(false);
  const [quoteReply, setQuoteReply] = useState(true);
  const [responseCompleteNotification, setResponseCompleteNotification] = useState(true);

  const [formulaCopyFormat, setFormulaCopyFormat] = useState<FormulaCopyFormat>('latex');
  const [singleConvExportFormat, setSingleConvExportFormat] = useState<SingleConvExportFormat>(
    DEFAULT_SINGLE_CONV_EXPORT_FORMAT,
  );
  const [mermaidEnabled, setMermaidEnabled] = useState(true);
  const [gentleDarkEnabled, setGentleDarkEnabled] = useState(false);
  const [promptHidden, setPromptHidden] = useState(false);
  const [promptInsertOnClick, setPromptInsertOnClick] = useState(false);
  const [promptViewMode, setPromptViewMode] = useState<PromptViewMode>('comfortable');
  const [customWebsites, setCustomWebsites] = useState<string[]>([]);
  const [customWebsiteInput, setCustomWebsiteInput] = useState('');
  const [customWebsiteNotice, setCustomWebsiteNotice] = useState('');

  const setSyncStorage = useCallback(async (items: Record<string, unknown>) => {
    await browser.storage.sync.set(items);
  }, []);

  /**
   * Read a user-picked font file, base64-encode it, push the metadata to
   * sync and the bytes to local. Also flips the family preset to 'custom'
   * and enables the feature so the user sees the effect immediately —
   * importing a font with the toggle off would be confusing.
   *
   * woff2 is preferred (10× smaller than ttf typically) but we accept
   * all the common desktop formats. Files larger than `MAX_CUSTOM_FONT_BYTES`
   * are rejected before allocating any payload, to keep us under
   * chrome.storage.local's ~5 MB quota.
   */
  const handleCustomFontPicked = useCallback(async (file: File) => {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext !== 'woff2' && ext !== 'woff' && ext !== 'ttf' && ext !== 'otf') {
      setCustomFontStatus(`✗ ${file.name}: unsupported (use woff2/woff/ttf/otf)`);
      return;
    }
    if (file.size > MAX_CUSTOM_FONT_BYTES) {
      setCustomFontStatus(`✗ ${file.name}: too large (${Math.round(file.size / 1024)} KB > 4 MB)`);
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      // Base64-encode in 32 KB chunks. `String.fromCharCode(...bigArray)`
      // overflows the call stack for files larger than ~125 KB on V8.
      const bytes = new Uint8Array(buf);
      const CHUNK = 0x8000;
      let binary = '';
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
      }
      const base64 = btoa(binary);
      const mime =
        ext === 'woff2'
          ? 'font/woff2'
          : ext === 'woff'
            ? 'font/woff'
            : ext === 'ttf'
              ? 'font/ttf'
              : 'font/otf';
      const dataUrl = `data:${mime};base64,${base64}`;
      const displayName = file.name.replace(/\.[^.]+$/, '');

      // Heavy payload → chrome.storage.local (sync has 8 KB per-item cap).
      await browser.storage.local.set({ [StorageKeys.CHAT_CUSTOM_FONT_DATA]: dataUrl });
      // Metadata + preset selection → chrome.storage.sync so it round-
      // trips across devices. Without the data the content script falls
      // back to system fonts gracefully on the other device.
      await browser.storage.sync.set({
        [StorageKeys.CHAT_CUSTOM_FONT_NAME]: displayName,
        [StorageKeys.CHAT_CUSTOM_FONT_FORMAT]: ext,
        [StorageKeys.CHAT_FONT_FAMILY]: 'custom',
        [StorageKeys.CHAT_FONT_FAMILY_ENABLED]: true,
      });
      setCustomFontName(displayName);
      setFontFamily('custom');
      setFontFamilyEnabled(true);
      setCustomFontStatus(`✓ ${displayName} (${Math.round(file.size / 1024)} KB)`);
    } catch (err) {
      console.warn('[GPT-Voyager] custom font import failed:', err);
      setCustomFontStatus(`✗ ${String((err as Error)?.message || err)}`);
    }
  }, []);

  /**
   * Drop the imported font bytes + metadata. If the user was currently on
   * the 'custom' preset, fall back to 'default' so they aren't stuck
   * looking at the system fallback wondering what happened.
   */
  const handleCustomFontClear = useCallback(async () => {
    await browser.storage.local.remove(StorageKeys.CHAT_CUSTOM_FONT_DATA);
    await browser.storage.sync.set({
      [StorageKeys.CHAT_CUSTOM_FONT_NAME]: '',
      [StorageKeys.CHAT_CUSTOM_FONT_FORMAT]: '',
    });
    setCustomFontName('');
    setCustomFontStatus('');
    if (fontFamily === 'custom') {
      setFontFamily('default');
      await browser.storage.sync.set({ [StorageKeys.CHAT_FONT_FAMILY]: 'default' });
    }
  }, [fontFamily]);

  useEffect(() => {
    try {
      setExtVersion(chrome?.runtime?.getManifest?.()?.version ?? '');
    } catch {
      setExtVersion('');
    }

    void browser.storage.sync
      .get({
        [StorageKeys.TIMELINE_ENABLED]: true,
        [StorageKeys.TIMELINE_SCROLL_MODE]: 'flow',
        [StorageKeys.TIMELINE_HIDE_CONTAINER]: false,
        [StorageKeys.TIMELINE_DRAGGABLE]: false,
        [StorageKeys.TIMELINE_PREVIEW_PINNED]: false,
        [StorageKeys.TIMELINE_MARKER_LEVEL]: false,
        [StorageKeys.FORK_ENABLED]: false,
        [StorageKeys.FOLDER_ENABLED]: true,
        [StorageKeys.FOLDER_FLOATING_MODE_ENABLED]: false,
        [StorageKeys.FOLDER_HIDE_ARCHIVED_CONVERSATIONS]: false,
        [StorageKeys.FOLDER_PROJECT_ENABLED]: false,
        [StorageKeys.FOLDER_HEADER_BUTTON_ENABLED]: false,
        [StorageKeys.GV_FOLDER_BELOW_PROJECTS]: false,
        [StorageKeys.GV_FOLDER_SPACING]: FOLDER_SPACING.defaultValue,
        [StorageKeys.GV_FOLDER_TREE_INDENT]: FOLDER_TREE_INDENT.defaultValue,
        [StorageKeys.CHAT_WIDTH_ENABLED]: false,
        [StorageKeys.CHAT_WIDTH]: CHAT_PERCENT.defaultValue,
        [StorageKeys.CHAT_FONT_SIZE_ENABLED]: false,
        [StorageKeys.CHAT_FONT_SIZE]: CHAT_FONT_SIZE.defaultValue,
        [StorageKeys.CODE_FONT_SIZE_ENABLED]: false,
        [StorageKeys.CODE_FONT_SIZE]: CODE_FONT_SIZE.defaultValue,
        [StorageKeys.LONG_CODE_BLOCK_COLLAPSE_ENABLED]: false,
        [StorageKeys.CHAT_LINE_HEIGHT_ENABLED]: false,
        [StorageKeys.CHAT_LINE_HEIGHT]: CHAT_LINE_HEIGHT.defaultValue,
        [StorageKeys.CHAT_PARAGRAPH_SPACING_ENABLED]: false,
        [StorageKeys.CHAT_PARAGRAPH_SPACING]: CHAT_PARAGRAPH_SPACING.defaultValue,
        [StorageKeys.CHAT_FONT_FAMILY_ENABLED]: false,
        [StorageKeys.CHAT_FONT_FAMILY]: 'default',
        [StorageKeys.CHAT_CUSTOM_FONT_NAME]: '',
        [StorageKeys.EDIT_INPUT_WIDTH_ENABLED]: false,
        [StorageKeys.EDIT_INPUT_WIDTH]: EDIT_PERCENT.defaultValue,
        [StorageKeys.GV_RAIL_TOGGLE_ENABLED]: true,
        [StorageKeys.GV_QUOTA_RING_ENABLED]: true,
        [StorageKeys.DRIVE_AUTO_ALLOW_ENABLED]: false,
        [StorageKeys.CTRL_ENTER_SEND]: false,
        [StorageKeys.SAFARI_ENTER_FIX]: false,
        [StorageKeys.INPUT_COLLAPSE_ENABLED]: false,
        [StorageKeys.INPUT_COLLAPSE_WHEN_NOT_EMPTY]: false,
        [StorageKeys.INPUT_VIM_MODE]: false,
        [StorageKeys.PLAIN_TEXT_INPUT_ENABLED]: false,
        [StorageKeys.DRAFT_AUTO_SAVE]: false,
        [StorageKeys.PREVENT_AUTO_SCROLL_ENABLED]: false,
        [StorageKeys.QUOTE_REPLY_ENABLED]: true,
        [StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED]: true,
        gvFormulaCopyFormat: 'latex',
        [StorageKeys.MERMAID_ENABLED]: true,
        [StorageKeys.GENTLE_DARK_ENABLED]: false,
        [StorageKeys.HIDE_PROMPT_MANAGER]: false,
        [StorageKeys.PROMPT_INSERT_ON_CLICK]: false,
        [StorageKeys.PROMPT_VIEW_MODE]: 'comfortable',
        [StorageKeys.PROMPT_CUSTOM_WEBSITES]: [],
        [StorageKeys.SINGLE_CONV_EXPORT_FORMAT]: DEFAULT_SINGLE_CONV_EXPORT_FORMAT,
      })
      .then((result) => {
        setTimelineEnabled(result[StorageKeys.TIMELINE_ENABLED] !== false);
        const mode = result[StorageKeys.TIMELINE_SCROLL_MODE];
        setTimelineMode(mode === 'jump' ? 'jump' : 'flow');
        setTimelineHidden(result[StorageKeys.TIMELINE_HIDE_CONTAINER] === true);
        setTimelineDraggable(result[StorageKeys.TIMELINE_DRAGGABLE] === true);
        setTimelinePreviewPinned(result[StorageKeys.TIMELINE_PREVIEW_PINNED] === true);
        setTimelineMarkerLevel(result[StorageKeys.TIMELINE_MARKER_LEVEL] === true);
        setForkEnabled(result[StorageKeys.FORK_ENABLED] === true);
        setFolderEnabled(result[StorageKeys.FOLDER_ENABLED] !== false);
        setFolderFloating(result[StorageKeys.FOLDER_FLOATING_MODE_ENABLED] === true);
        setHideArchived(result[StorageKeys.FOLDER_HIDE_ARCHIVED_CONVERSATIONS] === true);
        setFolderProjectEnabled(result[StorageKeys.FOLDER_PROJECT_ENABLED] === true);
        setFolderHeaderButtonEnabled(result[StorageKeys.FOLDER_HEADER_BUTTON_ENABLED] === true);
        setFolderBelowProjects(result[StorageKeys.GV_FOLDER_BELOW_PROJECTS] === true);
        setFolderSpacing(
          normalizeNumber(
            result[StorageKeys.GV_FOLDER_SPACING],
            FOLDER_SPACING.defaultValue,
            FOLDER_SPACING.min,
            FOLDER_SPACING.max,
          ),
        );
        setFolderTreeIndent(
          normalizeNumber(
            result[StorageKeys.GV_FOLDER_TREE_INDENT],
            FOLDER_TREE_INDENT.defaultValue,
            FOLDER_TREE_INDENT.min,
            FOLDER_TREE_INDENT.max,
          ),
        );
        setChatWidthEnabled(result[StorageKeys.CHAT_WIDTH_ENABLED] === true);
        setChatWidth(
          normalizePercent(
            result[StorageKeys.CHAT_WIDTH],
            CHAT_PERCENT.defaultValue,
            CHAT_PERCENT.min,
            CHAT_PERCENT.max,
          ),
        );
        setChatFontSizeEnabled(result[StorageKeys.CHAT_FONT_SIZE_ENABLED] === true);
        setChatFontSize(
          normalizeNumber(
            result[StorageKeys.CHAT_FONT_SIZE],
            CHAT_FONT_SIZE.defaultValue,
            CHAT_FONT_SIZE.min,
            CHAT_FONT_SIZE.max,
          ),
        );
        setCodeFontSizeEnabled(result[StorageKeys.CODE_FONT_SIZE_ENABLED] === true);
        setCodeFontSize(
          normalizeNumber(
            result[StorageKeys.CODE_FONT_SIZE],
            CODE_FONT_SIZE.defaultValue,
            CODE_FONT_SIZE.min,
            CODE_FONT_SIZE.max,
          ),
        );
        setLongCodeBlockCollapse(result[StorageKeys.LONG_CODE_BLOCK_COLLAPSE_ENABLED] === true);
        setChatLineHeightEnabled(result[StorageKeys.CHAT_LINE_HEIGHT_ENABLED] === true);
        setChatLineHeight(
          normalizeNumber(
            result[StorageKeys.CHAT_LINE_HEIGHT],
            CHAT_LINE_HEIGHT.defaultValue,
            CHAT_LINE_HEIGHT.min,
            CHAT_LINE_HEIGHT.max,
          ),
        );
        setChatParagraphSpacingEnabled(result[StorageKeys.CHAT_PARAGRAPH_SPACING_ENABLED] === true);
        setChatParagraphSpacing(
          normalizeNumber(
            result[StorageKeys.CHAT_PARAGRAPH_SPACING],
            CHAT_PARAGRAPH_SPACING.defaultValue,
            CHAT_PARAGRAPH_SPACING.min,
            CHAT_PARAGRAPH_SPACING.max,
          ),
        );
        setFontFamilyEnabled(result[StorageKeys.CHAT_FONT_FAMILY_ENABLED] === true);
        const rawFamily = result[StorageKeys.CHAT_FONT_FAMILY];
        setFontFamily(
          FONT_PRESETS.includes(rawFamily as FontPreset) ? (rawFamily as FontPreset) : 'default',
        );
        const rawCustomName = result[StorageKeys.CHAT_CUSTOM_FONT_NAME];
        setCustomFontName(typeof rawCustomName === 'string' ? rawCustomName : '');
        setEditInputWidthEnabled(result[StorageKeys.EDIT_INPUT_WIDTH_ENABLED] === true);
        setEditInputWidth(
          normalizePercent(
            result[StorageKeys.EDIT_INPUT_WIDTH],
            EDIT_PERCENT.defaultValue,
            EDIT_PERCENT.min,
            EDIT_PERCENT.max,
          ),
        );
        setRailToggleEnabled(result[StorageKeys.GV_RAIL_TOGGLE_ENABLED] !== false);
        setQuotaRingEnabled(result[StorageKeys.GV_QUOTA_RING_ENABLED] !== false);
        setDriveAutoAllowEnabled(result[StorageKeys.DRIVE_AUTO_ALLOW_ENABLED] === true);
        setCtrlEnterSend(result[StorageKeys.CTRL_ENTER_SEND] === true);
        setSafariEnterFix(result[StorageKeys.SAFARI_ENTER_FIX] === true);
        setInputCollapse(result[StorageKeys.INPUT_COLLAPSE_ENABLED] === true);
        setInputCollapseWhenNotEmpty(result[StorageKeys.INPUT_COLLAPSE_WHEN_NOT_EMPTY] === true);
        setVimMode(result[StorageKeys.INPUT_VIM_MODE] === true);
        setPlainTextInput(result[StorageKeys.PLAIN_TEXT_INPUT_ENABLED] === true);
        setDraftAutoSave(result[StorageKeys.DRAFT_AUTO_SAVE] === true);
        setPreventAutoScroll(result[StorageKeys.PREVENT_AUTO_SCROLL_ENABLED] === true);
        setQuoteReply(result[StorageKeys.QUOTE_REPLY_ENABLED] !== false);
        setResponseCompleteNotification(
          result[StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED] !== false,
        );
        const formula = result.gvFormulaCopyFormat;
        setFormulaCopyFormat(
          formula === 'unicodemath' ||
            formula === 'no-dollar' ||
            formula === 'desmos' ||
            formula === 'notion' ||
            formula === 'latex'
            ? formula
            : 'latex',
        );
        setMermaidEnabled(result[StorageKeys.MERMAID_ENABLED] !== false);
        setGentleDarkEnabled(result[StorageKeys.GENTLE_DARK_ENABLED] === true);
        setPromptHidden(result[StorageKeys.HIDE_PROMPT_MANAGER] === true);
        setPromptInsertOnClick(result[StorageKeys.PROMPT_INSERT_ON_CLICK] === true);
        setPromptViewMode(
          result[StorageKeys.PROMPT_VIEW_MODE] === 'compact' ? 'compact' : 'comfortable',
        );
        setCustomWebsites(
          Array.isArray(result[StorageKeys.PROMPT_CUSTOM_WEBSITES])
            ? (result[StorageKeys.PROMPT_CUSTOM_WEBSITES] as string[])
            : [],
        );
        const exportFormat = result[StorageKeys.SINGLE_CONV_EXPORT_FORMAT];
        setSingleConvExportFormat(
          isSingleConvExportFormat(exportFormat) ? exportFormat : DEFAULT_SINGLE_CONV_EXPORT_FORMAT,
        );
      });
  }, []);

  const updateToggle = useCallback(
    <T,>(setter: React.Dispatch<React.SetStateAction<T>>, key: string, value: T) => {
      setter(value);
      void setSyncStorage({ [key]: value });
    },
    [setSyncStorage],
  );

  const addCustomWebsite = useCallback(async () => {
    const domain = normalizeDomain(customWebsiteInput);
    if (!domain) return;
    if (customWebsites.includes(domain)) {
      setCustomWebsiteNotice('Already added');
      return;
    }

    const origins = toMatchPatterns(domain);
    const granted = await browser.permissions.request({ origins });
    if (!granted) {
      setCustomWebsiteNotice('Permission was not granted');
      return;
    }

    const next = [...customWebsites, domain];
    setCustomWebsites(next);
    setCustomWebsiteInput('');
    setCustomWebsiteNotice('Added');
    await setSyncStorage({ [StorageKeys.PROMPT_CUSTOM_WEBSITES]: next });
  }, [customWebsiteInput, customWebsites, setSyncStorage]);

  const removeCustomWebsite = useCallback(
    async (domain: string) => {
      const next = customWebsites.filter((item) => item !== domain);
      setCustomWebsites(next);
      await setSyncStorage({ [StorageKeys.PROMPT_CUSTOM_WEBSITES]: next });
      await browser.permissions.remove({ origins: toMatchPatterns(domain) }).catch(() => false);
    },
    [customWebsites, setSyncStorage],
  );

  const formulaOptions = useMemo(
    () =>
      [
        ['latex', t('formulaCopyFormatLatex')],
        ['unicodemath', t('formulaCopyFormatUnicodeMath')],
        ['no-dollar', t('formulaCopyFormatNoDollar')],
        ['desmos', t('formulaCopyFormatDesmos')],
        ['notion', t('formulaCopyFormatNotion')],
      ] as const,
    [t],
  );

  /**
   * Mirror of `SingleConvExportFormat`. Keep this list in sync with
   * `src/features/singleConvExport/index.ts`. The label/description pairs
   * are intentionally distinct: the label fits one line in the popup, the
   * description tells the user *what gets stripped out* in the simplified
   * variants — which is the whole reason this setting exists.
   */
  const singleConvExportOptions = useMemo(
    () =>
      [
        ['markdown', t('singleConvExportFormatMarkdown'), t('singleConvExportFormatMarkdownHint')],
        [
          'markdown-simple',
          t('singleConvExportFormatMarkdownSimple'),
          t('singleConvExportFormatSimpleHint'),
        ],
        ['json', t('singleConvExportFormatJson'), t('singleConvExportFormatJsonHint')],
        [
          'json-simple',
          t('singleConvExportFormatJsonSimple'),
          t('singleConvExportFormatSimpleHint'),
        ],
        ['html', t('singleConvExportFormatHtml'), t('singleConvExportFormatSimpleHint')],
      ] as const,
    [t],
  );

  /* ── Presentation-only state ────────────────────────────────────────────
     Transitions stay off for a moment after opening so controls snap to the
     stored values instead of visibly flipping from their defaults. */
  const [motionReady, setMotionReady] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setMotionReady(true), 360);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    // Title of the fallback settings window (was the generic "Popup").
    document.title = t('extName');
  }, [t]);

  /** Display text for the `{modifier}` placeholder in the send-shortcut strings. */
  const modifierKey = useMemo(() => {
    try {
      const platform = `${navigator.platform || ''} ${navigator.userAgent || ''}`;
      return /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘' : 'Ctrl';
    } catch {
      return 'Ctrl';
    }
  }, []);
  const withModifier = (text: string) => text.replace(/\{modifier\}/g, modifierKey);

  const mainRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => compensateScrollbar(mainRef.current), [showStarredHistory]);
  // Typographic minus so negative values line up with the tabular digits.
  const formatPx = (value: number) => `${value < 0 ? '\u2212' : ''}${Math.abs(value)}px`;

  if (showStarredHistory) {
    return <StarredHistory onClose={() => setShowStarredHistory(false)} />;
  }

  return (
    <div
      className="gv-shell flex h-full min-h-0 w-full flex-col overflow-hidden"
      data-motion={motionReady ? 'on' : 'off'}
    >
      <header className="gv-header">
        <div className="gv-brand">
          <img
            src="/icon-32.png"
            srcSet="/icon-32.png 1x, /icon-48.png 2x, /icon-128.png 4x"
            width={22}
            height={22}
            alt=""
            draggable={false}
          />
          <h1 className="gv-title">{t('extName')}</h1>
        </div>
        <div className="flex items-center gap-0.5">
          <DarkModeToggle />
          <LanguageSwitcher />
        </div>
      </header>

      <div ref={mainRef} className="gv-main flex flex-col gap-[18px] overflow-y-auto pt-3 pb-5">
        <Section index={0} title={t('timelineOptions')}>
          <Group>
            <ToggleRow
              id="timeline-enabled"
              title={t('enableTimeline')}
              description={t('enableTimelineDescription')}
              checked={timelineEnabled}
              onChange={(value) =>
                updateToggle(setTimelineEnabled, StorageKeys.TIMELINE_ENABLED, value)
              }
            />
            <div className="gv-row py-2">
              <Segmented
                value={timelineMode}
                options={[
                  {
                    value: 'flow',
                    label: t('flow'),
                    onSelect: () =>
                      updateToggle<ScrollMode>(
                        setTimelineMode,
                        StorageKeys.TIMELINE_SCROLL_MODE,
                        'flow',
                      ),
                  },
                  {
                    value: 'jump',
                    label: t('jump'),
                    onSelect: () =>
                      updateToggle<ScrollMode>(
                        setTimelineMode,
                        StorageKeys.TIMELINE_SCROLL_MODE,
                        'jump',
                      ),
                  },
                ]}
              />
            </div>
            <ToggleRow
              id="timeline-hidden"
              title={t('hideOuterContainer')}
              checked={timelineHidden}
              onChange={(value) =>
                updateToggle(setTimelineHidden, StorageKeys.TIMELINE_HIDE_CONTAINER, value)
              }
            />
            <ToggleRow
              id="timeline-draggable"
              title={t('draggableTimeline')}
              checked={timelineDraggable}
              onChange={(value) =>
                updateToggle(setTimelineDraggable, StorageKeys.TIMELINE_DRAGGABLE, value)
              }
            />
            <ToggleRow
              id="timeline-preview"
              title={t('pinTimelinePreview')}
              description={t('pinTimelinePreviewHint')}
              checked={timelinePreviewPinned}
              onChange={(value) =>
                updateToggle(setTimelinePreviewPinned, StorageKeys.TIMELINE_PREVIEW_PINNED, value)
              }
            />
            <ToggleRow
              id="timeline-level"
              title={t('enableMarkerLevel')}
              description={t('enableMarkerLevelHint')}
              checked={timelineMarkerLevel}
              onChange={(value) =>
                updateToggle(setTimelineMarkerLevel, StorageKeys.TIMELINE_MARKER_LEVEL, value)
              }
            />
            <ToggleRow
              id="fork-enabled"
              title={t('enableForkFeature')}
              description={t('enableForkFeatureHint')}
              checked={forkEnabled}
              onChange={(value) => updateToggle(setForkEnabled, StorageKeys.FORK_ENABLED, value)}
            />
          </Group>
          <Group>
            <ResetRow
              title={t('resetTimelinePosition')}
              onReset={() => void setSyncStorage({ [StorageKeys.TIMELINE_POSITION]: null })}
            />
            <NavRow title={t('viewStarredHistory')} onClick={() => setShowStarredHistory(true)} />
          </Group>
        </Section>

        <Section index={1} title={t('folder_title')}>
          <Group>
            <ToggleRow
              id="folder-enabled"
              title={t('enableFolders')}
              checked={folderEnabled}
              onChange={(value) =>
                updateToggle(setFolderEnabled, StorageKeys.FOLDER_ENABLED, value)
              }
            />
            <ToggleRow
              id="folder-floating"
              title={t('enableFloatingFolderPanel')}
              checked={folderFloating}
              onChange={(value) =>
                updateToggle(setFolderFloating, StorageKeys.FOLDER_FLOATING_MODE_ENABLED, value)
              }
            />
            <ToggleRow
              id="folder-hide-archived"
              title={t('hideArchivedConversations')}
              checked={hideArchived}
              onChange={(value) =>
                updateToggle(setHideArchived, StorageKeys.FOLDER_HIDE_ARCHIVED_CONVERSATIONS, value)
              }
            />
            <ToggleRow
              id="folder-project"
              title={t('folderAsProject_enable')}
              description={t('folderAsProject_description')}
              checked={folderProjectEnabled}
              onChange={(value) =>
                updateToggle(setFolderProjectEnabled, StorageKeys.FOLDER_PROJECT_ENABLED, value)
              }
            />
            <ToggleRow
              id="folder-header-button"
              title={t('folderHeaderButton_enable')}
              description={t('folderHeaderButton_description')}
              checked={folderHeaderButtonEnabled}
              onChange={(value) =>
                updateToggle(
                  setFolderHeaderButtonEnabled,
                  StorageKeys.FOLDER_HEADER_BUTTON_ENABLED,
                  value,
                )
              }
            />
            <ToggleRow
              id="folder-below-projects"
              title={t('folderBelowProjects')}
              description={t('folderBelowProjects_description')}
              checked={folderBelowProjects}
              onChange={(value) =>
                updateToggle(setFolderBelowProjects, StorageKeys.GV_FOLDER_BELOW_PROJECTS, value)
              }
            />
            <WidthSlider
              label={t('folderSpacing')}
              value={folderSpacing}
              min={FOLDER_SPACING.min}
              max={FOLDER_SPACING.max}
              step={1}
              narrowLabel={t('folderSpacingCompact')}
              wideLabel={t('folderSpacingSpacious')}
              valueFormatter={formatPx}
              onChange={(value) => setFolderSpacing(value)}
              onChangeComplete={(value) =>
                void setSyncStorage({ [StorageKeys.GV_FOLDER_SPACING]: value })
              }
            />
            <WidthSlider
              label={t('folderTreeIndent')}
              value={folderTreeIndent}
              min={FOLDER_TREE_INDENT.min}
              max={FOLDER_TREE_INDENT.max}
              step={1}
              narrowLabel={t('folderTreeIndentCompact')}
              wideLabel={t('folderTreeIndentSpacious')}
              valueFormatter={formatPx}
              onChange={(value) => setFolderTreeIndent(value)}
              onChangeComplete={(value) =>
                void setSyncStorage({ [StorageKeys.GV_FOLDER_TREE_INDENT]: value })
              }
            />
          </Group>
        </Section>

        <Section index={2} title={t('layoutOptions')}>
          <Group>
            <WidthSlider
              label={t('chatWidth')}
              value={chatWidth}
              min={CHAT_PERCENT.min}
              max={CHAT_PERCENT.max}
              step={1}
              narrowLabel={t('chatWidthNarrow')}
              wideLabel={t('chatWidthWide')}
              onChange={setChatWidth}
              onChangeComplete={(value) => void setSyncStorage({ [StorageKeys.CHAT_WIDTH]: value })}
              enabled={chatWidthEnabled}
              onToggle={(value) =>
                updateToggle(setChatWidthEnabled, StorageKeys.CHAT_WIDTH_ENABLED, value)
              }
            />
            <WidthSlider
              label={t('chatFontSize')}
              value={chatFontSize}
              min={CHAT_FONT_SIZE.min}
              max={CHAT_FONT_SIZE.max}
              step={1}
              narrowLabel={t('chatFontSizeSmall')}
              wideLabel={t('chatFontSizeLarge')}
              onChange={setChatFontSize}
              onChangeComplete={(value) =>
                void setSyncStorage({ [StorageKeys.CHAT_FONT_SIZE]: value })
              }
              enabled={chatFontSizeEnabled}
              onToggle={(value) =>
                updateToggle(setChatFontSizeEnabled, StorageKeys.CHAT_FONT_SIZE_ENABLED, value)
              }
            />
            <WidthSlider
              label={t('codeFontSize')}
              value={codeFontSize}
              min={CODE_FONT_SIZE.min}
              max={CODE_FONT_SIZE.max}
              step={1}
              narrowLabel={t('chatFontSizeSmall')}
              wideLabel={t('chatFontSizeLarge')}
              onChange={setCodeFontSize}
              onChangeComplete={(value) =>
                void setSyncStorage({ [StorageKeys.CODE_FONT_SIZE]: value })
              }
              enabled={codeFontSizeEnabled}
              onToggle={(value) =>
                updateToggle(setCodeFontSizeEnabled, StorageKeys.CODE_FONT_SIZE_ENABLED, value)
              }
            />
            <WidthSlider
              label={t('chatLineHeight')}
              value={chatLineHeight}
              min={CHAT_LINE_HEIGHT.min}
              max={CHAT_LINE_HEIGHT.max}
              step={5}
              narrowLabel={t('chatLineHeightTight')}
              wideLabel={t('chatLineHeightLoose')}
              onChange={setChatLineHeight}
              onChangeComplete={(value) =>
                void setSyncStorage({ [StorageKeys.CHAT_LINE_HEIGHT]: value })
              }
              enabled={chatLineHeightEnabled}
              onToggle={(value) =>
                updateToggle(setChatLineHeightEnabled, StorageKeys.CHAT_LINE_HEIGHT_ENABLED, value)
              }
            />
            <WidthSlider
              label={t('chatParagraphSpacing')}
              value={chatParagraphSpacing}
              min={CHAT_PARAGRAPH_SPACING.min}
              max={CHAT_PARAGRAPH_SPACING.max}
              step={1}
              narrowLabel={t('chatParagraphSpacingCompact')}
              wideLabel={t('chatParagraphSpacingSpacious')}
              valueFormatter={formatPx}
              onChange={setChatParagraphSpacing}
              onChangeComplete={(value) =>
                void setSyncStorage({ [StorageKeys.CHAT_PARAGRAPH_SPACING]: value })
              }
              enabled={chatParagraphSpacingEnabled}
              onToggle={(value) =>
                updateToggle(
                  setChatParagraphSpacingEnabled,
                  StorageKeys.CHAT_PARAGRAPH_SPACING_ENABLED,
                  value,
                )
              }
            />
            {/* Chat font family — preset picker + optional file upload.
                Custom-imported fonts are stored in chrome.storage.local so the
                ~5 MB quota is honoured; the preset choice itself goes to
                chrome.storage.sync. See chatFontFamily/index.ts. */}
            <div className="gv-row gv-row--stack">
              <div className="gv-row__line">
                <Label
                  htmlFor="gv-font-family-select"
                  className="gv-row__title min-w-0 flex-1 cursor-pointer leading-5"
                >
                  {t('chatFontFamily')}
                </Label>
                <Switch
                  id="gv-font-family-enabled"
                  checked={fontFamilyEnabled}
                  onChange={(event) =>
                    updateToggle(
                      setFontFamilyEnabled,
                      StorageKeys.CHAT_FONT_FAMILY_ENABLED,
                      event.target.checked,
                    )
                  }
                />
              </div>
              <div className="gv-reveal" data-open={fontFamilyEnabled}>
                <div className="gv-reveal__body">
                  <div className="flex flex-col gap-2 pt-2.5">
                    <Select
                      id="gv-font-family-select"
                      value={fontFamily}
                      disabled={!fontFamilyEnabled}
                      onChange={(e) => {
                        const v = e.target.value as FontPreset;
                        setFontFamily(v);
                        void setSyncStorage({ [StorageKeys.CHAT_FONT_FAMILY]: v });
                      }}
                    >
                      <option value="default">{t('chatFontFamilyDefault')}</option>
                      <option value="claude">{t('chatFontFamilyClaude')}</option>
                      <option value="gemini">{t('chatFontFamilyGemini')}</option>
                      <option value="custom" disabled={!customFontName}>
                        {t('chatFontFamilyCustom')}
                        {customFontName
                          ? ` — ${customFontName}`
                          : ` (${t('chatFontFamilyNoneImported')})`}
                      </option>
                    </Select>
                    <p className="text-fg-3 text-xs leading-[1.45]">{t('chatFontFamilyHint')}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        ref={customFontInputRef}
                        type="file"
                        accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void handleCustomFontPicked(file);
                          // Reset so re-picking the same file fires onChange again
                          // (file inputs swallow same-file picks otherwise).
                          e.target.value = '';
                        }}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!fontFamilyEnabled}
                        onClick={() => customFontInputRef.current?.click()}
                      >
                        {t('chatFontFamilyImport')}
                      </Button>
                      {customFontName ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!fontFamilyEnabled}
                          onClick={() => void handleCustomFontClear()}
                        >
                          {t('chatFontFamilyClear')}
                        </Button>
                      ) : null}
                    </div>
                    {customFontStatus ? (
                      <p className="text-fg-3 text-xs leading-[1.45]">{customFontStatus}</p>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
            <WidthSlider
              label={t('editInputWidth')}
              value={editInputWidth}
              min={EDIT_PERCENT.min}
              max={EDIT_PERCENT.max}
              step={1}
              narrowLabel={t('chatWidthNarrow')}
              wideLabel={t('chatWidthWide')}
              onChange={setEditInputWidth}
              onChangeComplete={(value) =>
                void setSyncStorage({ [StorageKeys.EDIT_INPUT_WIDTH]: value })
              }
              enabled={editInputWidthEnabled}
              onToggle={(value) =>
                updateToggle(setEditInputWidthEnabled, StorageKeys.EDIT_INPUT_WIDTH_ENABLED, value)
              }
            />
          </Group>
          <Group>
            <ToggleRow
              id="rail-toggle"
              title={t('railToggle_enable')}
              description={t('railToggle_description')}
              checked={railToggleEnabled}
              onChange={(value) =>
                updateToggle(setRailToggleEnabled, StorageKeys.GV_RAIL_TOGGLE_ENABLED, value)
              }
            />
            <ToggleRow
              id="quota-ring"
              title={t('quotaRing_enable')}
              description={t('quotaRing_description')}
              checked={quotaRingEnabled}
              onChange={(value) =>
                updateToggle(setQuotaRingEnabled, StorageKeys.GV_QUOTA_RING_ENABLED, value)
              }
            />
          </Group>
        </Section>

        <Section index={3} title={t('inputOptions')}>
          <Group>
            <ToggleRow
              id="ctrl-enter"
              title={withModifier(t('ctrlEnterSend'))}
              description={withModifier(t('ctrlEnterSendHint'))}
              checked={ctrlEnterSend}
              onChange={(value) =>
                updateToggle(setCtrlEnterSend, StorageKeys.CTRL_ENTER_SEND, value)
              }
            />
            <ToggleRow
              id="safari-enter"
              title={t('safariEnterFix')}
              description={t('safariEnterFixHint')}
              checked={safariEnterFix}
              onChange={(value) =>
                updateToggle(setSafariEnterFix, StorageKeys.SAFARI_ENTER_FIX, value)
              }
            />
            <ToggleRow
              id="input-collapse"
              title={t('enableInputCollapse')}
              description={t('enableInputCollapseHint')}
              checked={inputCollapse}
              onChange={(value) =>
                updateToggle(setInputCollapse, StorageKeys.INPUT_COLLAPSE_ENABLED, value)
              }
            />
            <ToggleRow
              id="input-collapse-filled"
              title={t('inputCollapseWhenNotEmpty')}
              description={t('inputCollapseWhenNotEmptyHint')}
              checked={inputCollapseWhenNotEmpty}
              onChange={(value) =>
                updateToggle(
                  setInputCollapseWhenNotEmpty,
                  StorageKeys.INPUT_COLLAPSE_WHEN_NOT_EMPTY,
                  value,
                )
              }
            />
            <ToggleRow
              id="vim-mode"
              title={t('inputVimMode')}
              description={t('inputVimModeHint')}
              checked={vimMode}
              onChange={(value) => updateToggle(setVimMode, StorageKeys.INPUT_VIM_MODE, value)}
            />
            <ToggleRow
              id="plain-text-input"
              title={t('plainTextInput')}
              description={t('plainTextInputHint')}
              checked={plainTextInput}
              onChange={(value) =>
                updateToggle(setPlainTextInput, StorageKeys.PLAIN_TEXT_INPUT_ENABLED, value)
              }
            />
            <ToggleRow
              id="draft-save"
              title={t('draftAutoSave')}
              description={t('draftAutoSaveHint')}
              checked={draftAutoSave}
              onChange={(value) =>
                updateToggle(setDraftAutoSave, StorageKeys.DRAFT_AUTO_SAVE, value)
              }
            />
            <ToggleRow
              id="prevent-scroll"
              title={t('preventAutoScroll')}
              description={t('preventAutoScrollHint')}
              checked={preventAutoScroll}
              onChange={(value) =>
                updateToggle(setPreventAutoScroll, StorageKeys.PREVENT_AUTO_SCROLL_ENABLED, value)
              }
            />
            <ToggleRow
              id="quote-reply"
              title={t('quoteReply')}
              description={t('quoteReplyHint')}
              checked={quoteReply}
              onChange={(value) =>
                updateToggle(setQuoteReply, StorageKeys.QUOTE_REPLY_ENABLED, value)
              }
            />
            <ToggleRow
              id="response-complete-notification"
              title={t('responseCompleteNotification')}
              description={t('responseCompleteNotificationHint')}
              checked={responseCompleteNotification}
              onChange={(value) =>
                updateToggle(
                  setResponseCompleteNotification,
                  StorageKeys.RESPONSE_COMPLETE_NOTIFICATION_ENABLED,
                  value,
                )
              }
            />
            <ToggleRow
              id="drive-auto-allow"
              title={t('driveAutoAllow')}
              description={t('driveAutoAllowHint')}
              checked={driveAutoAllowEnabled}
              onChange={(value) =>
                updateToggle(setDriveAutoAllowEnabled, StorageKeys.DRIVE_AUTO_ALLOW_ENABLED, value)
              }
            />
          </Group>
        </Section>

        <Section index={4} title={t('markdownOptions')}>
          <Group>
            <ToggleRow
              id="mermaid"
              title={t('mermaidRendering')}
              description={t('mermaidRenderingHint')}
              checked={mermaidEnabled}
              onChange={(value) =>
                updateToggle(setMermaidEnabled, StorageKeys.MERMAID_ENABLED, value)
              }
            />
            <ToggleRow
              id="long-code-block-collapse"
              title={t('longCodeBlockCollapse')}
              description={t('longCodeBlockCollapseHint')}
              checked={longCodeBlockCollapse}
              onChange={(value) =>
                updateToggle(
                  setLongCodeBlockCollapse,
                  StorageKeys.LONG_CODE_BLOCK_COLLAPSE_ENABLED,
                  value,
                )
              }
            />
          </Group>
          <SubLabel>{t('formulaCopyFormat')}</SubLabel>
          <Group role="radiogroup" aria-label={t('formulaCopyFormat')}>
            {formulaOptions.map(([value, label]) => (
              <label key={value} className="gv-row gv-row--action">
                <input
                  type="radio"
                  name="formulaCopyFormat"
                  value={value}
                  checked={formulaCopyFormat === value}
                  onChange={() => {
                    setFormulaCopyFormat(value);
                    void setSyncStorage({ gvFormulaCopyFormat: value });
                  }}
                  className="gv-choice__input"
                />
                <span className="gv-choice__focus" aria-hidden="true" />
                <span className="gv-row__title min-w-0 flex-1">{label}</span>
                <Check className="gv-choice__check" strokeWidth={2.2} aria-hidden="true" />
              </label>
            ))}
          </Group>
          <Footnote>{t('formulaCopyFormatHint')}</Footnote>
        </Section>

        <Section index={5} title={t('appearanceOptions')}>
          <Group>
            <ToggleRow
              id="gentle-dark"
              title={t('gentleDarkMode')}
              description={t('gentleDarkModeHint')}
              checked={gentleDarkEnabled}
              onChange={(value) =>
                updateToggle(setGentleDarkEnabled, StorageKeys.GENTLE_DARK_ENABLED, value)
              }
            />
          </Group>
        </Section>

        <Section index={5} title={t('singleConvExportOptions')}>
          <Group role="radiogroup" aria-label={t('singleConvExportFormat')}>
            {singleConvExportOptions.map(([value, label, description]) => (
              <label
                key={value}
                className="gv-row gv-row--action"
                htmlFor={`single-conv-export-${value}`}
              >
                <input
                  id={`single-conv-export-${value}`}
                  type="radio"
                  name="singleConvExportFormat"
                  value={value}
                  checked={singleConvExportFormat === value}
                  onChange={() => {
                    setSingleConvExportFormat(value);
                    void setSyncStorage({ [StorageKeys.SINGLE_CONV_EXPORT_FORMAT]: value });
                  }}
                  className="gv-choice__input"
                />
                <span className="gv-choice__focus" aria-hidden="true" />
                <span className="gv-row__text">
                  <span className="gv-row__title">{label}</span>
                  <span className="gv-row__desc">{description}</span>
                </span>
                <Check className="gv-choice__check" strokeWidth={2.2} aria-hidden="true" />
              </label>
            ))}
          </Group>
          <Footnote>{t('singleConvExportFormatHint')}</Footnote>
        </Section>

        <Section index={5} title={t('promptManagerOptions')}>
          <Group>
            <ToggleRow
              id="prompt-hidden"
              title={t('hidePromptManager')}
              description={t('hidePromptManagerHint')}
              checked={promptHidden}
              onChange={(value) =>
                updateToggle(setPromptHidden, StorageKeys.HIDE_PROMPT_MANAGER, value)
              }
            />
            <ToggleRow
              id="prompt-insert"
              title={t('promptInsertOnClick')}
              description={t('promptInsertOnClickHint')}
              checked={promptInsertOnClick}
              onChange={(value) =>
                updateToggle(setPromptInsertOnClick, StorageKeys.PROMPT_INSERT_ON_CLICK, value)
              }
            />
            <div className="gv-row py-2">
              <Segmented
                value={promptViewMode}
                options={[
                  {
                    value: 'comfortable',
                    label: t('pm_view_comfortable'),
                    onSelect: () =>
                      updateToggle<PromptViewMode>(
                        setPromptViewMode,
                        StorageKeys.PROMPT_VIEW_MODE,
                        'comfortable',
                      ),
                  },
                  {
                    value: 'compact',
                    label: t('pm_view_compact'),
                    onSelect: () =>
                      updateToggle<PromptViewMode>(
                        setPromptViewMode,
                        StorageKeys.PROMPT_VIEW_MODE,
                        'compact',
                      ),
                  },
                ]}
              />
            </div>
          </Group>
          <SubLabel>{t('customWebsites')}</SubLabel>
          <Group>
            <div className="gv-row gv-row--stack gap-2">
              <div className="flex gap-2">
                <input
                  value={customWebsiteInput}
                  onChange={(event) => setCustomWebsiteInput(event.target.value)}
                  placeholder="example.com"
                  aria-label={t('customWebsites')}
                  className="gv-field flex-1"
                />
                <Button
                  type="button"
                  size="sm"
                  className="h-8 px-3.5"
                  onClick={() => void addCustomWebsite()}
                >
                  {t('pm_add')}
                </Button>
              </div>
              {customWebsiteNotice ? (
                <p className="text-fg-3 px-0.5 text-xs leading-[1.45]">{customWebsiteNotice}</p>
              ) : null}
            </div>
            {customWebsites.map((domain) => (
              <div key={domain} className="gv-row items-center py-1.5">
                <span className="text-fg min-w-0 flex-1 truncate text-[13px]">{domain}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="hover:bg-danger-soft hover:text-danger"
                  onClick={() => void removeCustomWebsite(domain)}
                >
                  {t('pm_delete')}
                </Button>
              </div>
            ))}
          </Group>
        </Section>
      </div>

      <footer className="gv-footer">
        <span className="gv-version">{extVersion ? `v${extVersion}` : 'GPT-Voyager'}</span>
        <div className="flex min-w-0 items-center gap-0.5">
          <a
            href={PROJECT_REPOSITORY_URL}
            target="_blank"
            rel="noreferrer"
            className="gv-footer-link"
          >
            <Star className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
            {t('starProject')}
          </a>
          <SupportPopover label={t('supportMysteryButton')} />
        </div>
      </footer>
    </div>
  );
}
