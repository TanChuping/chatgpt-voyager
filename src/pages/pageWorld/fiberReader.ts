/**
 * Page-world (MAIN) React-fiber fallback reader.
 *
 * WHY THIS EXISTS
 * ----------------
 * `conversationHook.ts` captures conversation text by wrapping `fetch`/XHR for
 * `GET /backend-api/conversation/<id>`. But ChatGPT does NOT always fetch:
 * when a conversation is opened from its in-memory client cache (e.g. clicking
 * back to a recently-viewed thread), no network request fires, so the
 * timeline's `TurnTextCache` stays empty for any turn ChatGPT has virtualised
 * out of the DOM — the dot shows "消息未加载".
 *
 * This reader is the *fallback* for exactly that case: on request from the
 * isolated content script, it walks ChatGPT's React fiber tree (the
 * `__reactFiber$<hash>` DOM expandos — MAIN-world only, invisible to isolated
 * content scripts) to recover every USER turn's `{ id, text }`, including
 * turns that aren't currently mounted, and posts them back.
 *
 * CONTRACT
 * --------
 * - PULL-ON-DEMAND, never speculative: only runs when the content script sends
 *   `gv-fiber-request` (i.e. it actually has an unmounted cache miss).
 * - The id is ChatGPT's message UUID — the SAME id the `/backend-api` capture
 *   uses — so the content side keys it identically via `withTurnIdPrefix`.
 * - API capture stays authoritative. The content side only fills cache MISSES
 *   from this data and never lets it overwrite or prune API-derived snapshots.
 * - Everything is wrapped: this must NEVER throw into ChatGPT's own code.
 * - Fragile by nature (reads React internals). On any structural change it
 *   simply returns nothing → timeline degrades to the existing "消息未加载".
 */

type Dict = Record<string, unknown>;

interface FiberTurn {
  id: string;
  role: string;
  text: string;
}

const CONV_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Traversal bounds — generous enough to reach the conversation store from any
// seed, tight enough to stay cheap on a huge fiber tree.
const MAX_FIBER_NODES = 30000;
// Conversation message objects sit at ~depth 4 under a fiber's memoizedState
// (`<hook>.memoizedState.current.messages[i]`). Depth 6 scanned two needless
// extra levels — on a heavily-populated 120-turn chat that dragged one read to
// ~1.5s (measured live), a main-thread freeze. Depth 4 reaches every message
// the timeline displays and reads the same chat in ~80ms; the few objects only
// reachable deeper are off-branch/edited duplicates that are never shown.
// (Read time is very state-dependent — see MAX_SCAN_MS for the hard ceiling.)
const MAX_VALUE_DEPTH = 4;
const MAX_OBJECT_KEYS = 300;
const MAX_ARRAY_ITEMS = 3000;
const MAX_CLIMB = 80;
const MAX_SEEDS = 20;
// Hard wall-clock ceiling on one fiber walk so no conversation size can turn
// the (synchronous) read into a perceptible stall. Whatever was collected
// before the deadline still fills those turns; the rest degrade to the
// existing "消息未加载" placeholder.
const MAX_SCAN_MS = 250;

function nowMs(): number {
  try {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  } catch {
    return Date.now();
  }
}

function asDict(v: unknown): Dict | null {
  return v !== null && typeof v === 'object' ? (v as Dict) : null;
}

/** A ChatGPT conversation message node (same shape the API returns). */
function isMessageLike(o: Dict): boolean {
  const id = o.id;
  if (typeof id !== 'string' || !CONV_UUID_RE.test(id)) return false;
  const author = asDict(o.author);
  if (!author || typeof author.role !== 'string') return false;
  const content = asDict(o.content);
  if (!content || !Array.isArray(content.parts)) return false;
  return true;
}

/** Join the string parts of a message `content`, mirroring the API parser. */
function extractText(content: Dict): string {
  const parts = content.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p): p is string => typeof p === 'string')
    .join('\n')
    .trim();
}

/**
 * Recursively scan an arbitrary value (a fiber's memoizedProps/State subtree)
 * for message-like objects, collecting them by id. Bounded in depth, breadth,
 * and via a shared `seen` set so cyclic fiber graphs terminate.
 */
