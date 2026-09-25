/**
 * ChatGPT 2026-09 (Codex app shell) → legacy DOM compatibility shim.
 *
 * The 2026-09 redesign dropped almost every hook this extension was written
 * against: sidebar conversations are no longer `<a href="/c/<id>">` links, and
 * messages no longer carry `data-message-id` / `data-message-author-role`.
 * Dozens of features (folders, export, quote reply, fork, pins …) share those
 * two primitives, so instead of re-deriving the new structure in each of them
 * this shim re-creates the primitives on the new DOM:
 *
 * - Sidebar rows `[data-sidebar-chatgpt-conversation-key="chatgpt:conversation:<id>"]`
 *   get a hidden `<a data-gv-conv-link href="/c/<id>" title="<title>">`, so
 *   `a[href*="/c/"]` lookups find the row, its id and its title again.
 * - Message blocks `[data-chatgpt-search-unit-key$=":user|:assistant"]` get
 *   `data-message-author-role` + `data-message-id`, and their text roots
 *   (user bubble / assistant markdown root) get `data-message-content`.
 *
 * Only our own `data-*` attributes and a child element are added: React leaves
 * attributes it doesn't manage alone, and re-created nodes are re-tagged on the
 * next pass. On the pre-2026-09 layout none of the new hooks exist, so this is
 * a no-op there.
 */

export const CONVERSATION_ROW_KEY_ATTR = 'data-sidebar-chatgpt-conversation-key';
export const CONVERSATION_ROW_SELECTOR = `[${CONVERSATION_ROW_KEY_ATTR}^="chatgpt:conversation:"]`;
export const SHIM_LINK_ATTR = 'data-gv-conv-link';
const MESSAGE_BLOCK_SELECTOR = '[data-chatgpt-search-unit-key][data-chatgpt-search-message-ids]';
const USER_TEXT_ROOT_SELECTOR = '[data-user-message-bubble]';
const ASSISTANT_TEXT_ROOT_SELECTOR = '[data-markdown-text-style="assistant-message"]';
const SELECTION_MESSAGE_ATTR = 'data-chatgpt-selection-message-id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYNC_DELAY_MS = 60;

