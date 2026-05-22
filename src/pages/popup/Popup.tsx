import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import browser from 'webextension-polyfill';

import { PROJECT_REPOSITORY_URL } from '@/core/constants/project';
import {
  DEFAULT_SINGLE_CONV_EXPORT_FORMAT,
  isSingleConvExportFormat,
  type SingleConvExportFormat,
} from '@/features/singleConvExport';
import {
  DEFAULT_SUPPORT_GOAL,
  SUPPORT_GOAL_REFRESH_MS,
  type SupportGoalData,
  formatSupportAmount,
  getSupportGoalProgress,
  loadSupportGoal,
} from '@/core/services/SupportGoalService';
import { StorageKeys } from '@/core/types/common';

import { DarkModeToggle } from '../../components/DarkModeToggle';
import { LanguageSwitcher } from '../../components/LanguageSwitcher';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardTitle } from '../../components/ui/card';
import { Label } from '../../components/ui/label';
import { Switch } from '../../components/ui/switch';
import { useLanguage } from '../../contexts/LanguageContext';
import { StarredHistory } from './components/StarredHistory';
import WidthSlider from './components/WidthSlider';

type ScrollMode = 'jump' | 'flow';
type FormulaCopyFormat = 'latex' | 'unicodemath' | 'no-dollar' | 'notion';
type PromptViewMode = 'compact' | 'comfortable';

