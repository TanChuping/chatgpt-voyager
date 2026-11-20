import { getTranslationSync } from '@/utils/i18n';

export interface ForkExtractedTurn {
  user: string;
  assistant?: string;
}

export function buildForkMarkdown(
  title: string,
  turns: ForkExtractedTurn[],
  dropLastAssistant: boolean,
): string {
  if (!turns.length) return '';

  const normalizedTurns = turns.map((turn) => ({ ...turn }));
  if (dropLastAssistant && normalizedTurns.length > 0) {
    normalizedTurns[normalizedTurns.length - 1].assistant = '';
  }

  const lines: string[] = [];
  lines.push(`# ${title || getTranslationSync('conversation_untitled')}`);
  lines.push('');

  for (const turn of normalizedTurns) {
    lines.push(`### 👤 ${getTranslationSync('exportUserLabel')}`);
    lines.push('');
    lines.push(turn.user || '');
    lines.push('');

    if (turn.assistant?.trim()) {
      lines.push(`### 🤖 ${getTranslationSync('exportAssistantLabel')}`);
      lines.push('');
      lines.push(turn.assistant);
      lines.push('');
    }
  }

  return lines.join('\n');
}
