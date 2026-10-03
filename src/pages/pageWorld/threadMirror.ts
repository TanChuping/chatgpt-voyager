/**
 * Page-world (MAIN) thread mirror — ChatGPT's 2026-09 virtualised thread.
 *
 * WHY THIS EXISTS
 * ----------------
 * ChatGPT's 2026-09 redesign (the Codex app shell) renders a conversation as a
 * virtual list: each exchange is a `div[data-turn-key="<user message id>"]`,
 * only the handful near the viewport are mounted, and an unmounted exchange
 * leaves NO placeholder at all — unlike the 2026-07 layout, whose empty
 * `div[data-turn-id-container]` wrappers `timeline/turnAnchors.ts` could tag.
 * Older history is also paged in (`/backend-api/conversations/<id>/messages`)
 * as the user scrolls up. A DOM-only timeline therefore sees ~6 turns.
 *
 * The list component keeps everything the timeline needs in React state:
 * `props.entries[i].turn.items` holds the user message (id, text, attachments)
 * and a ref holds the layout `{turnKeys, topOffsetsPx, heightsPx}` relative to
 * the list's own `position: relative` container — verified to match the
 * mounted rows to the pixel. React internals are MAIN-world only, so this
 * script reads them and mirrors each loaded exchange into the shared DOM as an
 * invisible, absolutely positioned anchor inside that container:
 *
 *   <div data-gv-thread-anchor="<uuid>" data-turn-id="u-<uuid>"
 *        data-gv-text="…" data-gv-attachments='["a.pdf"]'
 *        style="position:absolute; top:…px; height:…px"></div>
 *
 * The anchors scroll with the thread and exist for every loaded exchange, so
 * the isolated-world timeline selects them exactly like the old wrappers:
 * synchronous geometry, stable ids, text for turns that aren't mounted.
 *
 * CONTRACT
 * --------
 * - Read-only towards React; the only DOM we touch is our own anchor layer.
 * - Everything is wrapped: this must NEVER throw into ChatGPT's own code.
 * - On any structural change it simply stops producing anchors and the
 *   timeline falls back to its DOM selectors.
 */

type Dict = Record<string, unknown>;

/**
 * Must equal `THREAD_ANCHOR_ATTR` in `content/timeline/threadAnchors.ts`.
 * Deliberately NOT imported: any shared chunk turns this MAIN-world bundle
 * into a loader that calls `chrome.runtime.getURL`, which doesn't exist in the
 * page world — the whole script (fetch hook included) then silently fails.
 */
const THREAD_ANCHOR_ATTR = 'data-gv-thread-anchor';

const LAYER_ATTR = 'data-gv-thread-anchor-layer';
const TURN_KEY_SELECTOR = '[data-turn-key]';
/** List ~5, owning conversation/loading state ~20 above a mounted row. */
const MAX_CLIMB = 32;
const MAX_HOOKS = 120;
/** Enough for a dot tooltip / preview row; the full text lives in ChatGPT. */
const MAX_TEXT = 4000;
/** Safety net for thread swaps that produce no mutation we listen to. */
const POLL_MS = 1500;
/** Coalesces bursts of mutations / scroll events into one sync. */
const SYNC_DELAY_MS = 32;

interface ThreadLayout {
  turnKeys: string[];
  topOffsetsPx: number[];
  heightsPx: number[];
}

interface ThreadList {
  entries: unknown[];
  layout: ThreadLayout;
  container: HTMLElement;
  conversationId: string | null;
}

interface MirrorTurn {
  key: string;
  top: number;
  height: number;
  text: string;
  attachments: string[];
}

function asDict(v: unknown): Dict | null {
  return v !== null && typeof v === 'object' ? (v as Dict) : null;
}

function fiberOf(node: Element): Dict | null {
  for (const k in node) {
    if (k.startsWith('__reactFiber$')) return asDict((node as unknown as Dict)[k]);
  }
  return null;
}

