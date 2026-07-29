/**
 * Turn anchors — surviving ChatGPT's 2026-07 whole-turn virtualisation.
 *
 * Until mid-2026 ChatGPT kept every `<section data-testid="conversation-turn-N">`
 * mounted and only emptied the *body* of off-screen turns, so selecting
 * `[data-testid^="conversation-turn"][data-turn="user"]` still enumerated the
 * whole conversation (that assumption is written into `findCriticalElements`).
 *
 * The 2026-07 thread rewrite virtualises the entire turn. An off-screen turn
 * collapses to a bare placeholder:
 *
 *   <div data-turn-id-container="<uuid>" data-is-intersecting="false"
 *        class="h-[var(--last-known-height,var(--estimated-turn-height,50vh))] min-h-14"
 *        style="--estimated-turn-height: 470px"></div>
 *
 * No section, no `data-turn` role, no text. Only the handful of turns near the
 * viewport keep their `<section>`. A DOM-only timeline therefore renders 2–3
 * dots no matter how long the conversation is.
 *
 * What *does* survive is the wrapper: every turn — mounted or not — keeps a
 * `div[data-turn-id-container]` at its true scroll offset with its last known
 * height. And for USER turns that uuid is exactly the message id we already
 * hold, because the timeline's own turn ids are `u-<message uuid>` (see
 * `withTurnIdPrefix`), fed by the `/backend-api/conversation` capture and the
 * React-fiber fallback.
 *
 * So the repair is: take the user turn ids we already know, tag their wrappers,
 * and let the timeline select the wrappers instead of the mostly-absent
 * sections. Everything downstream — geometry, id allocation, the turn-text
 * cache — keeps working unchanged, because the outer wrapper was already the
 * element the marker code was written against.
 */

/** Attribute we stamp on a wrapper we have positively identified as a user turn. */
const ANCHOR_ATTR = 'data-gv-user-turn';

/** Selector for the wrappers tagged by {@link syncUserTurnAnchors}. */
export const USER_TURN_ANCHOR_SELECTOR = `div[${ANCHOR_ATTR}="1"]`;

/**
 * Every turn wrapper, mounted or virtualised. Restricted to `div` on purpose:
 * a mounted turn repeats `data-turn-id-container` on its inner `<section>`,
 * and we only ever want the outer element (stable geometry when virtualised).
 */
export const TURN_CONTAINER_SELECTOR = 'div[data-turn-id-container]';

/** ChatGPT's placeholder for a not-yet-sent client turn — never a real turn. */
const CLIENT_ROOT_ID = 'client-created-root';

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * `u-<uuid>` (the timeline / cache id form) → `<uuid>` (what ChatGPT puts in
 * `data-turn-id-container`). Returns null for synthesised ids such as
 * `u-3-1f4b9c` that the manager allocates when no message uuid was available —
 * those can never match a wrapper.
 */
export function messageIdFromTurnId(turnId: string | null | undefined): string | null {
  const raw = (turnId ?? '').trim().replace(/^u-/i, '');
  return UUID_RE.test(raw) ? raw.toLowerCase() : null;
}

/** All real turn wrappers in document order. */
export function listTurnContainers(root: ParentNode = document): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>(TURN_CONTAINER_SELECTOR));
  return all.filter((el) => el.getAttribute('data-turn-id-container') !== CLIENT_ROOT_ID);
}

/** True when ChatGPT still has this turn's real content mounted. */
function isMounted(container: HTMLElement): boolean {
  return container.querySelector('[data-testid^="conversation-turn"]') !== null;
}

/**
 * Tag the wrapper of every known user turn so the timeline can select it even
 * while ChatGPT has the turn virtualised, and untag wrappers that are no longer
 * user turns (edit/branch churn). Also mirrors the id onto `data-turn-id` so
 * `ensureTurnId` keeps allocating the same marker id the cache/pins are stored
 * under.
 *
 * Returns how many wrappers carry the tag afterwards.
 */
export function syncUserTurnAnchors(
  userTurnIds: Iterable<string>,
  root: ParentNode = document,
): number {
  const wanted = new Set<string>();
  for (const turnId of userTurnIds) {
    const messageId = messageIdFromTurnId(turnId);
    if (messageId) wanted.add(messageId);
  }

  let tagged = 0;
  for (const container of listTurnContainers(root)) {
    const id = (container.getAttribute('data-turn-id-container') ?? '').toLowerCase();
    if (id && wanted.has(id)) {
      if (container.getAttribute(ANCHOR_ATTR) !== '1') container.setAttribute(ANCHOR_ATTR, '1');
      const markerId = `u-${id}`;
      try {
        if (container.dataset.turnId !== markerId) container.dataset.turnId = markerId;
      } catch {
        /* dataset unavailable — the anchor attribute alone is enough to select it */
      }
      tagged++;
    } else if (container.hasAttribute(ANCHOR_ATTR)) {
      container.removeAttribute(ANCHOR_ATTR);
    }
  }
  return tagged;
}

/**
 * Turn wrappers we can neither classify nor read: virtualised (no mounted
 * section) *and* not tagged as a user turn. A non-zero count means the
 * conversation data hasn't reached us yet — the signal that makes the
 * React-fiber fallback fire even though every marker we currently have looks
 * healthy (the pre-2026-07 miss predicate only noticed *empty* markers, and a
 * turn that never became a marker at all is invisible to it).
 */
export function countUnresolvedTurnContainers(root: ParentNode = document): number {
  let unresolved = 0;
  for (const container of listTurnContainers(root)) {
    if (container.getAttribute(ANCHOR_ATTR) === '1') continue;
    if (isMounted(container)) continue;
    unresolved++;
  }
  return unresolved;
}

/** Prepend the anchor selector to a user-turn selector, without duplicating it. */
export function withUserTurnAnchors(selector: string): string {
  if (!selector) return USER_TURN_ANCHOR_SELECTOR;
  if (selector.includes(USER_TURN_ANCHOR_SELECTOR)) return selector;
  return `${USER_TURN_ANCHOR_SELECTOR},${selector}`;
}
