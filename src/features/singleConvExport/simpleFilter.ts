/**
 * Simplified-export filter.
 *
 * Background: ChatGPT's `/backend-api/conversation/<id>` response contains
 * every node the model emitted, not just the polished user-facing text.
 * Live observations on a real "create a Merge Sort visualiser" conversation:
 *
 *   user|text                        9   ← keep
 *   assistant|text  channel=final    8   ← keep (the actual answer)
 *   assistant|text  channel=null     1   ← keep (older models / channel-less)
 *   assistant|text  channel=commentary  2  ← drop ("I'm about to do X" pre-tool narration)
 *   assistant|code  recipient=python 1   ← drop (32 KB Python source sent to interpreter)
 *   tool|execution_output            1   ← drop (interpreter stdout)
 *   assistant|thoughts               8   ← already dropped by parser, listed for completeness
 *   assistant|reasoning_recap        8   ← already dropped by parser
 *   assistant|model_editable_context 2   ← already dropped by parser
 *   system|text (hidden)             15  ← already dropped by parser
 *
 * Users keep reporting the dropped-here-but-not-by-default items as "model
 * thinking garbled text". For the simplified formats we keep only the
 * three things they actually want in the export: their own input, the
 * model's polished reply, and timestamps.
 *
 * Filter rules:
 *   - role=user                                       → keep
 *   - role=assistant, content_type ∈ {text, multimodal_text}, channel ∈ {final, null}
 *                                                     → keep
 *   - everything else                                 → drop
 *
 * Implementation note: we keep `messageId`, `turnId`, attachments and
 * timestamps on the surviving messages — the simplified JSON shape
 * decides separately which fields to expose. This file only decides
 * *what counts as a real message*; the renderers decide *what to show*.
 */
import type { LinearConversation, LinearMessage } from '../conversationApi/types';

/**
 * Visible-content predicate for the simplified formats.
 *
 * Exported so each renderer (md / json / html) can call it directly
 * instead of going through `filterForSimple` when it already has a
 * single message to consider — cheaper for the JSON renderer's optional
 * "include intermediate" debug fork in tests.
 */
export function isSimpleVisibleMessage(message: LinearMessage): boolean {
  if (message.role === 'user') return true;
  if (message.role !== 'assistant') return false;
  const ct = message.contentType ?? 'text';
  if (ct !== 'text' && ct !== 'multimodal_text') return false;
  const ch = message.channel;
  // `undefined` happens when the parser couldn't determine a channel (very
  // old payloads, or transient parser shapes). Treat as visible — better
  // to include a real assistant reply than to silently drop it.
  if (ch === undefined || ch === null) return true;
  return ch === 'final';
}

/**
 * Return a *new* LinearConversation containing only the messages that
 * pass `isSimpleVisibleMessage`. The original is untouched — exporters
 * for the "standard" formats still see the full conversation.
 *
 * Also drops messages whose `text` is empty AND have no attachments —
 * after channel filtering there can be empty placeholders left behind
 * (e.g. an assistant final-channel message that was just a stop token);
 * those add no value to the simplified output.
 */
export function filterForSimple(linear: LinearConversation): LinearConversation {
  const messages: LinearMessage[] = [];
  for (const m of linear.messages) {
    if (!isSimpleVisibleMessage(m)) continue;
    const hasText = !!(m.text && m.text.trim().length > 0);
    const hasAttachments = m.attachments && m.attachments.length > 0;
    if (!hasText && !hasAttachments) continue;
    messages.push(m);
  }
  return {
    id: linear.id,
    title: linear.title,
    createTime: linear.createTime,
    updateTime: linear.updateTime,
    messages,
  };
}
