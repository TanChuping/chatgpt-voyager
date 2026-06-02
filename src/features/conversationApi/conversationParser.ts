/**
 * Conversation walking + export pipeline.
 * Mapping-walk strategy adapted from pionxzh/chatgpt-exporter (MIT).
 * https://github.com/pionxzh/chatgpt-exporter
 */
import type {
  ApiAttachment,
  ApiContent,
  ApiConversation,
  ConversationNode,
  ConversationNodeMessage,
  LinearAttachment,
  LinearConversation,
  LinearMessage,
} from './types';
import { withTurnIdPrefix } from './types';

/** Walk the mapping from current_node back to root via parent pointers, then reverse. */
function walkChain(api: ApiConversation): ConversationNodeMessage[] {
  const result: ConversationNodeMessage[] = [];
  const mapping: Record<string, ConversationNode> = api.mapping || {};
  let cursor: string | null | undefined = api.current_node;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node: ConversationNode | undefined = mapping[cursor];
    if (!node) break;
    if (node.message) result.push(node.message);
    cursor = node.parent ?? null;
  }
  return result.reverse();
}

function isHidden(message: ConversationNodeMessage): boolean {
  if (!message.content) return true;
  const meta = message.metadata;
  if (meta?.is_visually_hidden_from_conversation === true) return true;
  return false;
}

function asString(x: unknown): string {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'number' || typeof x === 'boolean') return String(x);
  return '';
}

/**
 * Pull readable text out of a single `content` block. Mirrors pionxzh's
 * branching by content_type, but we additionally wrap `code` and
 * `execution_output` blocks in fenced markdown so they survive in the export
 * unchanged.
 */
export function renderContent(content: ApiContent): string {
  if (!content || typeof content !== 'object') return '';
  const t = String(content.content_type || '').toLowerCase();

  switch (t) {
    case 'text': {
      const parts = Array.isArray(content.parts) ? content.parts : [];
      return parts.map(asString).filter(Boolean).join('\n\n');
    }
    case 'multimodal_text': {
      // parts is an array of either strings or {content_type, text|asset_pointer|...}
      const parts = Array.isArray(content.parts) ? content.parts : [];
      const out: string[] = [];
      for (const p of parts) {
        if (typeof p === 'string') {
          if (p) out.push(p);
          continue;
        }
        if (p && typeof p === 'object') {
          const inner = p as Record<string, unknown>;
          if (typeof inner.text === 'string' && inner.text.length > 0) {
            out.push(inner.text);
          } else if (
            typeof inner.content_type === 'string' &&
            inner.content_type === 'image_asset_pointer'
          ) {
            // Skip — we don't have a stable URL outside ChatGPT's signed CDN.
          }
        }
      }
      return out.join('\n\n');
    }
    case 'code': {
      const lang =
        typeof content.language === 'string' && content.language.toLowerCase() !== 'unknown'
          ? content.language
          : '';
      const code =
        typeof content.text === 'string'
          ? content.text
          : Array.isArray(content.parts)
            ? content.parts.map(asString).join('\n')
            : '';
      if (!code) return '';
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }
    case 'execution_output': {
      const text =
        typeof content.text === 'string'
          ? content.text
          : Array.isArray(content.parts)
            ? content.parts.map(asString).join('\n')
            : '';
      if (!text) return '';
      return `\`\`\`\n${text}\n\`\`\``;
    }
    case 'tether_quote':
    case 'tether_browsing_display': {
      return asString(content.text) || '';
    }
    case 'system_error':
    case 'model_editable_context':
    case 'user_editable_context': {
      // Rare maintenance messages; treat as plain text best-effort
      return asString(content.text);
    }
    default: {
      if (typeof content.text === 'string') return content.text;
      if (Array.isArray(content.parts))
        return content.parts.map(asString).filter(Boolean).join('\n\n');
      return '';
    }
  }
}

function normalizeRole(raw: string | undefined): LinearMessage['role'] {
  const r = (raw || '').toLowerCase();
  if (r === 'user' || r === 'assistant' || r === 'system' || r === 'tool') return r;
  return 'tool';
}

function pickAttachments(message: ConversationNodeMessage): LinearAttachment[] {
  const raw = message.metadata?.attachments;
  if (!Array.isArray(raw)) return [];
  const out: LinearAttachment[] = [];
  const seen = new Set<string>();
  for (const a of raw as ApiAttachment[]) {
    const name = typeof a?.name === 'string' ? a.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      mimeType: typeof a.mimeType === 'string' ? a.mimeType : a.mime_type,
    });
  }
  return out;
}

/**
 * Walk the API mapping and produce the linear conversation we export from.
 */
export function walkMapping(api: ApiConversation): LinearConversation {
  const chain = walkChain(api);
  const messages: LinearMessage[] = [];

  for (const msg of chain) {
    if (isHidden(msg)) continue;
    const role = normalizeRole(msg.author?.role);
    // Drop empty system messages outright — they're usually just routing noise.
    const text = renderContent(msg.content);
    if (!text && role !== 'user') continue;
    const attachments = pickAttachments(msg);
    if (!text && attachments.length === 0) continue;

    messages.push({
      turnId: withTurnIdPrefix(msg.id),
      messageId: msg.id,
      role,
      authorName: msg.author?.name ?? null,
      text,
      attachments,
      createTime: msg.create_time ?? null,
      contentType:
        typeof msg.content?.content_type === 'string' ? msg.content.content_type : undefined,
      channel:
        typeof msg.channel === 'string' ? msg.channel : msg.channel === null ? null : undefined,
    });
  }

  return {
    id: String(api.conversation_id || api.id || ''),
    title: typeof api.title === 'string' && api.title ? api.title : 'Untitled',
    createTime: api.create_time ?? null,
    updateTime: api.update_time ?? null,
    messages,
  };
}
