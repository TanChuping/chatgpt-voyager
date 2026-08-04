import type { ConversationReference } from './types';

export type ConversationSortMode = 'manual' | 'recent';

function getConversationSortTime(conversation: ConversationReference): number {
  return conversation.lastOpenedAt ?? conversation.addedAt ?? 0;
}

export function sortConversationsByPriority(
  conversations: ConversationReference[],
  mode: ConversationSortMode = 'manual',
): ConversationReference[] {
  return [...conversations].sort((a, b) => {
    if (a.starred && !b.starred) return -1;
    if (!a.starred && b.starred) return 1;

    if (mode === 'manual') {
      const aIdx = a.sortIndex;
      const bIdx = b.sortIndex;
      if (aIdx != null && bIdx != null && aIdx !== bIdx) return aIdx - bIdx;
    }

    const timeDifference = getConversationSortTime(b) - getConversationSortTime(a);
    if (timeDifference !== 0) return timeDifference;
    return a.conversationId.localeCompare(b.conversationId);
  });
}
