const CONVERSATION_LINK_SELECTOR = 'a[href*="/c/"]';

/** Current ChatGPT primitives. Legacy Angular selectors live only in the
 * compatibility branches of the features that still need to parse them. */
export const CHATGPT_MENU_SELECTOR =
  '[role="menu"][data-radix-menu-content], [role="menu"][data-state="open"]';

const CHATGPT_CONVERSATION_OPTIONS_SELECTOR = [
  '[data-testid="conversation-options-button"]',
  '[data-testid^="history-item-"][data-testid$="-options"]',
  '[data-conversation-options-trigger]',
].join(', ');

const CHATGPT_TURN_SELECTOR = [
  'section[data-testid^="conversation-turn-"]',
  '[data-testid^="conversation-turn-"]',
  'article[data-testid^="conversation-turn-"]',
].join(', ');

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
    link?.textContent ||
    element.innerText ||
    element.textContent ||
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

function isUsableHostElement(element: HTMLElement): boolean {
  if (!element.isConnected) return false;

  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (
      current.hidden ||
      current.hasAttribute('inert') ||
      current.getAttribute('aria-hidden') === 'true'
    ) {
      return false;
    }
  }

  return true;
}

export function findChatGptSidebar(): HTMLElement | null {
  const candidates: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();

  for (const selector of SIDEBAR_SELECTORS) {
    for (const candidate of document.querySelectorAll<HTMLElement>(selector)) {
      if (seen.has(candidate) || !isUsableHostElement(candidate)) continue;
      seen.add(candidate);
      candidates.push(candidate);
    }
  }

  const conversationSidebar = candidates.find((candidate) =>
    candidate.querySelector(CONVERSATION_LINK_SELECTOR),
  );
  if (conversationSidebar) return conversationSidebar;
  if (candidates[0]) return candidates[0];

  const firstLink = document.querySelector<HTMLAnchorElement>(CONVERSATION_LINK_SELECTOR);
  const fallback = firstLink?.closest<HTMLElement>('[id*="sidebar" i], aside, nav') || null;
  return fallback && isUsableHostElement(fallback) ? fallback : null;
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

export function getChatGptConversationElements(root: ParentNode = document): HTMLElement[] {
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

function queryIncludingRoot(root: ParentNode, selector: string): HTMLElement[] {
  const result: HTMLElement[] = [];
  if (root instanceof HTMLElement && root.matches(selector)) result.push(root);
  result.push(...Array.from(root.querySelectorAll<HTMLElement>(selector)));
  return result;
}

export function findConversationOptionsButton(root: ParentNode = document): HTMLElement | null {
  return queryIncludingRoot(root, CHATGPT_CONVERSATION_OPTIONS_SELECTOR)[0] || null;
}

export function findConversationHeaderActions(root: ParentNode = document): HTMLElement | null {
  const explicit = root.querySelector<HTMLElement>('#conversation-header-actions');
  if (explicit) return explicit;
  const options = findConversationOptionsButton(root);
  return (
    options?.closest<HTMLElement>('header, [role="banner"], [data-testid*="header" i]') || null
  );
}

export function findChatGptMenus(root: ParentNode = document): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  return queryIncludingRoot(root, CHATGPT_MENU_SELECTOR).filter((menu) => {
    if (seen.has(menu) || menu.getAttribute('aria-hidden') === 'true') return false;
    seen.add(menu);
    return true;
  });
}

function controlledIds(element: HTMLElement): string[] {
  return `${element.getAttribute('aria-controls') || ''} ${element.getAttribute('aria-owns') || ''}`
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

const menuTriggerBindings = new WeakMap<HTMLElement, HTMLElement>();

function normalizeMenuTriggerCandidate(trigger: HTMLElement): HTMLElement {
  if (trigger.matches('[aria-haspopup="menu"]')) return trigger;
  return trigger.closest<HTMLElement>('[aria-haspopup="menu"]') || trigger;
}

function isOpenMenuTrigger(trigger: HTMLElement): boolean {
  return (
    trigger.getAttribute('aria-expanded') === 'true' ||
    trigger.getAttribute('data-state') === 'open'
  );
}

/** Bind a recently interacted trigger only when the rendered menu explicitly
 * names it through aria-controls/aria-owns. This lets the event capture path
 * bridge Radix hydration without ever guessing from "the last open menu". */
export function bindChatGptMenuTrigger(menu: HTMLElement, trigger: HTMLElement): boolean {
  if (!menu.id) return false;
  const candidate = normalizeMenuTriggerCandidate(trigger);
  if (!isOpenMenuTrigger(candidate) || !controlledIds(candidate).includes(menu.id)) return false;
  menuTriggerBindings.set(menu, candidate);
  return true;
}

/** Resolve the live Radix trigger associated with a portalled menu. The
 * expanded state lives on a wrapper for the top-bar menu and on the button for
 * sidebar/turn menus, so callers must not assume a particular tag. */
export function resolveChatGptMenuTrigger(menu: HTMLElement): HTMLElement | null {
  const bound = menuTriggerBindings.get(menu);
  if (bound) {
    if (
      bound.isConnected &&
      isOpenMenuTrigger(bound) &&
      menu.id &&
      controlledIds(bound).includes(menu.id)
    ) {
      return bound;
    }
    menuTriggerBindings.delete(menu);
  }

  const expanded = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[aria-haspopup="menu"][aria-expanded="true"], [aria-haspopup="menu"][data-state="open"]',
    ),
  );
  if (menu.id) {
    const linked = expanded.find((trigger) => controlledIds(trigger).includes(menu.id));
    if (linked) {
      menuTriggerBindings.set(menu, linked);
      return linked;
    }
  }
  return null;
}

