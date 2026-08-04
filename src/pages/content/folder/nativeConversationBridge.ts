import {
  bindChatGptMenuTrigger,
  getChatGptConversationElement,
  getChatGptConversationId,
  getChatGptConversationTitle,
  getChatGptConversationUrl,
  normalizeChatGptConversationId,
  resolveChatGptMenuTrigger,
} from '../chatgptDom';

const SIDEBAR_OPTIONS_SELECTOR = 'button[data-testid^="history-item-"][data-testid$="-options"]';
const HEADER_OPTIONS_SELECTOR = '[data-testid="conversation-options-button"]';
const CONVERSATION_MENU_MARKERS =
  '[data-testid="delete-chat-menu-item"], [data-testid="share-chat-menu-item"]';
const DELETE_DIALOG_CONFIRM_SELECTOR = '[data-testid="delete-conversation-confirm-button"]';
const EXPLICIT_DIALOG_TITLE_SELECTOR = [
  '[data-testid="delete-conversation-title"]',
  '[data-testid="conversation-title"]',
  '[data-delete-conversation-title]',
].join(', ');

const OWNERSHIP_TOKEN_ATTRIBUTE = 'data-gv-native-menu-token';
const OWNERSHIP_EXPECTED_ID_ATTRIBUTE = 'data-gv-native-menu-expected-id';

export type NativeConversationContext = {
  id: string;
  title: string;
  url: string;
  element: HTMLElement;
};

export type NativeMenuOwnershipSnapshot = {
  trigger: HTMLElement;
  expectedId: string;
  token: string;
  existingMenus: ReadonlySet<HTMLElement>;
};

export function findConversationOptionsTrigger(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(`${SIDEBAR_OPTIONS_SELECTOR}, ${HEADER_OPTIONS_SELECTOR}`);
}

export function isHeaderConversationOptionsTrigger(trigger: HTMLElement): boolean {
  return trigger.matches(HEADER_OPTIONS_SELECTOR);
}

export function resolveSidebarConversationContext(
  trigger: HTMLElement,
): NativeConversationContext | null {
  if (!trigger.matches(SIDEBAR_OPTIONS_SELECTOR)) return null;

  const link = trigger.closest<HTMLAnchorElement>('a[href*="/c/"]');
  const scope = link ? getChatGptConversationElement(link) : getChatGptConversationElement(trigger);
  const id = normalizeChatGptConversationId(getChatGptConversationId(scope));
  const title = getChatGptConversationTitle(scope)?.trim() || '';
  const url = getChatGptConversationUrl(scope);

  if (!id || !title || !url) return null;
  return { id, title, url, element: scope };
}

export function findConversationOptionsButton(conversation: HTMLElement): HTMLElement | null {
  return conversation.querySelector<HTMLElement>(SIDEBAR_OPTIONS_SELECTOR);
}

export function isElementOpen(element: HTMLElement): boolean {
  if (!element.isConnected || element.hidden || element.getAttribute('aria-hidden') === 'true') {
    return false;
  }

  const hiddenAncestor = element.closest<HTMLElement>('[hidden], [aria-hidden="true"]');
  if (hiddenAncestor) return false;

  const stateOwner = element.matches('[data-state]')
    ? element
    : element.closest<HTMLElement>('[data-state]');
  if (stateOwner?.getAttribute('data-state') === 'closed') return false;
  if (stateOwner?.hasAttribute('data-state') && stateOwner.getAttribute('data-state') !== 'open') {
    return false;
  }

  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

export function isNativeConversationMenu(menu: HTMLElement): boolean {
  return menu.matches('[role="menu"]') && Boolean(menu.querySelector(CONVERSATION_MENU_MARKERS));
}

export function getNativeConversationMenus(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[role="menu"]')).filter(
    isNativeConversationMenu,
  );
}

export function findOpenNativeConversationMenu(root: ParentNode = document): HTMLElement | null {
  return getNativeConversationMenus(root).reverse().find(isElementOpen) ?? null;
}

