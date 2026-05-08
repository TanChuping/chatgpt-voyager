export type ForkLanguage = 'en' | 'zh';

function normalizeLanguage(raw: string | undefined): ForkLanguage {
  if (!raw) return 'en';
  return raw.trim().toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

const CONTEXT_PREFIX: Record<ForkLanguage, string> = {
  en: `# Branch Context
You are continuing a branched conversation.
- The section below is the conversation history up to the fork point.
- Continue from the final "User" message as a new branch.
- Do not rewrite the history; only provide the next assistant response.
`,
  zh: `# Branch Context
You are continuing a branched conversation.
- The section below is the conversation history up to the fork point.
- Continue from the final "User" message as a new branch.
- Do not rewrite the history; only provide the next assistant response.
`,
};

export function composeForkInputWithContext(historyMarkdown: string, rawLanguage?: string): string {
  const language = normalizeLanguage(rawLanguage);
  const prefix = CONTEXT_PREFIX[language] || CONTEXT_PREFIX.en;
  const normalizedHistory = historyMarkdown.trim();
  return `${prefix}\n# Conversation History\n${normalizedHistory}\n`;
}
