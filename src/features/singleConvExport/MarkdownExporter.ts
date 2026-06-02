/**
 * Conversation walking + export pipeline.
 * Mapping-walk strategy adapted from pionxzh/chatgpt-exporter (MIT).
 * https://github.com/pionxzh/chatgpt-exporter
 */
import type { LinearConversation, LinearMessage } from '../conversationApi/types';

function formatTimestamp(epochSeconds: number | null): string {
  if (epochSeconds == null || !Number.isFinite(epochSeconds)) return '';
  try {
    return new Date(epochSeconds * 1000).toISOString();
  } catch {
    return '';
  }
}

function roleHeading(message: LinearMessage): string {
  const ts = formatTimestamp(message.createTime);
  const label =
    message.role === 'user'
      ? 'You'
      : message.role === 'assistant'
        ? 'ChatGPT'
        : message.role === 'system'
          ? 'System'
          : message.authorName
            ? `tool: ${message.authorName}`
            : 'tool';
  return ts ? `## ${label} — ${ts}` : `## ${label}`;
}

function renderAttachments(message: LinearMessage): string {
  if (!message.attachments.length) return '';
  const lines = message.attachments.map(
    (a) => `- ${a.name}${a.mimeType ? ` (${a.mimeType})` : ''}`,
  );
  return ['**Attachments**', ...lines].join('\n');
}

function renderToolBody(message: LinearMessage): string {
  // Render tool / system messages as quoted block to stay visually distinct
  const name = message.authorName || message.role;
  const lines = (message.text || '').split('\n').map((l) => `> ${l}`);
  return [`> [${name}]`, ...lines].join('\n');
}

/**
 * Markdown-render a single linear conversation. LaTeX wrappers (`$..$`,
 * `$$..$$`) are preserved verbatim — we do not escape `$` because that would
 * break math rendering in downstream markdown viewers.
 */
export function toMarkdown(linear: LinearConversation): string {
  const out: string[] = [];
  out.push(`# ${linear.title || 'Untitled conversation'}`);
  if (linear.createTime != null) {
    out.push('');
    out.push(`*Created: ${formatTimestamp(linear.createTime)}*`);
  }
  if (linear.id) {
    out.push('');
    out.push(`*Conversation ID: ${linear.id}*`);
  }
  out.push('');

  for (const message of linear.messages) {
    out.push(roleHeading(message));
    out.push('');
    const attach = renderAttachments(message);
    if (attach) {
      out.push(attach);
      out.push('');
    }
    if (message.role === 'tool' || message.role === 'system') {
      out.push(renderToolBody(message));
    } else {
      out.push(message.text || '');
    }
    out.push('');
  }

  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}
