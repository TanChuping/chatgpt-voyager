const CONVERSATION_LINK_SELECTOR = 'a[href*="/c/"]';

const SIDEBAR_SELECTORS = [
  '#stage-slideover-sidebar',
  '[id="sidebar"]',
  '[id*="sidebar" i]',
  'aside',
  'nav[aria-label]',
  '[aria-label*="History" i]',
  '[aria-label*="chat" i]',
  '[aria-label*="历史"]',
  '[aria-label*="聊天"]',
];

const HISTORY_CONTAINER_SELECTORS = [
  '[aria-label*="History" i]',
  '[aria-label*="历史"]',
  '[data-testid*="history" i]',
  'nav',
  'section',
  'ol',
  'ul',
];

export function normalizeChatGptConversationId(value: string | null | undefined): string | null {
  const normalized = String(value || '')
    .trim()
    .replace(/^c_/i, '');
  return normalized || null;
}

export function extractChatGptConversationIdFromUrl(
  href: string | null | undefined,
): string | null {
  if (!href) return null;

  try {
    const parsed = new URL(href, window.location.origin);
    const match = parsed.pathname.match(/(?:^|\/)c\/([^/?#]+)/i);
    return normalizeChatGptConversationId(match?.[1]);
  } catch {
    const match = href.match(/(?:^|\/)c\/([^/?#]+)/i);
    return normalizeChatGptConversationId(match?.[1]);
  }
}

export function getChatGptConversationLink(root: ParentNode): HTMLAnchorElement | null {
  if (root instanceof HTMLAnchorElement && root.matches(CONVERSATION_LINK_SELECTOR)) {
    return root;
  }
  return root.querySelector<HTMLAnchorElement>(CONVERSATION_LINK_SELECTOR);
}

export function getChatGptConversationElement(element: HTMLElement): HTMLElement {
  const candidate = element.closest<HTMLElement>(
    '[data-testid*="history" i], [data-testid="conversation"], [data-test-id="conversation"], li, [role="listitem"], [role="treeitem"]',
  );
  if (candidate && getChatGptConversationLink(candidate)) {
    return candidate;
  }
  return element;
}

export function getChatGptConversationTitle(element: HTMLElement): string | null {
  const link = getChatGptConversationLink(element);
  const raw =
    link?.getAttribute('aria-label') ||
    link?.getAttribute('title') ||
    element.getAttribute('aria-label') ||
    element.getAttribute('title') ||
    link?.innerText ||
    element.innerText ||
    '';

  const title = raw
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^(chatgpt|history|today|yesterday|previous 7 days|new chat)$/i.test(part))
    .find((part) => part.length > 1);

  return title || null;
}

export function getChatGptConversationUrl(element: HTMLElement): string | null {
  const link = getChatGptConversationLink(element);
  return link?.href || link?.getAttribute('href') || null;
}

export function getChatGptConversationId(element: HTMLElement): string | null {
  const href = getChatGptConversationUrl(element);
  return extractChatGptConversationIdFromUrl(href);
}

export function findChatGptSidebar(): HTMLElement | null {
  for (const selector of SIDEBAR_SELECTORS) {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const candidate =
      candidates.find((el) => el.querySelector(CONVERSATION_LINK_SELECTOR)) || candidates[0];
    if (candidate) return candidate;
  }

  const firstLink = document.querySelector<HTMLAnchorElement>(CONVERSATION_LINK_SELECTOR);
  return firstLink?.closest<HTMLElement>('[id*="sidebar" i], aside, nav') || null;
}

export function findChatGptHistoryContainer(sidebar: HTMLElement): HTMLElement | null {
  const firstLink = sidebar.querySelector<HTMLAnchorElement>(CONVERSATION_LINK_SELECTOR);
  if (!firstLink) {
    for (const selector of HISTORY_CONTAINER_SELECTORS) {
      const container = sidebar.querySelector<HTMLElement>(selector);
      if (container) return container;
    }
    return sidebar;
  }

  let node: HTMLElement | null = firstLink;
  let best: HTMLElement = firstLink;
  while (node && node !== sidebar) {
    const count = node.querySelectorAll(CONVERSATION_LINK_SELECTOR).length;
    if (count > 1 || HISTORY_CONTAINER_SELECTORS.some((selector) => node?.matches(selector))) {
      best = node;
    }
    node = node.parentElement;
  }
  return best;
}

export function getChatGptConversationElements(
  root: ParentNode = document,
): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const result: HTMLElement[] = [];

  root.querySelectorAll<HTMLAnchorElement>(CONVERSATION_LINK_SELECTOR).forEach((link) => {
    const row = getChatGptConversationElement(link);
    if (!seen.has(row)) {
      seen.add(row);
      result.push(row);
    }
  });

  return result;
}
