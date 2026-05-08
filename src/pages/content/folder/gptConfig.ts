/**
 * ChatGPT GPT configuration.
 *
 * The original Google Gems presets were removed. Keep this table empty until
 * GPT-specific metadata is intentionally added.
 */

export interface GPTConfig {
  /** The GPT ID as it appears in URLs. */
  id: string;

  /** The display name of the GPT. */
  name: string;

  /** The icon name. */
  icon: string;

  /** Alternative icon names that might appear in the DOM. */
  aliases?: string[];
}

/** GPT-specific presets. Empty by default. */
export const GPT_CONFIG: GPTConfig[] = [];

/** Default icon for unknown or custom GPTs. */
export const DEFAULT_GPT_ICON = 'stars';

/** Default icon for regular conversations. */
export const DEFAULT_CONVERSATION_ICON = 'chat_bubble';

export function getGPTConfig(gptId: string): GPTConfig | undefined {
  return GPT_CONFIG.find((gpt) => gpt.id === gptId);
}

export function getGPTIdFromIcon(iconName: string): string | undefined {
  const gpt = GPT_CONFIG.find((item) => item.icon === iconName);
  return gpt?.id;
}

export function getGPTIcon(gptId: string): string {
  const config = getGPTConfig(gptId);
  return config?.icon || DEFAULT_GPT_ICON;
}

export function isKnownGPT(gptId: string): boolean {
  return GPT_CONFIG.some((gpt) => gpt.id === gptId);
}

export function getAllGPTIcons(): string[] {
  return GPT_CONFIG.map((gpt) => gpt.icon);
}

export function createIconToGPTMap(): Record<string, string> {
  const map: Record<string, string> = {};
  GPT_CONFIG.forEach((gpt) => {
    map[gpt.icon] = gpt.id;
  });
  return map;
}
