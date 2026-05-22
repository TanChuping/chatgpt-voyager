/**
 * Simplified JSON exporter.
 *
 * Three fields per message: role, text, timestamp. We keep attachments
 * alongside user messages because users frequently report wanting the
 * "what did I attach when I asked X" pair preserved together, but we
 * drop turnId/messageId/contentType/channel — those are internals of
 * our pipeline, not part of the conversation as the user sees it.
 *
 * Shape (stable; if you add a field, bump `v`):
 *
 *   {
 *     "v": 1,
 *     "title": "...",
 *     "createTime": "2026-05-22T...Z" | null,
 *     "messages": [
 *       {
 *         "role": "user" | "assistant",
 *         "text": "...",
 *         "createTime": "2026-05-22T...Z" | null,
 *         "attachments": [{ "name": "...", "mimeType": "..." }]  // optional
 *       }
 *     ]
 *   }
 *
 * Timestamps are ISO strings, not epoch seconds. The whole point of the
 * simplified format is "human + downstream-tool friendly"; epoch ints
 * fail that bar.
 */
import type { LinearAttachment, LinearConversation } from '../conversationApi/types';
import { filterForSimple } from './simpleFilter';

interface SimpleAttachment {
  name: string;
  mimeType?: string;
}

interface SimpleMessage {
  role: 'user' | 'assistant';
  text: string;
  createTime: string | null;
  attachments?: SimpleAttachment[];
}

interface SimpleConversation {
  v: 1;
  title: string;
  createTime: string | null;
  messages: SimpleMessage[];
}

function isoOrNull(epochSeconds: number | null | undefined): string | null {
  if (epochSeconds == null || !Number.isFinite(epochSeconds)) return null;
  try {
    return new Date(epochSeconds * 1000).toISOString();
  } catch {
    return null;
  }
}

function shapeAttachments(attachments: LinearAttachment[]): SimpleAttachment[] | undefined {
  if (!attachments.length) return undefined;
  return attachments.map((a) => (a.mimeType ? { name: a.name, mimeType: a.mimeType } : { name: a.name }));
}

export function toJsonSimple(linear: LinearConversation): string {
  const filtered = filterForSimple(linear);
  const out: SimpleConversation = {
    v: 1,
    title: filtered.title || 'Untitled conversation',
    createTime: isoOrNull(filtered.createTime),
    messages: filtered.messages
      .filter((m): m is typeof m & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
      .map((m) => {
        const msg: SimpleMessage = {
          role: m.role,
          text: m.text,
          createTime: isoOrNull(m.createTime),
        };
        const attach = shapeAttachments(m.attachments);
        if (attach) msg.attachments = attach;
        return msg;
      }),
  };
  return JSON.stringify(out, null, 2) + '\n';
}