export function isConversationOptionsTrigger(trigger: HTMLElement | null): boolean {
  if (!trigger) return false;
  return Boolean(
    trigger.matches(CHATGPT_CONVERSATION_OPTIONS_SELECTOR) ||
      trigger.querySelector(CHATGPT_CONVERSATION_OPTIONS_SELECTOR) ||
      trigger.closest(CHATGPT_CONVERSATION_OPTIONS_SELECTOR),
  );
}

export function isSidebarConversationOptionsTrigger(trigger: HTMLElement | null): boolean {
  if (!trigger) return false;
  const actionable =
    (trigger.matches(CHATGPT_CONVERSATION_OPTIONS_SELECTOR) ? trigger : null) ||
    trigger.querySelector<HTMLElement>(CHATGPT_CONVERSATION_OPTIONS_SELECTOR) ||
    trigger.closest<HTMLElement>(CHATGPT_CONVERSATION_OPTIONS_SELECTOR);
  if (!actionable) return false;
  if (actionable.hasAttribute('data-conversation-options-trigger')) return true;
  if (actionable.matches('[data-testid^="history-item-"][data-testid$="-options"]')) return true;
  return Boolean(
    actionable
      .closest('li, [role="listitem"], [role="treeitem"]')
      ?.querySelector(CONVERSATION_LINK_SELECTOR),
  );
}

export function findTurnContainer(element: HTMLElement): HTMLElement | null {
  return (
    element.closest<HTMLElement>(CHATGPT_TURN_SELECTOR) ||
    element.closest<HTMLElement>(
      '[data-message-author-role], article[data-author], article[data-turn]',
    )
  );
}

export function getTurnRole(element: HTMLElement): 'user' | 'assistant' | null {
  const container = findTurnContainer(element) || element;
  const roleNode =
    (container.matches('[data-message-author-role]') ? container : null) ||
    container.querySelector<HTMLElement>('[data-message-author-role]');
  const role = roleNode?.getAttribute('data-message-author-role');
  if (role === 'assistant' || role === 'model') return 'assistant';
  if (role === 'user') return 'user';
  const articleRole = container.getAttribute('data-author') || container.getAttribute('data-turn');
  if (articleRole === 'assistant' || articleRole === 'model') return 'assistant';
  if (articleRole === 'user') return 'user';
  return null;
}

export function findAssistantTurnForElement(element: HTMLElement): HTMLElement | null {
  const container = findTurnContainer(element);
  if (!container || getTurnRole(container) !== 'assistant') return null;
  return (
    container.querySelector<HTMLElement>('[data-message-author-role="assistant"]') ||
    container.querySelector<HTMLElement>('[data-message-author-role="model"]') ||
    container
  );
}

export function findTurnActionBar(turnOrDescendant: HTMLElement): HTMLElement | null {
  const container = findTurnContainer(turnOrDescendant) || turnOrDescendant;
  const copy = container.matches('[data-testid="copy-turn-action-button"]')
    ? container
    : container.querySelector<HTMLElement>('[data-testid="copy-turn-action-button"]');
  if (copy) return copy.closest<HTMLElement>('[role="group"]') || copy.parentElement;

  // Explicit legacy fallback used by old imported Gemini conversations/tests.
  const legacyCopy = container.matches('[data-test-id="copy-button"]')
    ? container
    : container.querySelector<HTMLElement>('[data-test-id="copy-button"]');
  return (
    legacyCopy?.closest<HTMLElement>('message-actions, .message-actions, [role="group"]') || null
  );
}

export type TurnActionKind = 'copy' | 'more' | 'good' | 'bad';

