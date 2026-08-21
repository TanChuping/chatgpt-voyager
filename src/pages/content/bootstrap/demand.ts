import {
  extractChatGptConversationIdFromUrl,
  findConversationHeaderActions,
  findTurnContainer,
  getTurnRole,
  isConversationOptionsTrigger,
} from '../chatgptDom';

export type BusinessDemandSignal =
  | 'quote-selection'
  | 'mermaid-code'
  | 'broken-markdown'
  | 'user-message-latex'
  | 'conversation-route'
  | 'response-action'
  | 'export-menu-interaction'
  | 'pending-export'
  | 'announcement-interaction';

export interface BusinessDemandRouter {
  start: () => void;
  stop: () => void;
}

const CODE_CANDIDATE_SELECTOR =
  'code[data-test-id="code-content"], code[data-testid="code-content"], code[class*="language-"], pre code';
const USER_MESSAGE_LATEX_SELECTOR = '[data-message-author-role="user"] .whitespace-pre-wrap';
const ASSISTANT_MESSAGE_SELECTOR =
  '[data-message-author-role="assistant"], [data-message-author-role="model"], article[data-author="assistant"], article[data-author="model"]';
const ANNOUNCEMENT_INTERACTION_SELECTOR =
  '.gv-pm-version, .gv-announcement-btn, [data-gv-announcement-btn], [data-gv-announcement-trigger]';
const LEGACY_CONVERSATION_MENU_TRIGGER_SELECTOR =
  '[data-test-id="actions-menu-button"], [data-testid="actions-menu-button"]';
const RESPONSE_MENU_TRIGGER_SELECTOR =
  '[data-test-id="more-menu-button"], [data-testid="more-menu-button"]';
const RESPONSE_COPY_ACTION_SELECTOR =
  '[data-test-id="copy-button"], [data-testid="copy-turn-action-button"]';
const EDITABLE_SELECTOR =
  '.ProseMirror, rich-textarea, textarea, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
const TEMP_CHAT_ACTIVE_SELECTOR =
  '[data-testid="temporary-chat-toggle"][aria-pressed="true"], button[aria-label*="关闭临时聊天"], button[aria-label*="close temporary chat" i], button[aria-label*="turn off temporary chat" i]';
const PENDING_EXPORT_SESSION_KEYS = [
  'gv_export_pending',
  'gv_sidebar_export_pending',
  'gv-pending-single-export',
] as const;

const MERMAID_LEAD =
  /^(?:---[\s\S]*?---\s*)?(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|xychart-beta|block-beta|packet-beta|architecture-beta|kanban|sankey-beta|requirementDiagram|C4Context)\b/i;

function isQueryableNode(node: Node): node is Document | DocumentFragment | Element {
  return node instanceof Document || node instanceof DocumentFragment || node instanceof Element;
}

/** Return matches in the added subtree plus a matching semantic owner. */
function matchingElements(node: Node, selector: string): HTMLElement[] {
  const result = new Set<HTMLElement>();
  const anchor = node instanceof Element ? node : node.parentElement;
  const owner = anchor?.closest<HTMLElement>(selector);
  if (owner) result.add(owner);

  if (node instanceof HTMLElement && node.matches(selector)) result.add(node);
  if (isQueryableNode(node)) {
    node.querySelectorAll<HTMLElement>(selector).forEach((element) => result.add(element));
  }
  return [...result];
}

function eventTargetElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof HTMLElement) return target;
  if (target instanceof Element) {
    return target.closest<HTMLElement>('button, [role="button"], [data-testid], [class]');
  }
  return null;
}

function isEditable(element: Element): boolean {
  return element.closest(EDITABLE_SELECTOR) !== null;
}

function isMermaidCandidate(code: HTMLElement): boolean {
  if (isEditable(code) || !code.closest('code-block, .code-block, pre')) return false;

  const classLanguage = [...code.classList]
    .map((className) =>
      className
        .match(/^language-(.+)$/i)?.[1]
        ?.trim()
        .toLowerCase(),
    )
    .find(Boolean);
  const attributeLanguage =
    code.getAttribute('data-language')?.trim().toLowerCase() ||
    code.getAttribute('lang')?.trim().toLowerCase();
  if (classLanguage === 'mermaid' || attributeLanguage === 'mermaid') return true;

  const container = code.closest<HTMLElement>('code-block, .code-block, pre');
  const label = container
    ?.querySelector<HTMLElement>('.code-block-decoration > span')
    ?.textContent?.trim()
    .toLowerCase();
  if (label === 'mermaid') return true;

  return MERMAID_LEAD.test(code.textContent?.trim() || '');
}