export function findNativeConversationMenusInNode(node: Node): HTMLElement[] {
  if (!(node instanceof HTMLElement)) return [];
  const menus: HTMLElement[] = [];
  if (isNativeConversationMenu(node)) menus.push(node);
  node.querySelectorAll<HTMLElement>('[role="menu"]').forEach((menu) => {
    if (isNativeConversationMenu(menu)) menus.push(menu);
  });
  return menus;
}

export function createNativeMenuOwnershipSnapshot(
  trigger: HTMLElement,
  expectedId: string,
  token: string,
  root: ParentNode = document,
): NativeMenuOwnershipSnapshot | null {
  const normalizedId = normalizeChatGptConversationId(expectedId);
  if (!normalizedId || !token) return null;

  trigger.setAttribute(OWNERSHIP_TOKEN_ATTRIBUTE, token);
  trigger.setAttribute(OWNERSHIP_EXPECTED_ID_ATTRIBUTE, normalizedId);
  return {
    trigger,
    expectedId: normalizedId,
    token,
    existingMenus: new Set(root.querySelectorAll<HTMLElement>('[role="menu"]')),
  };
}

export function clearNativeMenuOwnership(snapshot: NativeMenuOwnershipSnapshot): void {
  const { trigger, token } = snapshot;
  if (trigger.getAttribute(OWNERSHIP_TOKEN_ATTRIBUTE) !== token) return;
  trigger.removeAttribute(OWNERSHIP_TOKEN_ATTRIBUTE);
  trigger.removeAttribute(OWNERSHIP_EXPECTED_ID_ATTRIBUTE);
}

function hasIdReference(value: string | null, expectedId: string): boolean {
  return Boolean(value?.split(/\s+/).filter(Boolean).includes(expectedId));
}

export function isNativeConversationMenuBoundToTrigger(
  menu: HTMLElement,
  trigger: HTMLElement,
): boolean {
  if (!trigger.isConnected) return false;

  // ChatGPT's top-bar options button lives inside the actual Radix trigger.
  // The wrapper owns aria-expanded/aria-controls; sidebar options commonly
  // carry those attributes on the button itself. Reuse the shared adapter so
  // both shapes remain explicit and no global "latest menu" heuristic leaks in.
  if (bindChatGptMenuTrigger(menu, trigger)) {
    const control = resolveChatGptMenuTrigger(menu);
    if (control && (control === trigger || control.contains(trigger))) return true;
  }

  const wrapper = trigger.closest<HTMLElement>('[aria-haspopup="menu"]');
  const candidates = wrapper && wrapper !== trigger ? [trigger, wrapper] : [trigger];
  return candidates.some((candidate) => {
    const isOpen =
      candidate.getAttribute('aria-expanded') === 'true' ||
      candidate.getAttribute('data-state') === 'open';
    return (
      isOpen &&
      Boolean(candidate.id) &&
      hasIdReference(menu.getAttribute('aria-labelledby'), candidate.id)
    );
  });
}

export function isOwnedNativeConversationMenu(
  menu: HTMLElement,
  snapshot: NativeMenuOwnershipSnapshot,
): boolean {
  const { trigger, expectedId, token, existingMenus } = snapshot;
  if (existingMenus.has(menu) || !isNativeConversationMenu(menu) || !isElementOpen(menu)) {
    return false;
  }
  if (!trigger.isConnected) return false;
  if (trigger.getAttribute(OWNERSHIP_TOKEN_ATTRIBUTE) !== token) return false;
  if (trigger.getAttribute(OWNERSHIP_EXPECTED_ID_ATTRIBUTE) !== expectedId) return false;
  if (!isHeaderConversationOptionsTrigger(trigger)) {
    const currentContext = resolveSidebarConversationContext(trigger);
    if (normalizeChatGptConversationId(currentContext?.id) !== expectedId) return false;
  }

  return isNativeConversationMenuBoundToTrigger(menu, trigger);
}

