/**
 * Conversation walking + export pipeline.
 * Mapping-walk strategy adapted from pionxzh/chatgpt-exporter (MIT).
 * https://github.com/pionxzh/chatgpt-exporter
 */
import {
  getConversationCaptureService,
  type ConversationCaptureService,
} from '../conversationApi/ConversationCaptureService';
import type { LinearConversation } from '../conversationApi/types';
import { downloadBlob } from './downloadFile';
import { toHtml } from './HtmlExporter';
import { toJson } from './JsonExporter';
import { toJsonSimple } from './JsonSimpleExporter';
import { toMarkdown } from './MarkdownExporter';
import { toMarkdownSimple } from './MarkdownSimpleExporter';

/**
 * Output formats the top-bar button can emit.
 *
 *  - `markdown`        : standard, lossless markdown (the 1.6.0 default).
 *                        Includes Code Interpreter blocks, tool outputs and
 *                        commentary-channel narration verbatim.
 *  - `markdown-simple` : user input + final assistant text + timestamps only.
 *  - `json`            : standard, full linear JSON (also from 1.6.0).
 *  - `json-simple`     : 3-field JSON (role/text/createTime + attachments).
 *  - `html`            : single self-contained HTML transcript, simplified.
 *
 * Keep the list in sync with the popup radio group and with `formatLinear`.
 */
export type SingleConvExportFormat =
  | 'markdown'
  | 'markdown-simple'
  | 'json'
  | 'json-simple'
  | 'html';

/** Default when the user hasn't picked one (matches pre-1.7 behaviour). */
export const DEFAULT_SINGLE_CONV_EXPORT_FORMAT: SingleConvExportFormat = 'markdown';

/**
 * Allow-list check used at the storage boundary — chrome.storage.sync can
 * hand us anything if a future build wrote a value we no longer recognise.
 */
export function isSingleConvExportFormat(value: unknown): value is SingleConvExportFormat {
  return (
    value === 'markdown' ||
    value === 'markdown-simple' ||
    value === 'json' ||
    value === 'json-simple' ||
    value === 'html'
  );
}

const SESSION_KEY = 'gv-pending-single-export';
const PENDING_RESUME_TIMEOUT_MS = 15000;

interface PendingExport {
  convId: string;
  format: SingleConvExportFormat;
  storedAt: number;
}

function slugifyTitle(title: string, fallback: string): string {
  const t = (title || '').trim();
  if (!t) return fallback;
  // Replace anything that isn't word / digit / dash / Han / Hiragana / Katakana / Hangul with a dash.
  const cleaned = t
    .replace(/[^\p{L}\p{N}\s\-_]+/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function todayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function extensionFor(format: SingleConvExportFormat): 'md' | 'json' | 'html' {
  switch (format) {
    case 'markdown':
    case 'markdown-simple':
      return 'md';
    case 'json':
    case 'json-simple':
      return 'json';
    case 'html':
      return 'html';
  }
}

export function buildFilename(linear: LinearConversation, format: SingleConvExportFormat): string {
  const ext = extensionFor(format);
  const slug = slugifyTitle(linear.title, linear.id || 'conversation');
  return `chatgpt-${slug}-${todayStamp()}.${ext}`;
}

function formatLinear(
  linear: LinearConversation,
  format: SingleConvExportFormat,
): { body: string; mime: string } {
  switch (format) {
    case 'markdown':
      return { body: toMarkdown(linear), mime: 'text/markdown' };
    case 'markdown-simple':
      return { body: toMarkdownSimple(linear), mime: 'text/markdown' };
    case 'json':
      return { body: toJson(linear), mime: 'application/json' };
    case 'json-simple':
      return { body: toJsonSimple(linear), mime: 'application/json' };
    case 'html':
      return { body: toHtml(linear), mime: 'text/html' };
  }
}

function performExport(linear: LinearConversation, format: SingleConvExportFormat): void {
  const { body, mime } = formatLinear(linear, format);
  const filename = buildFilename(linear, format);
  downloadBlob(body, filename, mime);
}

function readPending(): PendingExport | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingExport>;
    if (!parsed || typeof parsed.convId !== 'string' || typeof parsed.format !== 'string') return null;
    if (parsed.format !== 'markdown' && parsed.format !== 'json') return null;
    return {
      convId: parsed.convId,
      format: parsed.format,
      storedAt: typeof parsed.storedAt === 'number' ? parsed.storedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function clearPending(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

function writePending(pending: PendingExport): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(pending));
  } catch {
    /* ignore */
  }
}

function currentConvIdFromUrl(): string | null {
  const m = /\/c\/([a-f0-9-]{36})/i.exec(window.location.pathname);
  return m ? m[1] : null;
}

export interface ExportConversationOptions {
  /** Override capture service (for tests). */
  captureService?: ConversationCaptureService;
}

/**
 * Export a conversation to disk. If the conversation is already captured
 * (e.g. the user opened it this session), the download fires immediately.
 * Otherwise we stash the user's intent and navigate, expecting the page-world
 * fetch hook to capture data on arrival; `resumePendingExport` finishes the job.
 */
export function exportConversation(
  convId: string,
  format: SingleConvExportFormat,
  options: ExportConversationOptions = {},
): boolean {
  const svc = options.captureService ?? getConversationCaptureService();
  const linear = svc.getLatest(convId);
  if (linear) {
    performExport(linear, format);
    return true;
  }
  // Not yet captured. Store intent and navigate to the conversation.
  writePending({ convId, format, storedAt: Date.now() });
  const target = `/c/${convId}`;
  if (window.location.pathname === target) {
    // Already on the page but capture hasn't happened yet — wait via the
    // resume hook (which polls captures on this page load).
    armResumeWaiter(convId, format);
    return false;
  }
  window.location.href = target;
  return false;
}

let resumeArmed = false;
function armResumeWaiter(convId: string, format: SingleConvExportFormat): void {
  if (resumeArmed) return;
  resumeArmed = true;
  const svc = getConversationCaptureService();
  const start = Date.now();
  const off = svc.on('captured', (capturedId, entry) => {
    if (capturedId !== convId) return;
    off();
    resumeArmed = false;
    clearPending();
    performExport(entry.linear, format);
  });
  const stopTimer = window.setTimeout(() => {
    off();
    resumeArmed = false;
    if (Date.now() - start >= PENDING_RESUME_TIMEOUT_MS) {
      clearPending();
      console.warn('[GPT-Voyager] export: capture timed out for', convId);
    }
    window.clearTimeout(stopTimer);
  }, PENDING_RESUME_TIMEOUT_MS);
}

/**
 * Top-level check called from the conversationExport bootstrap. If we landed
 * on /c/<id> with a pending intent that matches, wait for capture then export.
 */
export function resumePendingExport(): void {
  const pending = readPending();
  if (!pending) return;
  // Stale (older than ~5 minutes) — drop.
  if (Date.now() - pending.storedAt > 5 * 60 * 1000) {
    clearPending();
    return;
  }
  const cur = currentConvIdFromUrl();
  if (!cur || cur !== pending.convId) return;
  // If already captured by the time we got here, fire immediately.
  const svc = getConversationCaptureService();
  const linear = svc.getLatest(pending.convId);
  if (linear) {
    clearPending();
    performExport(linear, pending.format);
    return;
  }
  armResumeWaiter(pending.convId, pending.format);
}