function setAttr(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/** `chatgpt:conversation:<uuid>` → `<uuid>`; null for projects, GPTs, etc. */
export function conversationIdFromRow(row: Element): string | null {
  const key = row.getAttribute(CONVERSATION_ROW_KEY_ATTR) ?? '';
  const id = key.startsWith('chatgpt:conversation:')
    ? key.slice('chatgpt:conversation:'.length)
    : '';
  return UUID_RE.test(id) ? id : null;
}

export function conversationTitleFromRow(row: Element): string {
  const labelled = row.querySelector('[role="button"][aria-label]')?.getAttribute('aria-label');
  if (labelled?.trim()) return labelled.trim();
  return (row.querySelector('[data-thread-title]')?.textContent ?? '').trim();
}

function syncSidebarRow(row: Element): void {
  const id = conversationIdFromRow(row);
  let link = row.querySelector<HTMLAnchorElement>(`:scope > a[${SHIM_LINK_ATTR}]`);
  if (!id) {
    link?.remove();
    return;
  }
  if (!link) {
    link = document.createElement('a');
    link.setAttribute(SHIM_LINK_ATTR, '');
    link.hidden = true;
    link.tabIndex = -1;
    link.setAttribute('aria-hidden', 'true');
    row.appendChild(link);
  }
  setAttr(link, 'href', `/c/${id}`);
  const title = conversationTitleFromRow(row);
  if (title) setAttr(link, 'title', title);
}

function syncMessageBlock(block: Element): void {
  const unit = block.getAttribute('data-chatgpt-search-unit-key') ?? '';
  const role = unit.endsWith(':user') ? 'user' : unit.endsWith(':assistant') ? 'assistant' : null;
  if (!role) return;
  const ids = (block.getAttribute('data-chatgpt-search-message-ids') ?? '')
    .split(/\s+/)
    .filter((v) => UUID_RE.test(v));
  // An assistant block can span tool / reasoning messages; the selectable
  // final answer is the message the rest of ChatGPT (and the API) keys on.
  const id =
    (role === 'assistant'
      ? block.querySelector(`[${SELECTION_MESSAGE_ATTR}]`)?.getAttribute(SELECTION_MESSAGE_ATTR)
      : null) ?? ids[0];
  if (!id) return;
  setAttr(block, 'data-message-author-role', role);
  setAttr(block, 'data-message-id', id);
  const textRoot = block.querySelector(
    role === 'user' ? USER_TEXT_ROOT_SELECTOR : ASSISTANT_TEXT_ROOT_SELECTOR,
  );
  if (textRoot) setAttr(textRoot, 'data-message-content', '');
}

const HEADER_OPTIONS_SELECTOR =
  'header [data-app-shell-header-obstacle] button[aria-haspopup="menu"]';
const ROW_OPTIONS_SELECTOR = 'button[aria-haspopup="menu"]';
const LEGACY_HEADER_OPTIONS_TESTID = 'conversation-options-button';
const CONVERSATION_ROUTE_RE = /(?:^|\/)c\/[0-9a-f-]{36}(?:[/?#]|$)/i;

/** Keep ChatGPT's own test id if it ever brings one back. */
function setTestIdIfFree(el: Element, testId: string): void {
  const current = el.getAttribute('data-testid');
  if (!current || current !== testId) {
    if (current && !el.hasAttribute('data-gv-compat-testid')) return;
    el.setAttribute('data-testid', testId);
    el.setAttribute('data-gv-compat-testid', '');
  }
}

/**
 * The conversation "…" button in the top bar (legacy
 * `[data-testid="conversation-options-button"]`): the last menu trigger of the
 * header's right-hand slot, and only on a conversation route — the home page's
 * slot holds unrelated controls.
 */
function syncHeaderOptions(): void {
  if (!CONVERSATION_ROUTE_RE.test(location.pathname)) return;
  const triggers = document.querySelectorAll(HEADER_OPTIONS_SELECTOR);
  const trigger = triggers[triggers.length - 1];
  if (trigger) setTestIdIfFree(trigger, LEGACY_HEADER_OPTIONS_TESTID);
}

function syncRowOptions(row: Element, index: number): void {
  const trigger = row.querySelector(ROW_OPTIONS_SELECTOR);
  if (trigger) setTestIdIfFree(trigger, `history-item-${index}-options`);
}

const MENU_ITEM_LABELS: ReadonlyArray<[string, RegExp]> = [
  [
    'delete-chat-menu-item',
    /^(delete|delete chat|删除|删除聊天|刪除|削除|삭제|supprimer|löschen|eliminar|excluir|удалить|elimina|verwijderen|usuń|sil|hapus|xóa)$/iu,
  ],
  [
    'share-chat-menu-item',
    /^(share|分享|共享|シェア|共有|공유|partager|teilen|compartir|compartilhar|поделиться|condividi|delen|udostępnij|paylaş|bagikan|chia sẻ)$/iu,
  ],
  [
    'rename-chat-menu-item',
    /^(rename|rename chat|重命名|重新命名|名前を変更|이름 바꾸기|renommer|umbenennen|renombrar|renomear|переименовать|rinomina|naam wijzigen|zmień nazwę)$/iu,
  ],
];

/**
 * A conversation menu (opened from a row or the top bar) gets the legacy
 * delete / share / rename item test ids back. Ownership comes from Radix's
 * `aria-labelledby` → trigger link, never from the labels alone.
 */
function syncConversationMenu(menu: Element): void {
  const triggerId = menu.getAttribute('aria-labelledby');
  const trigger = triggerId ? document.getElementById(triggerId) : null;
  const testId = trigger?.getAttribute('data-testid') ?? '';
  if (!(testId === LEGACY_HEADER_OPTIONS_TESTID || /^history-item-\d+-options$/.test(testId))) {
    return;
  }
  for (const item of Array.from(menu.querySelectorAll(':scope > [role="menuitem"]'))) {
    const label = (item.textContent ?? '').replace(/\s+/g, ' ').trim();
    const match = MENU_ITEM_LABELS.find(([, re]) => re.test(label));
    if (match) setTestIdIfFree(item, match[0]);
  }
}

const COMPOSER_EDITOR_SELECTOR = '.ProseMirror[contenteditable="true"][role="textbox"]';
const STOP_LABEL_RE =
  /^(stop|stop streaming|stop generating|停止|停止生成|停止流式传输|停止輸出|中止|停止する|중지|arrêter|detener|parar|stoppen|остановить)/iu;

/**
 * The main composer (legacy `form[data-type="unified-composer"]` with
 * `#prompt-textarea` and `[data-testid="send-button"|"stop-button"]`). Only the
 * form that carries the composer's own navigation targets qualifies, so the
 * inline "edit message" editor is never mistaken for it.
 */
function syncComposer(): void {
  for (const editor of Array.from(document.querySelectorAll(COMPOSER_EDITOR_SELECTOR))) {
    const form = editor.closest('form');
    if (!form?.querySelector('[data-composer-navigation-target]')) continue;
    setAttr(form, 'data-type', 'unified-composer');
    if (!document.getElementById('prompt-textarea')) editor.id = 'prompt-textarea';
    const submit = form.querySelector('button[type="submit"]');
    for (const button of Array.from(form.querySelectorAll('button'))) {
      const label = (button.getAttribute('aria-label') ?? '').trim();
      if (STOP_LABEL_RE.test(label)) setTestIdIfFree(button, 'stop-button');
      else if (button === submit) setTestIdIfFree(button, 'send-button');
      else if (button.hasAttribute('data-gv-compat-testid')) {
        button.removeAttribute('data-testid');
        button.removeAttribute('data-gv-compat-testid');
      }
    }
    return;
  }
}

/** One full pass. Cheap: a few dozen sidebar rows and ~a dozen mounted messages. */
export function syncChatGptDomCompat(root: ParentNode = document): void {
  root.querySelectorAll(CONVERSATION_ROW_SELECTOR).forEach((row, index) => {
    syncSidebarRow(row);
    syncRowOptions(row, index);
  });
  root.querySelectorAll(MESSAGE_BLOCK_SELECTOR).forEach(syncMessageBlock);
  syncHeaderOptions();
  syncComposer();
  root.querySelectorAll('[role="menu"][aria-labelledby]').forEach(syncConversationMenu);
}

let stopCurrent: (() => void) | null = null;

export function startChatGptDomCompat(): () => void {
  if (stopCurrent) return stopCurrent;
  let timer: number | null = null;
  const run = (): void => {
    timer = null;
    try {
      syncChatGptDomCompat();
    } catch {
      /* compatibility is best-effort; never break the page */
    }
  };
  const schedule = (): void => {
    if (timer === null) timer = window.setTimeout(run, SYNC_DELAY_MS);
  };
  // Our own writes (the shim link, `data-message-*`, `href` / `title`) never
  // trigger a pass: only element insertions and ChatGPT's own id / title
  // attributes are watched (a rename may only touch `aria-label`).
  const observer = new MutationObserver((mutations) => {
    let dirty = false;
    for (const m of mutations) {
      if (m.type === 'attributes') {
        dirty = true;
        continue;
      }
      for (const node of Array.from(m.addedNodes)) {
        if (!(node instanceof Element) || node.hasAttribute(SHIM_LINK_ATTR)) continue;
        dirty = true;
        // Radix mounts a menu on pointerdown and features inspect it on the
        // following click, so menus are tagged synchronously, not debounced.
        try {
          if (node.matches('[role="menu"][aria-labelledby]')) syncConversationMenu(node);
          node.querySelectorAll('[role="menu"][aria-labelledby]').forEach(syncConversationMenu);
        } catch {
          /* best-effort */
        }
      }
    }
    if (dirty) {
      // The header's "…" is re-rendered on every conversation switch and
      // header features re-inject right after; tag it before they look.
      try {
        syncHeaderOptions();
        // Send ⇄ stop swaps are observed by send/notification features at once.
        syncComposer();
      } catch {
        /* best-effort */
      }
      schedule();
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'aria-label',
      CONVERSATION_ROW_KEY_ATTR,
      'data-chatgpt-search-message-ids',
      SELECTION_MESSAGE_ATTR,
    ],
  });
  run();
  stopCurrent = () => {
    observer.disconnect();
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    stopCurrent = null;
  };
  return stopCurrent;
}
