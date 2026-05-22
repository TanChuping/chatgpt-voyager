/**
 * Conversation walking + export pipeline.
 * Mapping-walk strategy adapted from pionxzh/chatgpt-exporter (MIT).
 * https://github.com/pionxzh/chatgpt-exporter
 */

/**
 * Loose mirror of ChatGPT's `/backend-api/conversation/<id>` response shape.
 *
 * We keep `content` and `metadata` as `unknown` because the runtime payload
 * carries many open-ended union shapes (multimodal, tool calls, sandbox URLs,
 * Code Interpreter execution output, citations, …). The parser narrows per
 * `content_type` rather than trusting the type system at the boundary.
 */
export interface ApiAuthorBase {
  role: string;
  name?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ApiContent {
  content_type: string;
  parts?: unknown[];
  text?: string;
  language?: string;
  // execution_output, multimodal_text, code, sandbox urls, etc.
  [k: string]: unknown;
}

export interface ConversationNodeMessage {
  id: string;
  author: ApiAuthorBase;
  create_time: number | null;
  update_time?: number | null;
  content: ApiContent;
  status?: string;
  end_turn?: boolean | null;
  weight?: number;
  metadata?: {
    is_visually_hidden_from_conversation?: boolean;
    message_type?: string | null;
    model_slug?: string | null;
    parent_id?: string;
    attachments?: ApiAttachment[];
    [k: string]: unknown;
  };
  recipient?: string;
  channel?: string | null;
}

export interface ApiAttachment {
  id?: string;
  name?: string;
  mimeType?: string;
  mime_type?: string;
  size?: number;
  fileTokenSize?: number;
  width?: number;
  height?: number;
  [k: string]: unknown;
}

export interface ConversationNode {
  id: string;
  message: ConversationNodeMessage | null;
  parent?: string | null;
  children: string[];
}

export interface ApiConversation {
  conversation_id?: string;
  id?: string;
  title?: string | null;
  create_time?: number | null;
  update_time?: number | null;
  current_node: string;
  mapping: Record<string, ConversationNode>;
  [k: string]: unknown;
}

/**
 * Normalized linear form. `turnId` matches the timeline manager's id scheme:
 * bare UUIDs get a `u-` prefix (see `ensureTurnId` in
 * `src/pages/content/timeline/manager.ts`).
 */
export interface LinearAttachment {
  name: string;
  mimeType?: string;
}

export interface LinearMessage {
  turnId: string;
  /** Raw message uuid from API (no `u-` prefix). Useful for fingerprinting. */
  messageId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  authorName?: string | null;
  text: string;
  attachments: LinearAttachment[];
  createTime: number | null;
  /**
   * Original `content_type` string from the API node ("text",
   * "multimodal_text", "code", "execution_output", "thoughts",
   * "reasoning_recap", "model_editable_context", "tether_quote", ...).
   *
   * Carried through so the simplified-export filter can decide which
   * messages are user-facing "answers" vs. tool/internal noise. The
   * standard exporters ignore it.
   */
  contentType?: string;
  /**
   * Channel string from the API node. ChatGPT uses `"final"` for the
   * polished user-facing assistant response, `"commentary"` for the
   * model's pre-tool narration that wraps Code Interpreter / browsing
   * calls, and leaves it `null` on legacy models. The simplified-export
   * filter treats `null` and `"final"` as visible, everything else as
   * intermediate noise.
   */
  channel?: string | null;
}

export interface LinearConversation {
  id: string;
  title: string;
  createTime: number | null;
  updateTime: number | null;
  messages: LinearMessage[];
}

export function withTurnIdPrefix(messageId: string): string {
  // The timeline normalises bare UUIDs to `u-<uuid>`.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)
    ? `u-${messageId}`
    : messageId;
}
