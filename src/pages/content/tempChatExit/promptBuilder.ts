/**
 * Build the "continuation handoff" prompt that the user will paste
 * into a fresh persistent conversation to resume a temporary chat.
 *
 * Locale: the directive (the instructions to the model) and the
 * transcript separators come from `i18n.ts`, so a user running the
 * extension in Chinese gets a Chinese hand-off prompt and an English
 * user gets an English one. The model handles both languages
 * natively; we deliberately don't ship bilingual text because the
 * user reviews the prompt in the input box before sending and a
 * cluttered bilingual block was the complaint that drove this
 * change.
 *
 * Format mirrors the A-style "命令式" template the user picked:
 *   1. Title line: `[Hand-off from a temporary chat]` (i18n)
 *   2. Directive: "continue seamlessly, repeat the last assistant
 *      message verbatim as the bridging line" (i18n)
 *   3. Transcript fenced between localized START / END separators,
 *      with `## User` / `## Assistant` headers per turn.
 *
 * "## User" and "## Assistant" headers themselves stay in English
 * because they're markdown semantic tags the model reads structurally,
 * not display strings — translating them would just confuse the
 * downstream parser.
 */

import { t } from './i18n';

export type TurnRole = 'user' | 'assistant';

export interface ExtractedTurn {
  role: TurnRole;
  text: string;
}

/**
 * Threshold for deciding whether to deliver the transcript as inline
 * text vs as a synthetic `paste` event (which ChatGPT auto-converts
 * to a `.txt` file attachment). 5000 chars is a conservative bet that
 * sits below every ChatGPT auto-attach threshold I've seen reported.
 * If ChatGPT raises the bar we just keep typing — no regression.
 */
export const HANDOFF_PASTE_THRESHOLD_CHARS = 5000;

function fenceIfNeeded(text: string): string {
  // If the text already contains a markdown code fence pair, wrap the
  // whole turn in ~~~ instead so we don't accidentally break out of a
  // fenced block in the middle. Simpler and safer than tracking depth.
  if (/^```/m.test(text)) {
    return `~~~\n${text}\n~~~`;
  }
  return text;
}

/**
 * The Markdown body that represents the temp-chat transcript. Used as
 * both the inline-prompt body (when short) and the .txt attachment
 * content (when long).
 */
export function buildTranscriptMarkdown(turns: ExtractedTurn[]): string {
  if (turns.length === 0) return '_(empty — no extractable messages)_';
  const lines: string[] = [];
  for (const turn of turns) {
    const heading = turn.role === 'user' ? '## User' : '## Assistant';
    lines.push(heading);
    lines.push('');
    lines.push(fenceIfNeeded(turn.text.trim() || '_(empty turn)_'));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function inlineDirective(): string {
  return [
    t('tempChatRegretDirectiveTitle'),
    '',
    t('tempChatRegretDirectiveInlineBody'),
  ].join('\n');
}

function attachmentDirective(): string {
  return [
    t('tempChatRegretDirectiveTitle'),
    '',
    t('tempChatRegretDirectiveAttachmentBody'),
  ].join('\n');
}

/**
 * Build the all-inline prompt (directive + transcript). Used when the
 * transcript fits comfortably in the input box. Returns one big string.
 */
export function buildInlineHandoffPrompt(turns: ExtractedTurn[]): string {
  return [
    inlineDirective(),
    '',
    t('tempChatRegretTranscriptStart'),
    '',
    buildTranscriptMarkdown(turns),
    '',
    t('tempChatRegretTranscriptEnd'),
  ].join('\n');
}

/**
 * Choose the delivery strategy based on transcript size.
 */
export type HandoffDelivery =
  | { mode: 'inline'; text: string }
  | { mode: 'attachment'; directive: string; attachment: string; filename: string };

export function planHandoffDelivery(turns: ExtractedTurn[]): HandoffDelivery {
  const transcript = buildTranscriptMarkdown(turns);
  if (transcript.length <= HANDOFF_PASTE_THRESHOLD_CHARS) {
    return { mode: 'inline', text: buildInlineHandoffPrompt(turns) };
  }
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return {
    mode: 'attachment',
    directive: attachmentDirective(),
    attachment: transcript,
    filename: `temp-chat-handoff-${stamp}.txt`,
  };
}