function isCurrencyStart(text: string, dollarIndex: number): boolean {
  let cursor = dollarIndex + 1;
  if (!/\d/.test(text[cursor] || '')) return false;
  while (cursor < text.length && /[\d,.]/.test(text[cursor])) cursor += 1;
  if (/[KkMmBbTt]/.test(text[cursor] || '')) cursor += 1;
  const next = text[cursor];
  return next === undefined || /[\s,;:!?)}\]]/.test(next);
}

function hasLatexCandidate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '$' || text[index - 1] === '\\') continue;

    if (text[index + 1] === '$') {
      const close = text.indexOf('$$', index + 2);
      if (close > index + 2 && text.slice(index + 2, close).trim()) return true;
      index += 1;
      continue;
    }

    if (isCurrencyStart(text, index)) continue;
    for (let close = index + 1; close < text.length; close += 1) {
      if (text[close] !== '$' || text[close - 1] === '\\') continue;
      if (text[close + 1] === '$') {
        close += 1;
        continue;
      }
      if (text.slice(index + 1, close).trim()) return true;
      break;
    }
  }
  return false;
}

function isUserMessageLatexCandidate(element: HTMLElement): boolean {
  return !isEditable(element) && hasLatexCandidate(element.textContent || '');
}

function isBrokenMarkdownText(node: Text): boolean {
  if (!node.data.includes('**')) return false;
  const parent = node.parentElement;
  if (!parent || isEditable(parent)) return false;
  if (parent.closest('code, pre, code-block, math-inline, math-block, .math-inline, .math-block')) {
    return false;
  }
  return getTurnRole(parent) === 'assistant';
}

function hasBrokenMarkdownCandidate(root: Node): boolean {
  if (root instanceof Text) return isBrokenMarkdownText(root);

  const roots: Node[] = [];
  if (root instanceof Document) {
    root
      .querySelectorAll<HTMLElement>(ASSISTANT_MESSAGE_SELECTOR)
      .forEach((message) => roots.push(message));
  } else {
    roots.push(root);
  }

  return roots.some((scanRoot) => {
    const walker = document.createTreeWalker(scanRoot, NodeFilter.SHOW_TEXT);
    let current: Node | null;
    while ((current = walker.nextNode())) {
      if (current instanceof Text && isBrokenMarkdownText(current)) return true;
    }
    return false;
  });
}

function selectionNodeElement(node: Node | null): HTMLElement | null {
  if (node instanceof HTMLElement) return node;
  if (node instanceof Element) return node.parentElement;
  return node?.parentElement || null;
}

function hasQuoteSelection(): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  if (!selection.toString().trim()) return false;

  const anchor = selectionNodeElement(selection.anchorNode);
  const focus = selectionNodeElement(selection.focusNode);
  if (!anchor || !focus || isEditable(anchor) || isEditable(focus)) return false;

  const anchorTurn = findTurnContainer(anchor);
  const focusTurn = findTurnContainer(focus);
  return Boolean(
    anchorTurn && focusTurn && getTurnRole(anchorTurn) !== null && getTurnRole(focusTurn) !== null,
  );
}

function isExportMenuInteractionTarget(target: HTMLElement): boolean {
  if (
    isConversationOptionsTrigger(target) ||
    target.closest(LEGACY_CONVERSATION_MENU_TRIGGER_SELECTOR)
  ) {
    return true;
  }
  const responseTrigger = target.closest<HTMLElement>(RESPONSE_MENU_TRIGGER_SELECTOR);
  return Boolean(responseTrigger && getTurnRole(responseTrigger) === 'assistant');
}

function hasPendingExportState(): boolean {
  try {
    return PENDING_EXPORT_SESSION_KEYS.some((key) => sessionStorage.getItem(key) !== null);
  } catch {
    return false;
  }
}

function hasTemporaryChatContext(hasPendingHandoff: boolean): boolean {
  try {
    if (new URLSearchParams(location.search).get('temporary-chat') === 'true') return true;
  } catch {
    // Fall through to private pending state and the current DOM state.
  }
  return hasPendingHandoff || document.querySelector(TEMP_CHAT_ACTIVE_SELECTOR) !== null;
}

function nodeContainsConversationHeader(node: Node): boolean {
  if (node instanceof Element && node.matches('#conversation-header-actions')) return true;
  if (isQueryableNode(node) && node.querySelector('#conversation-header-actions')) return true;
  if (node instanceof Element && node.closest('#conversation-header-actions')) return true;
  return isQueryableNode(node) && findConversationHeaderActions(node) !== null;
}