function isLayout(v: unknown): v is ThreadLayout {
  const d = asDict(v);
  return (
    !!d &&
    Array.isArray(d.turnKeys) &&
    Array.isArray(d.topOffsetsPx) &&
    Array.isArray(d.heightsPx) &&
    d.turnKeys.length === d.topOffsetsPx.length
  );
}

/** The layout lives in a `useRef` on the list component: `{ current: layout }`. */
function readLayout(fiber: Dict): ThreadLayout | null {
  let hook = asDict(fiber.memoizedState);
  for (let i = 0; hook && i < MAX_HOOKS; i++) {
    const state = asDict(hook.memoizedState);
    if (state && 'current' in state && isLayout(state.current)) return state.current;
    hook = asDict(hook.next);
  }
  return null;
}

/** First host (DOM) node rendered by a component: the list's relative container. */
function hostNodeOf(fiber: Dict): HTMLElement | null {
  let node = asDict(fiber.child);
  for (let i = 0; node && i < 10; i++) {
    if (node.tag === 5 && node.stateNode instanceof HTMLElement) return node.stateNode;
    node = asDict(node.child);
  }
  return null;
}

/** Keep in sync with chatgptDom.findActiveConversationRoot; MAIN cannot import it. */
function activeRoot(): HTMLElement | null {
  const active = document.querySelector<HTMLElement>('[data-app-shell-active-page="true"]');
  if (active) return active.querySelector<HTMLElement>('main') ?? active;
  if (document.querySelector('[data-app-shell-active-page]')) return null;
  for (const main of document.querySelectorAll<HTMLElement>('main')) {
    let visible = true;
    for (let node: HTMLElement | null = main; node; node = node.parentElement) {
      if (
        node.hidden ||
        node.hasAttribute('inert') ||
        node.getAttribute('aria-hidden') === 'true' ||
        getComputedStyle(node).display === 'none'
      ) {
        visible = false;
        break;
      }
    }
    if (visible) return main;
  }
  return document.querySelector('main') ? null : document.body;
}

