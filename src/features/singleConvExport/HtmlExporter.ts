/**
 * Simplified HTML exporter.
 *
 * Goal: a single self-contained `.html` file the user can double-click
 * and read in any browser. Same content filter as the simplified
 * markdown / json variants (user input, model output, timestamps).
 *
 * Deliberately NOT a markdown-to-html pipeline — we do not bundle a
 * markdown parser into the extension just for this. The model's text
 * is HTML-escaped and rendered inside `<pre class="content">` so that
 * indentation, line breaks, code fences and LaTeX wrappers all survive
 * exactly as the model wrote them. Users who want rendered markdown
 * should pick the markdown format and run their own viewer.
 *
 * Styling: inlined `<style>` so the file works offline with no asset
 * dependencies. Layout is conservative (single column, system font,
 * generous spacing) — readable on phones, printable, fits archival use.
 */
import type { LinearAttachment, LinearConversation, LinearMessage } from '../conversationApi/types';
import { filterForSimple } from './simpleFilter';

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimestamp(epochSeconds: number | null | undefined): string {
  if (epochSeconds == null || !Number.isFinite(epochSeconds)) return '';
  try {
    return new Date(epochSeconds * 1000).toISOString();
  } catch {
    return '';
  }
}

function attachmentsHtml(attachments: LinearAttachment[]): string {
  if (!attachments.length) return '';
  const items = attachments
    .map((a) => {
      const name = escapeHtml(a.name);
      const mime = a.mimeType ? ` <span class="mime">(${escapeHtml(a.mimeType)})</span>` : '';
      return `<li>${name}${mime}</li>`;
    })
    .join('');
  return `<div class="attachments"><div class="attachments-label">Attachments</div><ul>${items}</ul></div>`;
}

function messageHtml(message: LinearMessage): string {
  const roleClass = message.role === 'user' ? 'user' : 'assistant';
  const roleLabel = message.role === 'user' ? 'You' : 'ChatGPT';
  const ts = formatTimestamp(message.createTime);
  const tsHtml = ts ? `<time datetime="${escapeHtml(ts)}">${escapeHtml(ts)}</time>` : '';
  const attach = attachmentsHtml(message.attachments);
  const body = message.text ? `<pre class="content">${escapeHtml(message.text)}</pre>` : '';
  return [
    `<article class="message ${roleClass}">`,
    `  <header><span class="role">${escapeHtml(roleLabel)}</span>${tsHtml}</header>`,
    attach,
    body,
    `</article>`,
  ]
    .filter(Boolean)
    .join('\n');
}

const STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #1a1a1a;
    --muted: #6b6b6b;
    --border: #e5e5e5;
    --user-bg: #f3f3f5;
    --assistant-bg: #fafafa;
    --accent: #6b46c1;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1a1a1a;
      --fg: #e8e8e8;
      --muted: #999;
      --border: #333;
      --user-bg: #262626;
      --assistant-bg: #1f1f1f;
      --accent: #a78bfa;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 16px 64px;
    background: var(--bg);
    color: var(--fg);
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .message {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 18px;
    margin: 14px 0;
    background: var(--assistant-bg);
  }
  .message.user { background: var(--user-bg); }
  .message header {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 16px; margin-bottom: 8px;
  }
  .message .role {
    font-weight: 600; color: var(--accent); letter-spacing: 0.02em;
  }
  .message time { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .attachments { margin: 4px 0 10px; font-size: 13px; color: var(--muted); }
  .attachments-label { font-weight: 600; margin-bottom: 2px; }
  .attachments ul { margin: 0; padding-left: 18px; }
  .attachments .mime { color: var(--muted); font-size: 12px; }
  pre.content {
    margin: 0;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: anywhere;
    font: inherit;
  }
`;

export function toHtml(linear: LinearConversation): string {
  const filtered = filterForSimple(linear);
  const title = escapeHtml(filtered.title || 'Untitled conversation');
  const created = formatTimestamp(filtered.createTime);
  const metaParts: string[] = [];
  if (created) metaParts.push(`Created: ${escapeHtml(created)}`);
  metaParts.push(`Exported: ${escapeHtml(new Date().toISOString())}`);
  const meta = metaParts.join(' &middot; ');

  const messages = filtered.messages.map(messageHtml).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <p class="meta">${meta}</p>
${messages}
</main>
</body>
</html>
`;
}