/**
 * One lightweight observer and a small set of delegated gestures cover every
 * business-demand feature. No feature module is imported by this bridge.
 */
export function createBusinessDemandRouter(
  onSignal: (signal: BusinessDemandSignal) => void,
  getPendingState: () => Promise<boolean> = async () => false,
): BusinessDemandRouter {
  const emitted = new Set<BusinessDemandSignal>();
  let observer: MutationObserver | null = null;
  let started = false;
  let generation = 0;
  let pendingTempState: 'unknown' | 'present' | 'absent' = 'unknown';

  const emit = (signal: BusinessDemandSignal) => {
    if (!started || emitted.has(signal)) return;
    emitted.add(signal);
    onSignal(signal);
  };

  const inspectConversation = (root: Node) => {
    if (emitted.has('conversation-route')) return;
    if (extractChatGptConversationIdFromUrl(location.href)) {
      emit('conversation-route');
      return;
    }
    if (pendingTempState === 'unknown') return;
    if (
      nodeContainsConversationHeader(root) &&
      !hasTemporaryChatContext(pendingTempState === 'present')
    ) {
      emit('conversation-route');
    }
  };

  const inspectCandidates = (root: Node) => {
    inspectConversation(root);

    if (
      !emitted.has('mermaid-code') &&
      matchingElements(root, CODE_CANDIDATE_SELECTOR).some(isMermaidCandidate)
    ) {
      emit('mermaid-code');
    }

    if (!emitted.has('broken-markdown') && hasBrokenMarkdownCandidate(root)) {
      emit('broken-markdown');
    }

    if (
      !emitted.has('user-message-latex') &&
      matchingElements(root, USER_MESSAGE_LATEX_SELECTOR).some(isUserMessageLatexCandidate)
    ) {
      emit('user-message-latex');
    }

    if (
      !emitted.has('response-action') &&
      matchingElements(root, RESPONSE_COPY_ACTION_SELECTOR).some(
        (button) => getTurnRole(button) === 'assistant',
      )
    ) {
      emit('response-action');
    }
  };

  const onMouseUp = () => {
    if (hasQuoteSelection()) emit('quote-selection');
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if ((event.key === 'Shift' || event.key.startsWith('Arrow')) && hasQuoteSelection()) {
      emit('quote-selection');
    }
  };

  const onPointerDown = (event: Event) => {
    const target = eventTargetElement(event.target);
    if (target && isExportMenuInteractionTarget(target)) {
      emit('export-menu-interaction');
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    const target = eventTargetElement(event.target);
    if (!target) return;
    if (isExportMenuInteractionTarget(target)) emit('export-menu-interaction');
    if (target.closest(ANNOUNCEMENT_INTERACTION_SELECTOR)) {
      emit('announcement-interaction');
    }
  };

  const onClick = (event: MouseEvent) => {
    const target = eventTargetElement(event.target);
    if (target?.closest(ANNOUNCEMENT_INTERACTION_SELECTOR)) {
      emit('announcement-interaction');
    }
  };

  const onRouteEvent = () => inspectConversation(document);

  return {
    start: () => {
      if (started) return;
      started = true;
      generation += 1;
      const activeGeneration = generation;
      pendingTempState = 'unknown';

      observer = new MutationObserver((records) => {
        if (!started) return;
        for (const record of records) {
          for (const node of record.addedNodes) inspectCandidates(node);
        }
      });
      const observationRoot = document.body || document.documentElement;
      if (observationRoot) observer.observe(observationRoot, { childList: true, subtree: true });

      document.addEventListener('mouseup', onMouseUp, true);
      document.addEventListener('keyup', onKeyUp, true);
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('click', onClick, true);
      window.addEventListener('popstate', onRouteEvent);
      window.addEventListener('hashchange', onRouteEvent);

      if (hasPendingExportState()) emit('pending-export');
      inspectCandidates(document);
      void getPendingState().then(
        (hasPending) => {
          if (!started || generation !== activeGeneration) return;
          pendingTempState = hasPending ? 'present' : 'absent';
          if (!hasPending) inspectConversation(document);
        },
        () => {
          if (!started || generation !== activeGeneration) return;
          pendingTempState = 'absent';
          inspectConversation(document);
        },
      );
    },
    stop: () => {
      if (!started) return;
      started = false;
      generation += 1;
      observer?.disconnect();
      observer = null;
      document.removeEventListener('mouseup', onMouseUp, true);
      document.removeEventListener('keyup', onKeyUp, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onRouteEvent);
      window.removeEventListener('hashchange', onRouteEvent);
    },
  };
}
