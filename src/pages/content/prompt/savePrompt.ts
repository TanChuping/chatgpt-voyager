import { promptStorageService } from '@/core/services/StorageService';
import { StorageKeys } from '@/core/types/common';

export type PromptItem = {
  id: string;
  text: string;
  tags: string[];
  createdAt: number;
  updatedAt?: number;
  /** Optional compact-view label; existing prompts need no migration. */
  name?: string;
};

type SaveResult = { status: 'saved'; items: PromptItem[] } | { status: 'duplicate' | 'failed' };

/** Keep the current list and draft intact unless storage acknowledges the write. */
export async function savePrompt(
  items: PromptItem[],
  candidate: PromptItem,
  editingId: string | null,
): Promise<SaveResult> {
  if (
    items.some(
      (item) =>
        item.id !== editingId &&
        item.text.trim().toLowerCase() === candidate.text.trim().toLowerCase(),
    )
  ) {
    return { status: 'duplicate' };
  }
  if (editingId && !items.some((item) => item.id === editingId)) return { status: 'failed' };
  const nextItems = editingId
    ? items.map((item) => (item.id === editingId ? candidate : item))
    : [candidate, ...items];
  try {
    const result = await promptStorageService.set(StorageKeys.PROMPT_ITEMS, nextItems);
    return result.success ? { status: 'saved', items: nextItems } : { status: 'failed' };
  } catch {
    return { status: 'failed' };
  }
}
