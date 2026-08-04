import {
  extractChatGptConversationIdFromUrl,
  getChatGptConversationTitle,
} from '../chatgptDom';

export type SidebarConversationTarget = {
  conversationId: string;
  url: string;
  title: string | null;
};

const SIDEBAR_OPTIONS_SELECTOR =
  '[data-testid^="history-item-"][data-testid$="-options"], [data-conversation-options-trigger]';
const CONVERSATION_LINK_SELECTOR = 'a[href*="/c/"]';
const ROW_SELECTOR = 'li, [role="listitem"], [role="treeitem"], [data-testid*="history" i]';

function findOwnedConversationLink(trigger: HTMLElement): HTMLAnchorElement | null {
  const nested = trigger.closest<HTMLAnchorElement>(CONVERSATION_LINK_SELECTOR);
  if (nested) return nested;

  let row = trigger.closest<HTMLElement>(ROW_SELECTOR);
  for (let depth = 0; row && depth < 4; depth += 1) {
    const link = row.querySelector<HTMLAnchorElement>(CONVERSATION_LINK_SELECTOR);
    if (link) return link;
    row = row.parentElement?.closest<HTMLElement>(ROW_SELECTOR) ?? null;
  }
  return null;
}

/** Resolve only the conversation row that owns the clicked sidebar trigger.
 * A title/proximity fallback can silently select the wrong row when titles
 * repeat or the virtualized sidebar moves, so ambiguous contexts fail closed. */
export function resolveSidebarConversationTarget(
  trigger: HTMLElement,
): SidebarConversationTarget | null {
  if (!trigger.matches(SIDEBAR_OPTIONS_SELECTOR)) return null;

  const link = findOwnedConversationLink(trigger);
  if (!link) return null;
  const conversationId = extractChatGptConversationIdFromUrl(link.href || link.getAttribute('href'));
  if (!conversationId) return null;

  const row = link.closest<HTMLElement>(ROW_SELECTOR) ?? link;
  return {
    conversationId,
    url: link.href || link.getAttribute('href') || `${window.location.origin}/c/${conversationId}`,
    title: getChatGptConversationTitle(row),
  };
}
