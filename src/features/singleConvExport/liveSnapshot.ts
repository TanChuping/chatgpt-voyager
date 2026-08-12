import type { LinearConversation, LinearMessage } from '../conversationApi/types';

export const EXPORT_TAIL_COMPARE_SIZE = 5;

export interface LiveConversationMessage {
  host: HTMLElement;
  message: LinearMessage;
  order: number;
}

export type TailReconciliationKind = 'fresh' | 'incremental' | 'rebuild';

export interface TailReconciliation {
  kind: TailReconciliationKind;
  liveTail: LiveConversationMessage[];
  changed: LiveConversationMessage[];
  unchangedAnchors: number;
  sharedIdAnchors: number;
}

const LIVE_MESSAGE_SELECTOR = '[data-message-id][data-message-author-role]';
const NON_CONTENT_SELECTOR = [
  'button',
  'script',
  'style',
  'svg',
  '[aria-hidden="true"]',
  '[data-gv-export-pick]',
  '.gv-export-pick-checkbox',
  '.gv-export-msg-selector',
].join(',');

function normalizeRole(raw: string | null): LinearMessage['role'] | null {
  const role = (raw || '').toLowerCase();
  if (role === 'user') return 'user';
  if (role === 'assistant' || role === 'model') return 'assistant';
  return null;
}

function pickContentRoot(host: HTMLElement, role: LinearMessage['role']): HTMLElement {
  const selectors =
    role === 'user'
      ? [
          '[data-message-content]',
          '.user-message-bubble-color',
          '.whitespace-pre-wrap',
          'message-content',
        ]
      : [
          '[data-message-content]',
          'message-content',
          '.markdown-main-panel',
          '.markdown',
          '.prose',
        ];

  for (const selector of selectors) {
    const candidate = host.querySelector<HTMLElement>(selector);
    if (candidate) return candidate;
  }
  return host;
}

function readContentText(host: HTMLElement, role: LinearMessage['role']): string {
  const root = pickContentRoot(host, role);
  if (!root.querySelector(NON_CONTENT_SELECTOR)) {
    return (root.textContent || '').replace(/\u00a0/g, ' ').trim();
  }
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(NON_CONTENT_SELECTOR).forEach((node) => node.remove());
  return (clone.textContent || '').replace(/\u00a0/g, ' ').trim();
}

