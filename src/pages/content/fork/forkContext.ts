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
  zh: `# 分支上下文
你正在继续一段从原对话分叉出来的对话。
- 下面是分叉点之前的完整对话历史。
- 请从最后一条 "User" 消息继续，作为一个新的分支。
- 不要重写历史记录，只需给出下一条助手回复。
`,
};

export function composeForkInputWithContext(historyMarkdown: string, rawLanguage?: string): string {
  const language = normalizeLanguage(rawLanguage);
  const prefix = CONTEXT_PREFIX[language] || CONTEXT_PREFIX.en;
  const normalizedHistory = historyMarkdown.trim();
  return `${prefix}\n# Conversation History\n${normalizedHistory}\n`;
}
