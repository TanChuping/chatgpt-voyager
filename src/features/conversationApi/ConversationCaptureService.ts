/**
 * Conversation walking + export pipeline.
 * Mapping-walk strategy adapted from pionxzh/chatgpt-exporter (MIT).
 * https://github.com/pionxzh/chatgpt-exporter
 */
import { walkMapping, walkMessagesPage } from './conversationParser';
import type {
  ApiConversation,
  ApiConversationPage,
  CapturePageInfo,
  LinearConversation,
  LinearMessage,
} from './types';

export interface CaptureEntry {
  /** Last raw payload: a full mapping, or (2026-09) the last page merged in. */
  api: ApiConversation | ApiConversationPage;
  linear: LinearConversation;
  capturedAt: number;
  /**
   * False while only part of a paginated conversation has been seen (the
   * oldest merged page still reports `has_previous_page`). Full mapping
   * captures are always complete.
   */
  complete: boolean;
}

interface PagedState {
  linear: LinearConversation;
  /** `has_previous_page` of the page that currently forms the head. */
  headHasPrevious: boolean;
}

function isConversationPage(raw: unknown): raw is ApiConversationPage {
  return (
    !!raw && typeof raw === 'object' && Array.isArray((raw as { messages?: unknown }).messages)
  );
}

/**
 * Splice one page into what we already hold for the conversation.
 *
 * - An older page (`before=<id>`) goes right in front of `<id>`.
 * - The latest page replaces everything from its first message on: after a
 *   new reply, an edit or a branch switch ChatGPT re-fetches it, and its tail
 *   is authoritative.
 * - A latest page that shares nothing with what we hold starts over (the
 *   branch changed below the pages we had).
 */
export function mergeConversationPage(
  existing: readonly LinearMessage[],
  incoming: readonly LinearMessage[],
  page: CapturePageInfo,
): { messages: LinearMessage[]; replacedHead: boolean } {
  if (existing.length === 0) return { messages: [...incoming], replacedHead: true };
  const incomingIds = new Set(incoming.map((m) => m.messageId));
  if (page.kind === 'before') {
    const at = page.before ? existing.findIndex((m) => m.messageId === page.before) : -1;
    const insertAt = at >= 0 ? at : 0;
    return {
      messages: [
        ...existing.slice(0, insertAt).filter((m) => !incomingIds.has(m.messageId)),
        ...incoming,
        ...existing.slice(insertAt).filter((m) => !incomingIds.has(m.messageId)),
      ],
      replacedHead: insertAt === 0,
    };
  }
  const firstId = incoming[0]?.messageId;
  const at = firstId ? existing.findIndex((m) => m.messageId === firstId) : -1;
  if (at >= 0) return { messages: [...existing.slice(0, at), ...incoming], replacedHead: at === 0 };
  return { messages: [...incoming], replacedHead: true };
}

export type CaptureListener = (convId: string, entry: CaptureEntry) => void;

/**
 * Receives the page-world `gv-conv-captured` events, normalises the payload,
 * and keeps an in-memory map for the export feature + cache primer to read.
 */
export class ConversationCaptureService {
  private readonly entries = new Map<string, CaptureEntry>();
  /**
   * User-facing records reconciled from the live ChatGPT page after the last
   * full API capture. Kept separately so an old replayed session payload
   * cannot silently erase newly appended/edited messages.
   */
  private readonly reconciledLinear = new Map<string, LinearConversation>();
  /** Merged pages per conversation (2026-09 paginated endpoints). */
  private readonly paged = new Map<string, PagedState>();
  private readonly listeners = new Set<CaptureListener>();
  private installed = false;

