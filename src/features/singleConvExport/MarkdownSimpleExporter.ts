/**
 * Simplified markdown exporter.
 *
 * Three fields only: user input, model output, timestamp. No tool calls,
 * no Python code blocks, no pre-tool commentary, no system noise. See
 * `simpleFilter.ts` for the exact filter rules and the rationale.
 *
 * Differs from `MarkdownExporter.ts` in two ways:
 *   1. It runs the conversation through `filterForSimple` first, so
 *      every emitted heading is either "You" or "ChatGPT" — never
 *      "tool: python" or a system block.
 *   2. It uses a tighter heading shape (`## You (timestamp)`) to make
 *      it read like a transcript instead of a debug dump. We still
 *      preserve `$..$` and `$$..$$` LaTeX wrappers verbatim so KaTeX-
 *      capable downstream viewers render correctly.
 */
import type { LinearConversation, LinearMessage } from '../conversationApi/types';
import { filterForSimple } from './simpleFilter';

function formatTimestamp(epochSeconds: number | null | undefined): string {
  if (epochSeconds == null || !Number.isFinite(epochSeconds)) return '';
  try {
    return new Date(epochSeconds * 1000).toISOString();
  } catch {
    return '';
  }
}

function roleLabel(message: LinearMessage): string {
  return message.role === 'user' ? 'You' : 'ChatGPT';
}

function heading(message: LinearMessage): string {
  const ts = formatTimestamp(message.createTime);
  const label = roleLabel(message);
  return ts ? `## ${label} (${ts})` : `## ${label}`;
}

function renderAttachments(message: LinearMessage): string {
  if (!message.attachments.length) return '';
  const lines = message.attachments.map(
    (a) => `- ${a.name}${a.mimeType ? ` (${a.mimeType})` : ''}`,
  );
  return ['**Attachments**', ...lines].join('\n');
}

/**
 * Render the filtered conversation as a clean markdown transcript.
 *
 * Layout:
 *
 *   # <title>
 *
 *   *Exported: <iso>*
 *
 *   ## You (timestamp)
 *
 *   <user text>
 *
 *   ## ChatGPT (timestamp)
 *
 *   <model text>
 *
 *   ...
 */
export function toMarkdownSimple(linear: LinearConversation): string {
  const filtered = filterForSimple(linear);
  const out: string[] = [];

  out.push(`# ${filtered.title || 'Untitled conversation'}`);
  if (filtered.createTime != null) {
    out.push('');
    out.push(`*Created: ${formatTimestamp(filtered.createTime)}*`);
  }
  out.push('');

  for (const message of filtered.messages) {
    out.push(heading(message));
    out.push('');
    const attach = renderAttachments(message);
    if (attach) {
      out.push(attach);
      out.push('');
    }
    if (message.text) out.push(message.text);
    out.push('');
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