function readCreateTime(host: HTMLElement): number | null {
  const raw =
    host.getAttribute('data-message-timestamp') ||
    host.querySelector('time')?.getAttribute('datetime') ||
    '';
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric / 1000 : numeric;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

function readOrder(host: HTMLElement, fallback: number): number {
  const turn = host.closest<HTMLElement>('[data-testid^="conversation-turn-"]');
  const testId = turn?.getAttribute('data-testid') || '';
  const match = /conversation-turn-(\d+)/i.exec(testId);
  if (match) return Number(match[1]);

  const raw =
    host.getAttribute('data-turn') ||
    turn?.getAttribute('data-turn') ||
    host.closest<HTMLElement>('[data-turn]')?.getAttribute('data-turn');
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function createLiveMessage(
  host: HTMLElement,
  fallbackOrder: number,
): LiveConversationMessage | null {
  const id = host.getAttribute('data-message-id')?.trim();
  const role = normalizeRole(host.getAttribute('data-message-author-role'));
  if (!id || !role) return null;

  const text = readContentText(host, role);
  const attachmentNames = Array.from(
    host.querySelectorAll<HTMLElement>('[data-testid*="attachment"], a[download]'),
  )
    .map((node) => node.getAttribute('download') || node.textContent || '')
    .map((name) => name.trim())
    .filter(Boolean);

  return {
    host,
    order: readOrder(host, fallbackOrder),
    message: {
      turnId: id,
      messageId: id,
      role,
      authorName: null,
      text,
      attachments: Array.from(new Set(attachmentNames)).map((name) => ({ name })),
      createTime: readCreateTime(host),
      contentType: 'text',
      channel: role === 'assistant' ? 'final' : null,
    },
  };
}

export function collectLiveConversationMessages(
  root: ParentNode = document,
): LiveConversationMessage[] {
  const byId = new Map<string, LiveConversationMessage>();
  const hosts: HTMLElement[] = [];
  if (root instanceof HTMLElement && root.matches(LIVE_MESSAGE_SELECTOR)) hosts.push(root);
  hosts.push(...Array.from(root.querySelectorAll<HTMLElement>(LIVE_MESSAGE_SELECTOR)));
  hosts.forEach((host, index) => {
    const live = createLiveMessage(host, index);
    if (!live) return;
    byId.set(live.message.messageId, live);
  });
  return Array.from(byId.values()).sort((a, b) => a.order - b.order);
}

/**
 * Canonical text used only for stale-cache comparison. ChatGPT's API contains
 * Markdown source while the DOM contains rendered text, so syntax-only
 * punctuation and whitespace cannot be treated as a modification.
 */
export function normalizeExportComparisonText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/[`*_>#~\-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function areExportMessagesEquivalent(a: LinearMessage, b: LinearMessage): boolean {
  if (a.messageId !== b.messageId || a.role !== b.role) return false;
  const aText = normalizeExportComparisonText(a.text || '');
  const bText = normalizeExportComparisonText(b.text || '');
  if (aText !== bText) return false;
  const aAttachments = a.attachments
    .map((item) => item.name)
    .sort()
    .join('\n');
  const bAttachments = b.attachments
    .map((item) => item.name)
    .sort()
    .join('\n');
  // DOM attachment labels are not guaranteed to be mounted. Only compare them
  // when both sources supplied evidence.
  return !aAttachments || !bAttachments || aAttachments === bAttachments;
}

export function reconcileExportTail(
  cached: LinearConversation | null,
  liveMessages: LiveConversationMessage[],
  tailSize = EXPORT_TAIL_COMPARE_SIZE,
): TailReconciliation {
  const liveTail = liveMessages.slice(-tailSize);
  if (!cached) {
    return {
      kind: 'rebuild',
      liveTail,
      changed: liveTail,
      unchangedAnchors: 0,
      sharedIdAnchors: 0,
    };
  }
  if (liveTail.length === 0) {
    return { kind: 'fresh', liveTail, changed: [], unchangedAnchors: 0, sharedIdAnchors: 0 };
  }

  const cachedById = new Map(cached.messages.map((message) => [message.messageId, message]));
  const changed: LiveConversationMessage[] = [];
  let unchangedAnchors = 0;
  let sharedIdAnchors = 0;
  for (const live of liveTail) {
    const cachedMessage = cachedById.get(live.message.messageId);
    if (cachedMessage) sharedIdAnchors += 1;
    if (cachedMessage && areExportMessagesEquivalent(cachedMessage, live.message)) {
      unchangedAnchors += 1;
    } else {
      changed.push(live);
    }
  }

  // Message identity is the ordering/completeness anchor. API Markdown and
  // rendered DOM text can legitimately differ (especially formula-heavy
  // replies), so a same-id text mismatch is an incremental modification, not
  // proof that the entire cached tail belongs to an obsolete branch.
  if (sharedIdAnchors === 0) {
    return { kind: 'rebuild', liveTail, changed, unchangedAnchors, sharedIdAnchors };
  }
  if (changed.length > 0) {
    return { kind: 'incremental', liveTail, changed, unchangedAnchors, sharedIdAnchors };
  }
  return { kind: 'fresh', liveTail, changed, unchangedAnchors, sharedIdAnchors };
}

function preserveRicherFields(cached: LinearMessage, live: LinearMessage): LinearMessage {
  return {
    ...live,
    turnId: cached.turnId || live.turnId,
    attachments: live.attachments.length > 0 ? live.attachments : cached.attachments,
    createTime: live.createTime ?? cached.createTime,
  };
}

/** Merge live user-facing records using nearby live IDs as ordering anchors. */
export function mergeLiveConversationMessages(
  cached: LinearConversation,
  liveMessages: LiveConversationMessage[],
): LinearConversation {
  const result = [...cached.messages];
  const sorted = [...liveMessages].sort((a, b) => a.order - b.order);

  for (let liveIndex = 0; liveIndex < sorted.length; liveIndex += 1) {
    const live = sorted[liveIndex];
    const existingIndex = result.findIndex((item) => item.messageId === live.message.messageId);
    if (existingIndex >= 0) {
      const existing = result[existingIndex];
      if (!areExportMessagesEquivalent(existing, live.message)) {
        result[existingIndex] = preserveRicherFields(existing, live.message);
      }
      continue;
    }

    let insertionIndex = -1;
    for (let previous = liveIndex - 1; previous >= 0; previous -= 1) {
      const anchorIndex = result.findIndex(
        (item) => item.messageId === sorted[previous].message.messageId,
      );
      if (anchorIndex >= 0) {
        insertionIndex = anchorIndex + 1;
        break;
      }
    }
    if (insertionIndex < 0) {
      for (let next = liveIndex + 1; next < sorted.length; next += 1) {
        const anchorIndex = result.findIndex(
          (item) => item.messageId === sorted[next].message.messageId,
        );
        if (anchorIndex >= 0) {
          insertionIndex = anchorIndex;
          break;
        }
      }
    }
    if (insertionIndex < 0) insertionIndex = result.length;
    result.splice(insertionIndex, 0, live.message);
  }

  return { ...cached, messages: result };
}

export function rebuildConversationFromLive(
  cached: LinearConversation | null,
  convId: string,
  title: string,
  liveMessages: LiveConversationMessage[],
): LinearConversation {
  const messages = [...liveMessages].sort((a, b) => a.order - b.order).map((item) => item.message);
  const times = messages
    .map((message) => message.createTime)
    .filter((value): value is number => value != null && Number.isFinite(value));
  return {
    id: cached?.id || convId,
    title: cached?.title || title || 'Untitled conversation',
    createTime: cached?.createTime ?? (times.length > 0 ? Math.min(...times) : null),
    updateTime: cached?.updateTime ?? (times.length > 0 ? Math.max(...times) : null),
    messages,
  };
}