  install(): void {
    // Bridge from MAIN world (page hook) → ISOLATED world (this script) uses
    // `window.postMessage`, not CustomEvents. Synthetic CustomEvents do not
    // cross Chrome's MV3 world boundary even when dispatched on shared DOM
    // (document, body). `message` events from window.postMessage DO cross,
    // and we filter by our magic `__gvType` field.
    if (this.installed) return;
    this.installed = true;
    window.addEventListener('message', this.handleMessage);
    // COLD-START REPLAY: the page-world hook also stashes every capture in
    // sessionStorage. When ChatGPT's first conversation fetch fires before
    // our content script has booted, the postMessage is lost — but the
    // sessionStorage entry survives. Drain that buffer here, then clear it
    // so we don't re-ingest stale data on subsequent installs.
    this.drainSessionBuffer();
  }

  private drainSessionBuffer(): void {
    try {
      const keys: string[] = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith('gv-cap-')) keys.push(k);
      }
      for (const k of keys) {
        const raw = sessionStorage.getItem(k);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as {
            convId?: string;
            data?: unknown;
            page?: CapturePageInfo;
          };
          if (parsed && typeof parsed.convId === 'string') {
            this.ingest(parsed.convId, parsed.data, parsed.page);
          }
        } catch {
          /* malformed entry — fall through to remove */
        }
        try {
          sessionStorage.removeItem(k);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* sessionStorage unavailable — postMessage path is primary anyway */
    }
  }

  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    window.removeEventListener('message', this.handleMessage);
  }

  /** Manually feed a payload (used by tests and by direct content-script callers). */
  ingest(convId: string, raw: unknown, page?: CapturePageInfo): CaptureEntry | null {
    if (!convId) return null;
    if (isConversationPage(raw)) return this.ingestPage(convId, raw, page ?? { kind: 'latest' });
    const api = raw as ApiConversation;
    if (!api || typeof api !== 'object' || !api.mapping || !api.current_node) return null;
    let linear: LinearConversation;
    try {
      linear = walkMapping(api);
    } catch (err) {
      console.warn('[GPT-Voyager] conversation parser failed', err);
      return null;
    }
    this.paged.delete(convId);
    return this.commit(convId, api, linear, true);
  }

  private ingestPage(
    convId: string,
    api: ApiConversationPage,
    page: CapturePageInfo,
  ): CaptureEntry | null {
    let pageLinear: LinearConversation;
    try {
      pageLinear = walkMessagesPage(api);
    } catch (err) {
      console.warn('[GPT-Voyager] conversation page parser failed', err);
      return null;
    }
    const previous = this.paged.get(convId);
    const merged = mergeConversationPage(
      previous?.linear.messages ?? [],
      pageLinear.messages,
      page,
    );
    const hasPrevious = api.page_info?.has_previous_page !== false;
    const headHasPrevious = merged.replacedHead
      ? hasPrevious
      : (previous?.headHasPrevious ?? hasPrevious);
    // Older pages carry no conversation metadata; keep the latest page's.
    const meta = page.kind === 'latest' || !previous ? pageLinear : previous.linear;
    const linear: LinearConversation = {
      id: meta.id || previous?.linear.id || convId,
      title: meta.title,
      createTime: meta.createTime ?? previous?.linear.createTime ?? null,
      updateTime: meta.updateTime ?? previous?.linear.updateTime ?? null,
      messages: merged.messages,
    };
    this.paged.set(convId, { linear, headHasPrevious });
    return this.commit(convId, api, linear, !headHasPrevious);
  }

  private commit(
    convId: string,
    api: ApiConversation | ApiConversationPage,
    linear: LinearConversation,
    complete: boolean,
  ): CaptureEntry {
    const reconciled = this.reconciledLinear.get(convId);
    if (reconciled && isCaptureAtLeastAsFresh(reconciled, linear)) {
      this.reconciledLinear.delete(convId);
    }
    const effectiveLinear = this.reconciledLinear.get(convId) ?? linear;
    const entry: CaptureEntry = { api, linear: effectiveLinear, capturedAt: Date.now(), complete };
    this.entries.set(convId, entry);
    for (const cb of this.listeners) {
      try {
        cb(convId, entry);
      } catch (err) {
        console.warn('[GPT-Voyager] capture listener threw', err);
      }
    }
    return entry;
  }

  /**
   * Whether the capture for `convId` covers the whole current branch. False for
   * a paginated conversation whose older pages ChatGPT hasn't loaded yet;
   * scrolling the thread to the top makes it page them in (and us capture them).
   */
  isComplete(convId: string): boolean {
    return this.entries.get(convId)?.complete ?? false;
  }

  getLatest(convId: string): LinearConversation | null {
    return this.reconciledLinear.get(convId) ?? this.entries.get(convId)?.linear ?? null;
  }

  getEntry(convId: string): CaptureEntry | null {
    const entry = this.entries.get(convId);
    if (!entry) return null;
    const reconciled = this.reconciledLinear.get(convId);
    return reconciled ? { ...entry, linear: reconciled } : entry;
  }

  /**
   * Replace the export-facing linear snapshot after reconciling mounted live
   * messages. This does not mutate the captured raw API payload and therefore
   * cannot mislead API consumers that need the original mapping.
   */
  updateLatest(
    convId: string,
    linear: LinearConversation,
    options: { force?: boolean } = {},
  ): LinearConversation {
    const current = this.getLatest(convId);
    if (!options.force && current && isClearlyOlderLinear(linear, current)) return current;
    this.reconciledLinear.set(convId, linear);
    return linear;
  }

  on(event: 'captured', cb: CaptureListener): () => void {
    if (event !== 'captured') return () => undefined;
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Test-only: clear in-memory state. */
  reset(): void {
    this.entries.clear();
    this.paged.clear();
    this.reconciledLinear.clear();
    this.listeners.clear();
  }

  private handleMessage = (event: MessageEvent): void => {
    // We deliberately do NOT check `event.source !== window`: in Chrome MV3
    // isolated worlds, the content-script's `window` is a different object
    // from the page-world's `window`, so that check would reject every
    // legitimate hook message. We rely on the magic `__gvType` field as
    // the trust gate. Worst case if an attacker spoofs it: our parser
    // sanitises any payload that doesn't match the ApiConversation shape,
    // so they can at most pollute the in-memory capture map with garbage
    // — no XSS, no exfiltration, no privilege escalation.
    const data = event.data as
      | {
          __gvType?: string;
          payload?: { convId?: string; data?: unknown; page?: CapturePageInfo };
        }
      | undefined;
    if (!data || data.__gvType !== 'gv-conv-captured' || !data.payload) return;
    const { convId, data: convData, page } = data.payload;
    if (typeof convId !== 'string') return;
    this.ingest(convId, convData, page);
  };
}