function routeConversationId(): string | null {
  return location.pathname.match(/(?:^|\/)c\/([^/?#]+)/)?.[1] ?? null;
}

/** A DOM fiber may point into the previous React tree after a commit. */
function committedFiberOf(row: Element): Dict | null {
  const fiber = fiberOf(row);
  let root = fiber;
  for (let i = 0; root && i < 100; i++) {
    const parent = asDict(root.return);
    if (!parent) break;
    root = parent;
  }
  const current = asDict(asDict(root?.stateNode)?.current);
  return current && current !== root ? (asDict(fiber?.alternate) ?? fiber) : fiber;
}

function findThreadList(): ThreadList | null {
  const root = activeRoot();
  const row = root?.querySelector(TURN_KEY_SELECTOR);
  if (!row) return null;
  let fiber = committedFiberOf(row);
  let found: ThreadList | null = null;
  let conversationId: string | null = null;
  const expected = routeConversationId();
  for (let i = 0; fiber && i < MAX_CLIMB; i++) {
    const props = asDict(fiber.memoizedProps);
    if (
      props?.isConversationLoading === true ||
      (expected &&
        typeof props?.scrollStateConversationId === 'string' &&
        props.scrollStateConversationId !== expected)
    )
      return null;
    if (typeof props?.conversationId === 'string') conversationId ??= props.conversationId;
    if (!found && props && Array.isArray(props.entries)) {
      const layout = readLayout(fiber);
      const container = layout ? hostNodeOf(fiber) : null;
      if (
        layout &&
        container?.contains(row) &&
        layout.turnKeys.includes(row.getAttribute('data-turn-key') ?? '')
      ) {
        found = { entries: props.entries, layout, container, conversationId: null };
      }
    }
    fiber = asDict(fiber.return);
  }
  if (!found) return null;
  if (conversationId && expected && conversationId !== expected) return null;
  // In the app shell a retained tree must prove which conversation it belongs to.
  if (root?.closest('[data-app-shell-active-page]') && expected && !conversationId) return null;
  found.conversationId = conversationId ?? expected;
  return found;
}

function attachmentNames(item: Dict): string[] {
  const names: string[] = [];
  for (const field of ['attachments', 'chatGptFileAttachments', 'chatGptImageAttachments']) {
    const list = item[field];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const a = asDict(raw);
      if (!a) continue;
      // 2026-09 attachment items carry the file name in `label` ({fsPath, label, path}).
      const name = [a.name, a.label, a.fileName, a.filename, a.title].find(
        (v): v is string => typeof v === 'string' && v.trim().length > 0,
      );
      if (name && !names.includes(name.trim())) names.push(name.trim());
    }
  }
  return names;
}

/** The user message of an exchange; `items` also holds reasoning / answer groups. */
function userItemOf(entry: unknown, key: string): Dict | null {
  const items = asDict(asDict(entry)?.turn)?.items;
  if (!Array.isArray(items)) return null;
  let fallback: Dict | null = null;
  for (const raw of items) {
    const item = asDict(raw);
    if (!item || typeof item.message !== 'string' || typeof item.messageId !== 'string') continue;
    if (item.messageId === key || item.serverMessageId === key) return item;
    fallback ??= item;
  }
  return fallback;
}

function readTurns(list: ThreadList): MirrorTurn[] {
  const { layout, entries } = list;
  const turns: MirrorTurn[] = [];
  for (let i = 0; i < layout.turnKeys.length; i++) {
    const key = layout.turnKeys[i];
    const top = Number(layout.topOffsetsPx[i]);
    if (typeof key !== 'string' || !key || !Number.isFinite(top)) continue;
    const item = userItemOf(entries[i], key);
    turns.push({
      key,
      top,
      height: Math.max(1, Number(layout.heightsPx[i]) || 1),
      text: item ? String(item.message).slice(0, MAX_TEXT) : '',
      attachments: item ? attachmentNames(item) : [],
    });
  }
  return turns;
}

function ensureLayer(container: HTMLElement): HTMLElement {
  let layer = container.querySelector<HTMLElement>(`:scope > [${LAYER_ATTR}]`);
  if (layer) return layer;
  layer = document.createElement('div');
  layer.setAttribute(LAYER_ATTR, '');
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText =
    'position:absolute;top:0;left:0;width:0;height:100%;pointer-events:none;visibility:hidden;';
  container.appendChild(layer);
  return layer;
}

function setAttr(el: HTMLElement, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

function writeAnchors(container: HTMLElement, turns: MirrorTurn[]): void {
  const layer = ensureLayer(container);
  const existing = new Map<string, HTMLElement>();
  for (const el of Array.from(layer.children) as HTMLElement[]) {
    const key = el.getAttribute(THREAD_ANCHOR_ATTR);
    if (key && !existing.has(key)) existing.set(key, el);
    else el.remove();
  }
  let previous: HTMLElement | null = null;
  for (const turn of turns) {
    let anchor = existing.get(turn.key);
    existing.delete(turn.key);
    if (!anchor) {
      anchor = document.createElement('div');
      anchor.setAttribute(THREAD_ANCHOR_ATTR, turn.key);
      anchor.style.position = 'absolute';
      anchor.style.left = '0';
      anchor.style.width = '1px';
    }
    // Keep DOM order == thread order: the timeline builds markers in DOM order.
    const expectedNext: ChildNode | null = previous ? previous.nextSibling : layer.firstChild;
    if (expectedNext !== anchor) layer.insertBefore(anchor, expectedNext);
    const top = `${Math.round(turn.top)}px`;
    const height = `${Math.round(turn.height)}px`;
    if (anchor.style.top !== top) anchor.style.top = top;
    if (anchor.style.height !== height) anchor.style.height = height;
    setAttr(anchor, 'data-turn-id', `u-${turn.key}`);
    setAttr(anchor, 'data-gv-text', turn.text);
    setAttr(
      anchor,
      'data-gv-attachments',
      turn.attachments.length ? JSON.stringify(turn.attachments) : null,
    );
    previous = anchor;
  }
  for (const stale of existing.values()) stale.remove();
}

// React replaces these arrays whenever the list re-measures or re-pages, so
// unchanged identities mean there is nothing to rewrite — this keeps a sync
// triggered by unrelated mutations (streaming text, hover styles) near-free.
let lastInputs: unknown[] = [];
let lastPublishedRoot: HTMLElement | null = null;
let lastPublishedConversation: string | null = null;
let lastPublishedReady = false;

function publishThread(
  root: HTMLElement | null,
  conversationId: string | null,
  ready: boolean,
  changed = false,
): void {
  if (root) {
    setAttr(root, 'data-gv-thread-conversation', conversationId);
    setAttr(root, 'data-gv-thread-status', ready ? 'ready' : 'pending');
  }
  if (
    !changed &&
    root === lastPublishedRoot &&
    conversationId === lastPublishedConversation &&
    ready === lastPublishedReady
  )
    return;
  lastPublishedRoot = root;
  lastPublishedConversation = conversationId;
  lastPublishedReady = ready;
  window.postMessage({ __gvType: 'gv-thread-updated', conversationId, ready }, location.origin);
}

/** One mirror pass; returns the number of exchanges mirrored. Exported for tests. */
export function syncThreadMirror(): number {
  const root = activeRoot();
  const expected = routeConversationId();
  const list = findThreadList();
  if (!list) {
    // Retain known anchors during virtualization of the SAME thread, but never
    // label the previous conversation's cached layer with the new route.
    if (
      !root?.querySelector(TURN_KEY_SELECTOR) &&
      root?.getAttribute('data-gv-thread-conversation') === expected &&
      root.getAttribute('data-gv-thread-status') === 'ready'
    )
      return root.querySelectorAll(`[${THREAD_ANCHOR_ATTR}]`).length;
    root?.querySelectorAll(`[${LAYER_ATTR}]`).forEach((layer) => layer.remove());
    lastInputs = [];
    publishThread(root, expected, false);
    return 0;
  }
  const { layout, entries, container } = list;
  const inputs = [
    root,
    list.conversationId,
    container,
    entries,
    layout.turnKeys,
    layout.topOffsetsPx,
    layout.heightsPx,
  ];
  const layerPresent = !!container.querySelector(`:scope > [${LAYER_ATTR}]`);
  if (layerPresent && inputs.every((v, i) => v === lastInputs[i])) {
    publishThread(root, list.conversationId, true);
    return layout.turnKeys.length;
  }
  const turns = readTurns(list);
  writeAnchors(container, turns);
  setAttr(ensureLayer(container), 'data-gv-thread-conversation', list.conversationId);
  lastInputs = inputs;
  publishThread(root, list.conversationId, true, true);
  return turns.length;
}

export function installThreadMirror(): void {
  const flag = '__gvThreadMirrorInstalled';
  if ((window as unknown as Dict)[flag]) return;
  (window as unknown as Dict)[flag] = true;

  let scheduled = false;
  const run = (): void => {
    scheduled = false;
    try {
      syncThreadMirror();
    } catch {
      /* never break ChatGPT */
    }
  };
  // A timer, not requestAnimationFrame: rAF never fires in a background tab,
  // and a conversation opened there must still have its anchors when shown.
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(run, SYNC_DELAY_MS);
  };

  // Rows mount/unmount and re-measure (inline heights) as the list renders.
  // Our own anchor writes are excluded so the observer can't feed itself.
  const isOwnMutation = (m: MutationRecord): boolean => {
    const target = m.target instanceof Element ? m.target : m.target.parentElement;
    return !!target?.closest(`[${LAYER_ATTR}]`) || (m.target as Element).hasAttribute?.(LAYER_ATTR);
  };
  const observer = new MutationObserver((mutations) => {
    if (mutations.every(isOwnMutation)) return;
    schedule();
  });
  const start = (): void => {
    try {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'data-turn-key', 'data-app-shell-active-page'],
      });
    } catch {
      /* ignore */
    }
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });

  document.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.setInterval(schedule, POLL_MS);

  // Debug hook for browser-harness verification.
  try {
    (window as unknown as Dict).__gvThreadMirror = {
      sync: syncThreadMirror,
      findThreadList,
      readTurns,
    };
  } catch {
    /* ignore */
  }
}