function collect(val: unknown, out: Map<string, FiberTurn>, seen: Set<object>, depth: number): void {
  if (depth > MAX_VALUE_DEPTH) return;
  const d = asDict(val);
  if (!d) return;
  if (seen.has(d)) return;
  seen.add(d);

  if (isMessageLike(d)) {
    const id = d.id as string;
    if (!out.has(id)) {
      const author = d.author as Dict;
      out.set(id, { id, role: String(author.role), text: extractText(d.content as Dict) });
    }
    // Don't stop — a message can nest other messages (e.g. parentPromptMessage).
  }

  if (Array.isArray(val)) {
    const n = Math.min(val.length, MAX_ARRAY_ITEMS);
    for (let i = 0; i < n; i++) collect(val[i], out, seen, depth + 1);
    return;
  }

  let count = 0;
  for (const k in d) {
    if (count++ > MAX_OBJECT_KEYS) break;
    try {
      collect(d[k], out, seen, depth + 1);
    } catch {
      /* getter threw — skip */
    }
  }
}

/** Return the React fiber attached to a DOM node, if any. */
function fiberOf(node: Element): Dict | null {
  for (const k in node) {
    if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) {
      return asDict((node as unknown as Dict)[k]);
    }
  }
  return null;
}

/**
 * Walk the fiber tree from a few stable DOM seeds and recover every USER turn.
 * Also exposed (below) as `window.__gvReadFiberConversation` for live tuning
 * via browser-harness.
 */
function readConversationFromFiber(): FiberTurn[] {
  const out = new Map<string, FiberTurn>();
  const seen = new Set<object>();

  const seeds: Element[] = [];
  document.querySelectorAll('[data-message-author-role]').forEach((e) => seeds.push(e));
  if (seeds.length === 0) document.querySelectorAll('article').forEach((e) => seeds.push(e));
  const main = document.querySelector('main');
  if (main) seeds.push(main);

  // Climb each seed to a high ancestor fiber, then BFS down from there so we
  // cover the whole subtree once per distinct root.
  const roots = new Set<Dict>();
  for (const el of seeds.slice(0, MAX_SEEDS)) {
    const f = fiberOf(el);
    if (!f) continue;
    let top = f;
    for (let c = 0; c < MAX_CLIMB; c++) {
      const r = asDict(top.return);
      if (!r) break;
      top = r;
    }
    roots.add(top);
  }

  const deadline = nowMs() + MAX_SCAN_MS;
  let budget = MAX_FIBER_NODES;
  outer: for (const root of roots) {
    const queue: Dict[] = [root];
    while (queue.length && budget-- > 0) {
      // Wall-clock guard: bail (keeping partial results) before any stall.
      // Check every 128 nodes — frequent enough that a heavy state can't blow
      // far past the deadline, cheap enough to be noise.
      if ((budget & 0x7f) === 0 && nowMs() > deadline) break outer;
      const fib = queue.shift();
      if (!fib) continue;
      collect(fib.memoizedProps, out, seen, 0);
      collect(fib.memoizedState, out, seen, 0);
      const child = asDict(fib.child);
      if (child) queue.push(child);
      const sibling = asDict(fib.sibling);
      if (sibling) queue.push(sibling);
    }
  }

  return Array.from(out.values());
}

/** Read only the user turns that carry text — all the cache fallback needs. */
function readUserTurns(): Array<{ id: string; text: string }> {
  try {
    return readConversationFromFiber()
      .filter((t) => t.role === 'user' && t.text.length > 0)
      .map((t) => ({ id: t.id, text: t.text }));
  } catch {
    return [];
  }
}

export function installFiberReader(): void {
  const flag = '__gvFiberReaderInstalled';
  if ((window as unknown as Dict)[flag]) return;
  (window as unknown as Dict)[flag] = true;

  // Debug hook for browser-harness tuning / verification.
  try {
    (window as unknown as Dict).__gvReadFiberConversation = readConversationFromFiber;
  } catch {
    /* ignore */
  }

  window.addEventListener('message', (ev: MessageEvent) => {
    try {
      if (ev.source !== window) return;
      const data = asDict(ev.data);
      if (!data || data.__gvType !== 'gv-fiber-request') return;
      const convId = typeof data.convId === 'string' ? data.convId : null;
      const turns = readUserTurns();
      window.postMessage(
        { __gvType: 'gv-fiber-result', payload: { convId, turns } },
        window.location.origin,
      );
    } catch {
      /* never break ChatGPT */
    }
  });
}