const LEGACY_BASELINE_PX = 1200;
const CHAT_PERCENT = { min: 30, max: 100, defaultValue: 70 };
const CHAT_FONT_SIZE = { min: 80, max: 150, defaultValue: 100 };
const CODE_FONT_SIZE = { min: 80, max: 150, defaultValue: 100 };
const EDIT_PERCENT = { min: 30, max: 100, defaultValue: 60 };
const SIDEBAR_PX = { min: 240, max: 600, defaultValue: 280 };
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
    <div className="flex items-start justify-between gap-4 py-2">
      <Label htmlFor={id} className="flex-1 cursor-pointer">
        <span className="text-sm font-medium">{title}</span>
        {description ? <p className="text-muted-foreground mt-1 text-xs">{description}</p> : null}
      </Label>
      <Switch id={id} checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <CardTitle className="mb-3">{title}</CardTitle>
      <CardContent className="space-y-2 p-0">{children}</CardContent>
    </Card>
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
        className="hover:text-primary font-semibold transition-colors"
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
          className="bg-popover text-popover-foreground border-border absolute right-0 bottom-6 z-50 w-80 rounded-lg border p-4 text-left shadow-xl"
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
            <p className="text-sm font-bold">{goal.title}</p>
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{goal.description}</p>
          </div>
          {goal.imageUrl ? (
            <img
              src={goal.imageUrl}
              alt={goal.title}
              className="border-border bg-muted mb-3 max-h-36 w-full rounded-md border object-cover"
            />
          ) : null}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold">
              <span>
                {formatSupportAmount(goal.current, goal.currency)} /{' '}
                {formatSupportAmount(goal.target, goal.currency)}
              </span>
              <span>{progress}%</span>
            </div>
            <div className="bg-muted h-2 overflow-hidden rounded-full">
              <div
                className="bg-primary h-full rounded-full transition-[width]"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
          <div className="mt-4 grid gap-3">
            <a
              href={goal.kofiUrl}
              target="_blank"
              rel="noreferrer"
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center justify-center rounded-md px-3 text-xs font-bold transition-colors"
            >
              Ko-fi
            </a>
          </div>
          {goal.wechatQrUrl || goal.alipayQrUrl ? (
            <div className="mt-3 grid grid-cols-2 gap-3">
              {goal.wechatQrUrl ? (
                <div className="border-border bg-muted/40 text-muted-foreground flex flex-col items-center justify-center overflow-hidden rounded-md border text-center text-[11px] leading-tight">
                  <img
                    src={goal.wechatQrUrl}
                    alt="WeChat QR"
                    className="aspect-square w-full object-cover"
                  />
                  <span className="py-1">微信</span>
                </div>
              ) : null}
              {goal.alipayQrUrl ? (
                <div className="border-border bg-muted/40 text-muted-foreground flex flex-col items-center justify-center overflow-hidden rounded-md border text-center text-[11px] leading-tight">
                  <img
                    src={goal.alipayQrUrl}
                    alt="Alipay QR"
                    className="aspect-square w-full object-cover"
                  />
                  <span className="py-1">支付宝</span>
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
  const [folderSpacing, setFolderSpacing] = useState(FOLDER_SPACING.defaultValue);
  const [folderTreeIndent, setFolderTreeIndent] = useState(FOLDER_TREE_INDENT.defaultValue);

  const [chatWidthEnabled, setChatWidthEnabled] = useState(false);
  const [chatWidth, setChatWidth] = useState(CHAT_PERCENT.defaultValue);
  const [chatFontSizeEnabled, setChatFontSizeEnabled] = useState(false);
  const [chatFontSize, setChatFontSize] = useState(CHAT_FONT_SIZE.defaultValue);
  const [codeFontSizeEnabled, setCodeFontSizeEnabled] = useState(false);
  const [codeFontSize, setCodeFontSize] = useState(CODE_FONT_SIZE.defaultValue);
  const [editInputWidthEnabled, setEditInputWidthEnabled] = useState(false);
  const [editInputWidth, setEditInputWidth] = useState(EDIT_PERCENT.defaultValue);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_PX.defaultValue);
  const [sidebarAutoHide, setSidebarAutoHide] = useState(false);
  const [sidebarFullHide, setSidebarFullHide] = useState(false);

  const [ctrlEnterSend, setCtrlEnterSend] = useState(false);
  const [safariEnterFix, setSafariEnterFix] = useState(false);
  const [inputCollapse, setInputCollapse] = useState(false);
  const [inputCollapseWhenNotEmpty, setInputCollapseWhenNotEmpty] = useState(false);
  const [vimMode, setVimMode] = useState(false);
  const [draftAutoSave, setDraftAutoSave] = useState(false);
  const [preventAutoScroll, setPreventAutoScroll] = useState(false);
  const [quoteReply, setQuoteReply] = useState(true);

  const [formulaCopyFormat, setFormulaCopyFormat] = useState<FormulaCopyFormat>('latex');
  const [singleConvExportFormat, setSingleConvExportFormat] = useState<SingleConvExportFormat>(
    DEFAULT_SINGLE_CONV_EXPORT_FORMAT,
  );
  const [mermaidEnabled, setMermaidEnabled] = useState(true);
  const [promptHidden, setPromptHidden] = useState(false);
  const [promptInsertOnClick, setPromptInsertOnClick] = useState(false);
  const [promptViewMode, setPromptViewMode] = useState<PromptViewMode>('comfortable');
  const [customWebsites, setCustomWebsites] = useState<string[]>([]);
  const [customWebsiteInput, setCustomWebsiteInput] = useState('');
  const [customWebsiteNotice, setCustomWebsiteNotice] = useState('');

  const setSyncStorage = useCallback(async (items: Record<string, unknown>) => {
    await browser.storage.sync.set(items);
  }, []);

  useEffect(() => {
    try {
      setExtVersion(chrome?.runtime?.getManifest?.()?.version ?? '');
    } catch {
      setExtVersion('');
    }

    void browser.storage.sync
      .get({
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
        [StorageKeys.GV_FOLDER_SPACING]: FOLDER_SPACING.defaultValue,
        [StorageKeys.GV_FOLDER_TREE_INDENT]: FOLDER_TREE_INDENT.defaultValue,
        [StorageKeys.CHAT_WIDTH_ENABLED]: false,
        [StorageKeys.CHAT_WIDTH]: CHAT_PERCENT.defaultValue,
        [StorageKeys.CHAT_FONT_SIZE_ENABLED]: false,
        [StorageKeys.CHAT_FONT_SIZE]: CHAT_FONT_SIZE.defaultValue,
        [StorageKeys.CODE_FONT_SIZE_ENABLED]: false,
        [StorageKeys.CODE_FONT_SIZE]: CODE_FONT_SIZE.defaultValue,
        [StorageKeys.EDIT_INPUT_WIDTH_ENABLED]: false,
        [StorageKeys.EDIT_INPUT_WIDTH]: EDIT_PERCENT.defaultValue,
        [StorageKeys.SIDEBAR_WIDTH]: SIDEBAR_PX.defaultValue,
        [StorageKeys.GV_SIDEBAR_AUTO_HIDE]: false,
        [StorageKeys.GV_SIDEBAR_FULL_HIDE]: false,
        [StorageKeys.CTRL_ENTER_SEND]: false,
        [StorageKeys.SAFARI_ENTER_FIX]: false,
        [StorageKeys.INPUT_COLLAPSE_ENABLED]: false,
        [StorageKeys.INPUT_COLLAPSE_WHEN_NOT_EMPTY]: false,
        [StorageKeys.INPUT_VIM_MODE]: false,
        [StorageKeys.DRAFT_AUTO_SAVE]: false,
        [StorageKeys.PREVENT_AUTO_SCROLL_ENABLED]: false,
        [StorageKeys.QUOTE_REPLY_ENABLED]: true,
        gvFormulaCopyFormat: 'latex',
        [StorageKeys.MERMAID_ENABLED]: true,
        [StorageKeys.HIDE_PROMPT_MANAGER]: false,
        [StorageKeys.PROMPT_INSERT_ON_CLICK]: false,
        [StorageKeys.PROMPT_VIEW_MODE]: 'comfortable',
        [StorageKeys.PROMPT_CUSTOM_WEBSITES]: [],
        [StorageKeys.SINGLE_CONV_EXPORT_FORMAT]: DEFAULT_SINGLE_CONV_EXPORT_FORMAT,
      })
      .then((result) => {
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
        setEditInputWidthEnabled(result[StorageKeys.EDIT_INPUT_WIDTH_ENABLED] === true);
        setEditInputWidth(
          normalizePercent(
            result[StorageKeys.EDIT_INPUT_WIDTH],
            EDIT_PERCENT.defaultValue,
            EDIT_PERCENT.min,
            EDIT_PERCENT.max,
          ),
        );
        setSidebarWidth(
          normalizeNumber(
            result[StorageKeys.SIDEBAR_WIDTH],
            SIDEBAR_PX.defaultValue,
            SIDEBAR_PX.min,
            SIDEBAR_PX.max,
          ),
        );
        setSidebarAutoHide(result[StorageKeys.GV_SIDEBAR_AUTO_HIDE] === true);
        setSidebarFullHide(result[StorageKeys.GV_SIDEBAR_FULL_HIDE] === true);
        setCtrlEnterSend(result[StorageKeys.CTRL_ENTER_SEND] === true);
        setSafariEnterFix(result[StorageKeys.SAFARI_ENTER_FIX] === true);
        setInputCollapse(result[StorageKeys.INPUT_COLLAPSE_ENABLED] === true);
        setInputCollapseWhenNotEmpty(result[StorageKeys.INPUT_COLLAPSE_WHEN_NOT_EMPTY] === true);
        setVimMode(result[StorageKeys.INPUT_VIM_MODE] === true);
        setDraftAutoSave(result[StorageKeys.DRAFT_AUTO_SAVE] === true);
        setPreventAutoScroll(result[StorageKeys.PREVENT_AUTO_SCROLL_ENABLED] === true);
        setQuoteReply(result[StorageKeys.QUOTE_REPLY_ENABLED] !== false);
        const formula = result.gvFormulaCopyFormat;
        setFormulaCopyFormat(
          formula === 'unicodemath' ||
            formula === 'no-dollar' ||
            formula === 'notion' ||
            formula === 'latex'
            ? formula
            : 'latex',
        );
        setMermaidEnabled(result[StorageKeys.MERMAID_ENABLED] !== false);
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

  if (showStarredHistory) {
    return <StarredHistory onClose={() => setShowStarredHistory(false)} />;
  }

  return (
    <div className="bg-background text-foreground w-[360px]">
      <div className="border-border/50 flex items-center justify-between border-b px-5 py-5">
        <h1 className="text-primary text-2xl font-extrabold tracking-tight">{t('extName')}</h1>
        <div className="flex items-center gap-1">
          <DarkModeToggle />
          <LanguageSwitcher />
        </div>
      </div>

      <div className="flex flex-col gap-4 p-5">
        <Section title={t('timelineOptions')}>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={timelineMode === 'flow' ? 'default' : 'outline'}
              size="sm"
              onClick={() =>
                updateToggle<ScrollMode>(setTimelineMode, StorageKeys.TIMELINE_SCROLL_MODE, 'flow')
              }
            >
              {t('flow')}
            </Button>
            <Button
              type="button"
              variant={timelineMode === 'jump' ? 'default' : 'outline'}
              size="sm"
              onClick={() =>
                updateToggle<ScrollMode>(setTimelineMode, StorageKeys.TIMELINE_SCROLL_MODE, 'jump')
              }
            >
              {t('jump')}
            </Button>
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
          <div className="flex gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void setSyncStorage({ [StorageKeys.TIMELINE_POSITION]: null })}
            >
              {t('resetTimelinePosition')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowStarredHistory(true)}
            >
              {t('viewStarredHistory')}
            </Button>
          </div>
        </Section>

        <Section title={t('folder_title')}>
          <ToggleRow
            id="folder-enabled"
            title={t('enableFolders')}
            checked={folderEnabled}
            onChange={(value) => updateToggle(setFolderEnabled, StorageKeys.FOLDER_ENABLED, value)}
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
          <WidthSlider
            label={t('folderSpacing')}
            value={folderSpacing}
            min={FOLDER_SPACING.min}
            max={FOLDER_SPACING.max}
            step={1}
            narrowLabel={t('folderSpacingCompact')}
            wideLabel={t('folderSpacingSpacious')}
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
            onChange={(value) => setFolderTreeIndent(value)}
            onChangeComplete={(value) =>
              void setSyncStorage({ [StorageKeys.GV_FOLDER_TREE_INDENT]: value })
            }
          />
        </Section>

        <Section title={t('layoutOptions')}>
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
          <WidthSlider
            label={t('sidebarWidth')}
            value={sidebarWidth}
            min={SIDEBAR_PX.min}
            max={SIDEBAR_PX.max}
            step={1}
            valueFormatter={(value) => `${value}px`}
            narrowLabel={t('sidebarWidthNarrow')}
            wideLabel={t('sidebarWidthWide')}
            onChange={setSidebarWidth}
            onChangeComplete={(value) =>
              void setSyncStorage({ [StorageKeys.SIDEBAR_WIDTH]: value })
            }
          />
          <ToggleRow
            id="sidebar-auto-hide"
            title={t('sidebarAutoHide')}
            description={t('sidebarAutoHideHint')}
            checked={sidebarAutoHide}
            onChange={(value) =>
              updateToggle(setSidebarAutoHide, StorageKeys.GV_SIDEBAR_AUTO_HIDE, value)
            }
          />
          <ToggleRow
            id="sidebar-full-hide"
            title={t('sidebarFullHide')}
            description={t('sidebarFullHideHint')}
            checked={sidebarFullHide}
            onChange={(value) =>
              updateToggle(setSidebarFullHide, StorageKeys.GV_SIDEBAR_FULL_HIDE, value)
            }
          />
        </Section>

        <Section title={t('inputOptions')}>
          <ToggleRow
            id="ctrl-enter"
            title={t('ctrlEnterSend')}
            description={t('ctrlEnterSendHint')}
            checked={ctrlEnterSend}
            onChange={(value) => updateToggle(setCtrlEnterSend, StorageKeys.CTRL_ENTER_SEND, value)}
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
            id="draft-save"
            title={t('draftAutoSave')}
            description={t('draftAutoSaveHint')}
            checked={draftAutoSave}
            onChange={(value) => updateToggle(setDraftAutoSave, StorageKeys.DRAFT_AUTO_SAVE, value)}
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
        </Section>

        <Section title={t('markdownOptions')}>
          <ToggleRow
            id="mermaid"
            title={t('mermaidRendering')}
            description={t('mermaidRenderingHint')}
            checked={mermaidEnabled}
            onChange={(value) =>
              updateToggle(setMermaidEnabled, StorageKeys.MERMAID_ENABLED, value)
            }
          />
          <div className="space-y-2 pt-2">
            <Label className="text-sm font-medium">{t('formulaCopyFormat')}</Label>
            <p className="text-muted-foreground text-xs">{t('formulaCopyFormatHint')}</p>
            {formulaOptions.map(([value, label]) => (
              <label key={value} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="formulaCopyFormat"
                  value={value}
                  checked={formulaCopyFormat === value}
                  onChange={() => {
                    setFormulaCopyFormat(value);
                    void setSyncStorage({ gvFormulaCopyFormat: value });
                  }}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </Section>

        <Section title={t('singleConvExportOptions')}>
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('singleConvExportFormat')}</Label>
            <p className="text-muted-foreground text-xs">{t('singleConvExportFormatHint')}</p>
            {singleConvExportOptions.map(([value, label, description]) => (
              <label
                key={value}
                className="flex cursor-pointer items-start gap-2 text-sm"
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
                  className="mt-1"
                />
                <span className="flex flex-col">
                  <span>{label}</span>
                  <span className="text-muted-foreground text-xs">{description}</span>
                </span>
              </label>
            ))}
          </div>
        </Section>

        <Section title={t('promptManagerOptions')}>
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
          <div className="flex gap-2">
            <Button
              type="button"
              variant={promptViewMode === 'comfortable' ? 'default' : 'outline'}
              size="sm"
              onClick={() =>
                updateToggle<PromptViewMode>(
                  setPromptViewMode,
                  StorageKeys.PROMPT_VIEW_MODE,
                  'comfortable',
                )
              }
            >
              {t('pm_view_comfortable')}
            </Button>
            <Button
              type="button"
              variant={promptViewMode === 'compact' ? 'default' : 'outline'}
              size="sm"
              onClick={() =>
                updateToggle<PromptViewMode>(
                  setPromptViewMode,
                  StorageKeys.PROMPT_VIEW_MODE,
                  'compact',
                )
              }
            >
              {t('pm_view_compact')}
            </Button>
          </div>
          <div className="space-y-2 pt-2">
            <Label className="text-sm font-medium">{t('customWebsites')}</Label>
            <div className="flex gap-2">
              <input
                value={customWebsiteInput}
                onChange={(event) => setCustomWebsiteInput(event.target.value)}
                placeholder="example.com"
                className="border-input bg-background flex-1 rounded-md border px-3 py-2 text-sm"
              />
              <Button type="button" size="sm" onClick={() => void addCustomWebsite()}>
                {t('pm_add')}
              </Button>
            </div>
            {customWebsiteNotice ? (
              <p className="text-muted-foreground text-xs">{customWebsiteNotice}</p>
            ) : null}
            <div className="space-y-1">
              {customWebsites.map((domain) => (
                <div
                  key={domain}
                  className="flex items-center justify-between rounded-md border px-2 py-1 text-sm"
                >
                  <span>{domain}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void removeCustomWebsite(domain)}
                  >
                    {t('pm_delete')}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </Section>
      </div>

      <div className="text-muted-foreground border-border/50 flex items-center justify-center gap-3 border-t px-5 py-3 text-center text-xs">
        <span>{extVersion ? `v${extVersion}` : 'GPT-Voyager'}</span>
        <a
          href={PROJECT_REPOSITORY_URL}
          target="_blank"
          rel="noreferrer"
          className="hover:text-primary font-semibold transition-colors"
        >
          {t('starProject')}
        </a>
        <SupportPopover label={t('supportMysteryButton')} />
      </div>
    </div>
  );
}