export function findTurnAction(
  turnOrDescendant: HTMLElement,
  kind: TurnActionKind,
): HTMLElement | null {
  const bar = findTurnActionBar(turnOrDescendant);
  if (!bar) return null;
  const selectors: Record<TurnActionKind, string> = {
    copy: '[data-testid="copy-turn-action-button"], [data-test-id="copy-button"]',
    good: '[data-testid="good-response-turn-action-button"], [data-test-id="rate-up-button"]',
    bad: '[data-testid="bad-response-turn-action-button"], [data-test-id="rate-down-button"]',
    more: '[data-testid="more-turn-action-button"], [data-test-id="more-menu-button"], button[aria-label*="More" i], button[aria-label*="更多"]',
  };
  return bar.querySelector<HTMLElement>(selectors[kind]);
}

const CANVAS_SURFACE_SELECTORS = [
  '[data-testid="canvas-panel"]',
  '[data-testid="canvas"]',
  '[data-testid*="canvas" i][role="dialog"]',
  '[aria-label*="canvas" i][role="dialog"]',
  '[data-testid*="artifact" i][role="dialog"]',
  'immersive-editor',
  '[data-canvas-id]',
  '[data-artifact-id]',
  '[data-testid="canvas-surface"]',
  '[data-testid="artifact-surface"]',
  '[data-testid="canvas-editor"]',
  '[data-testid="artifact-editor"]',
];

const CANVAS_EDITOR_SELECTOR =
  '.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]';

const NON_CANVAS_EDITOR_OWNER_SELECTOR = [
  'form',
  '[data-testid^="conversation-turn-"]',
  '[data-message-author-role]',
  '[data-testid*="composer" i]',
  '[data-testid*="message-edit" i]',
  '[data-testid*="edit-message" i]',
].join(', ');

const CANVAS_OWNERSHIP_SIGNAL_SELECTOR = [
  '[data-testid*="canvas" i]',
  '[aria-label*="canvas" i]',
  '[data-testid*="artifact" i]',
  '[aria-label*="artifact" i]',
].join(', ');

const CANVAS_CAPABILITY_SIGNAL_SELECTOR = [
  '[data-testid*="canvas-actions" i]',
  '[data-testid*="canvas-share" i]',
  '[data-testid*="share-canvas" i]',
  '[aria-label*="share canvas" i]',
  '[aria-label*="canvas" i][aria-haspopup="menu"]',
  '[data-testid*="artifact" i][aria-haspopup="menu"]',
].join(', ');

const CANVAS_INTERACTION_SELECTOR = [
  '[data-testid*="canvas" i]',
  '[data-testid*="artifact" i]',
  'button[aria-label*="canvas" i]',
  'button[aria-label*="artifact" i]',
  '[role="menuitem"][aria-label*="canvas" i]',
  '[role="menuitem"][aria-label*="artifact" i]',
].join(', ');

function matchesOrContains(element: HTMLElement, selector: string): boolean {
  return element.matches(selector) || Boolean(element.querySelector(selector));
}

function findGenericCanvasSurface(editor: HTMLElement): HTMLElement | null {
  if (editor.closest(NON_CANVAS_EDITOR_OWNER_SELECTOR)) return null;

  // Generic ProseMirror instances are also used for editing messages and for
  // composer variants. Only accept a nearby side-panel/dialog/section that
  // independently proves both Canvas ownership and a Canvas capability.
  const surface = editor.closest<HTMLElement>('aside, [role="dialog"], section');
  if (!surface || surface.closest(NON_CANVAS_EDITOR_OWNER_SELECTOR)) return null;
  if (!matchesOrContains(surface, CANVAS_OWNERSHIP_SIGNAL_SELECTOR)) return null;
  if (!matchesOrContains(surface, CANVAS_CAPABILITY_SIGNAL_SELECTOR)) return null;
  return surface;
}

export function findCanvasSurface(root: ParentNode = document): HTMLElement | null {
  for (const selector of CANVAS_SURFACE_SELECTORS) {
    const match = queryIncludingRoot(root, selector).find(isUsableHostElement);
    if (match) return match;
  }

  const editors = queryIncludingRoot(root, CANVAS_EDITOR_SELECTOR);
  for (const editor of editors) {
    if (editor.id === 'prompt-textarea') continue;
    const surface = findGenericCanvasSurface(editor);
    if (surface && isUsableHostElement(surface)) return surface;
  }
  return null;
}

export function isCanvasInteractionTarget(target: Element | null): boolean {
  return Boolean(target?.closest(CANVAS_INTERACTION_SELECTOR));
}

export function findCanvasEditableRoot(root: ParentNode = document): HTMLElement | null {
  const surface = findCanvasSurface(root);
  if (!surface) return null;
  return (
    surface.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"], .ProseMirror') ||
    surface.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]') ||
    null
  );
}

export function findCanvasActions(root: ParentNode = document): HTMLElement | null {
  const surface = findCanvasSurface(root);
  if (!surface) return null;
  return (
    surface.querySelector<HTMLElement>('[data-testid*="canvas-actions" i], [role="toolbar"]') ||
    surface.querySelector<HTMLElement>('header') ||
    null
  );
}