export function findDeleteConversationMenuItem(menu: HTMLElement): HTMLElement | null {
  if (!isNativeConversationMenu(menu) || !isElementOpen(menu)) return null;
  return menu.querySelector<HTMLElement>('[data-testid="delete-chat-menu-item"][role="menuitem"]');
}

export function getNativeDeleteDialogs(root: ParentNode = document): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const dialogs: HTMLElement[] = [];
  root.querySelectorAll<HTMLElement>(DELETE_DIALOG_CONFIRM_SELECTOR).forEach((confirmButton) => {
    const dialog = confirmButton.closest<HTMLElement>('[role="dialog"]');
    if (dialog && !seen.has(dialog)) {
      seen.add(dialog);
      dialogs.push(dialog);
    }
  });
  return dialogs;
}

export function findNativeDeleteDialogsInNode(node: Node): HTMLElement[] {
  if (!(node instanceof HTMLElement)) return [];
  const dialogs: HTMLElement[] = [];
  const addDialog = (candidate: HTMLElement): void => {
    const dialog = candidate.matches('[role="dialog"]')
      ? candidate
      : candidate.closest<HTMLElement>('[role="dialog"]');
    if (
      dialog &&
      dialog.querySelector(DELETE_DIALOG_CONFIRM_SELECTOR) &&
      !dialogs.includes(dialog)
    ) {
      dialogs.push(dialog);
    }
  };

  if (node.matches(DELETE_DIALOG_CONFIRM_SELECTOR) || node.matches('[role="dialog"]')) {
    addDialog(node);
  }
  node
    .querySelectorAll<HTMLElement>(`${DELETE_DIALOG_CONFIRM_SELECTOR}, [role="dialog"]`)
    .forEach(addDialog);
  return dialogs;
}

export function findNativeDeleteDialog(root: ParentNode = document): HTMLElement | null {
  return getNativeDeleteDialogs(root).reverse().find(isElementOpen) ?? null;
}

function normalizeComparableText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function extractQuotedTargets(value: string): string[] {
  const patterns = [
    /“([^”]+)”/gu,
    /‘([^’]+)’/gu,
    /「([^」]+)」/gu,
    /『([^』]+)』/gu,
    /"([^"]+)"/gu,
    /'([^']+)'/gu,
  ];
  const targets: string[] = [];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      targets.push(normalizeComparableText(match[1]));
    }
  }
  return targets;
}

export function isDeleteDialogForConversation(dialog: HTMLElement, title: string): boolean {
  const expected = normalizeComparableText(title);
  if (!expected) return false;

  const explicitTitle = dialog.querySelector<HTMLElement>(EXPLICIT_DIALOG_TITLE_SELECTOR);
  if (explicitTitle && normalizeComparableText(explicitTitle.textContent || '') === expected) {
    return true;
  }

  return extractQuotedTargets(dialog.textContent || '').includes(expected);
}

export function isOwnedNativeDeleteDialog(
  dialog: HTMLElement,
  existingDialogs: ReadonlySet<HTMLElement>,
  title: string,
): boolean {
  return (
    !existingDialogs.has(dialog) &&
    isElementOpen(dialog) &&
    isDeleteDialogForConversation(dialog, title)
  );
}

export function findDeleteConversationConfirmButton(dialog: HTMLElement): HTMLElement | null {
  if (!isElementOpen(dialog)) return null;
  return dialog.querySelector<HTMLElement>(`${DELETE_DIALOG_CONFIRM_SELECTOR}:not([disabled])`);
}

function dispatchEscape(element: HTMLElement): void {
  element.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    }),
  );
}

export function closeNativeConversationMenu(menu: HTMLElement): void {
  if (isElementOpen(menu)) dispatchEscape(menu);
}

export function closeNativeDeleteDialog(dialog: HTMLElement): void {
  if (isElementOpen(dialog)) dispatchEscape(dialog);
}