function visibleMessageIds(linear: LinearConversation): string[] {
  return linear.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => message.messageId);
}

function isCaptureAtLeastAsFresh(
  reconciled: LinearConversation,
  candidate: LinearConversation,
): boolean {
  if (
    candidate.updateTime != null &&
    reconciled.updateTime != null &&
    candidate.updateTime > reconciled.updateTime
  ) {
    return true;
  }
  const candidateIds = new Set(visibleMessageIds(candidate));
  const requiredTail = visibleMessageIds(reconciled).slice(-5);
  return requiredTail.length > 0 && requiredTail.every((id) => candidateIds.has(id));
}

/** Candidate-first ordering: true means candidate must not replace current. */
export function isClearlyOlderLinear(
  candidate: LinearConversation,
  current: LinearConversation,
): boolean {
  if (
    candidate.updateTime != null &&
    current.updateTime != null &&
    candidate.updateTime < current.updateTime
  ) {
    return true;
  }

  const candidateIds = new Set(visibleMessageIds(candidate));
  const currentIds = visibleMessageIds(current);
  if (candidateIds.size >= currentIds.length) return false;
  return currentIds.slice(-5).some((id) => !candidateIds.has(id));
}

let singleton: ConversationCaptureService | null = null;

export function getConversationCaptureService(): ConversationCaptureService {
  if (!singleton) {
    singleton = new ConversationCaptureService();
  }
  return singleton;
}

/** Test-only: reset singleton. */
export function __resetConversationCaptureServiceForTests(): void {
  singleton = null;
}
