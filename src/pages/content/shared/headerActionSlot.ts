/**
 * Where to inject an icon button into ChatGPT's conversation header.
 *
 * ChatGPT's 2026-07 header does NOT lay its right-side actions out as one flat
 * row. Verified live inside `#conversation-header-actions`:
 *
 *   div#conversation-header-actions        (flex row, gap-2)
 *     ├ div.-me-2                          36×36 — nested plain DIVs wrapping a
 *     │   └ div > div > span[data-state]         Radix tooltip <span>, which is
 *     │        └ button[share-chat-button]       `display: inline`
 *     └ div.flex.items-center              the genuinely horizontal group:
 *          ├ span > button (read aloud)
 *          └ div.relative > button[conversation-options-button]   ("…")
 *
 * The Share button's wrapper `<span>` is `display: inline`, so a second
 * block-level button placed beside it does NOT sit next to it — it stacks
 * underneath, and both then overflow the 52px header (one clipped above, one
 * below). That is what made the announcement and export buttons render on their
 * own lines after the redesign.
 *
 * So: anchor on `[data-testid="conversation-options-button"]`, whose parent IS
 * a real horizontal flex row, and insert before its wrapper. Everything falls
 * back to the older anchors for layouts that don't have it.
 */

export interface HeaderActionSlot {
  /** Element to `insertBefore` into. */
  parent: HTMLElement;
  /** Reference node; our button goes immediately before it (i.e. to its left). */
  before: Element | null;
  /** Native button to clone styling from — always a real button, never a wrapper. */
  styleSource: HTMLElement;
}

/**
 * The horizontal action row that holds the "…" conversation-options button.
 * Returns null outside a conversation (or on layouts without that button).
 */
export function findOptionsButtonRow(): HeaderActionSlot | null {
  const header = document.querySelector<HTMLElement>('#conversation-header-actions');
  const options = header?.querySelector<HTMLElement>('[data-testid="conversation-options-button"]');
  if (!header || !options) return null;

  const horizontal = findHorizontalRowAncestor(options, 7);
  if (horizontal) {
    return { parent: horizontal.parent, before: horizontal.before, styleSource: options };
  }

  // JSDOM and occasionally an early hydration frame do not expose computed
  // layout yet. Bound the structural fallback to the semantic header root so
  // we cannot drift into the full page header/model picker.
  if (!header.contains(options)) return null;
  let child: HTMLElement = options;
  let parent = options.parentElement;
  while (parent && parent !== header) {
    if (
      parent.querySelectorAll('button').length > 1 ||
      /(?:^|\s)flex(?:\s|$)/.test(parent.className)
    ) {
      return { parent, before: child, styleSource: options };
    }
    child = parent;
    parent = parent.parentElement;
  }
  return { parent: header, before: child, styleSource: options };
}

/**
 * True when block-level children of `el` would stack vertically rather than
 * flow in a row. Our injected buttons are `display: flex` (block-level), so any
 * container that isn't a confirmed horizontal row will stack them.
 */
export function wouldStackVertically(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  if (cs.display === 'flex' || cs.display === 'inline-flex') {
    return cs.flexDirection === 'column' || cs.flexDirection === 'column-reverse';
  }
  // Grid placement is unpredictable; inline wrappers (ChatGPT's Radix tooltip
  // spans) put block-level children into stacked anonymous blocks.
  return true;
}

/**
 * Walk up from `start` to the nearest ancestor that lays children out
 * horizontally, returning that ancestor plus the child on the path back to
 * `start` — so `insertBefore(btn, child)` lands to the LEFT of the cluster.
 *
 * Bounded by depth and by width (≤ half the viewport) so we never drift up into
 * the full-width page header and land beside the model picker.
 */
export function findHorizontalRowAncestor(
  start: HTMLElement,
  maxDepth = 5,
): { parent: HTMLElement; before: HTMLElement } | null {
  const widthLimit = Math.max(window.innerWidth * 0.5, 320);
  let child: HTMLElement = start;
  let parent: HTMLElement | null = start.parentElement;
  let depth = 0;
  while (parent && parent !== document.body && depth < maxDepth) {
    if (parent.getBoundingClientRect().width > widthLimit) break;
    if (!wouldStackVertically(parent)) return { parent, before: child };
    child = parent;
    parent = parent.parentElement;
    depth++;
  }
  return null;
}

/**
 * Slot at the LEFT end of the conversation header, mirroring `findOptionsButtonRow`
 * for the other side. Verified live (2026-08):
 *
 *   header#page-header                    (flex, justify-between)
 *     ├ div.absolute.start-1/2 …          the centred Chat/Work switcher
 *     ├ div.flex.flex-1.items-center      ← the left group
 *     │   └ div.translucent-surface…      ChatGPT's own left cluster: empty
 *     │                                   while the sidebar is open, holds the
 *     │                                   sidebar/search buttons when collapsed
 *     └ div[data-testid="thread-header-right-actions-container"]
 *
 * We append AFTER ChatGPT's own cluster so its buttons keep their positions and
 * ours follows them. The centred switcher is `position: absolute`, so it is
 * skipped by the layout check rather than by matching its class names.
 *
 * There is no button on this side to clone styling from while the sidebar is
 * open, so `styleSource` falls back to the "…" options button on the right —
 * same header, same 36×36 icon-button treatment.
 */
export function findHeaderLeftSlot(): HeaderActionSlot | null {
  const header = document.querySelector<HTMLElement>('header#page-header');
  if (!header) return null;

  const rightActions = header.querySelector<HTMLElement>(
    '[data-testid="thread-header-right-actions-container"], #conversation-header-actions',
  );

  const leftGroup = Array.from(header.children).find((child): child is HTMLElement => {
    if (!(child instanceof HTMLElement)) return false;
    if (rightActions && (child === rightActions || child.contains(rightActions))) return false;
    // The centred switcher floats above the row; only the in-flow group counts.
    return getComputedStyle(child).position !== 'absolute';
  });
  if (!leftGroup) return null;

  const styleSource =
    findOptionsButtonRow()?.styleSource ??
    header.querySelector<HTMLElement>('button') ??
    leftGroup;

  const cluster = leftGroup.querySelector<HTMLElement>('.translucent-surface');
  if (cluster) return { parent: cluster, before: null, styleSource };
  return { parent: leftGroup, before: null, styleSource };
}

/**
 * Best available slot next to ChatGPT's Share button, escaping any wrapper that
 * would stack us underneath it.
 */
export function findShareButtonSlot(): HeaderActionSlot | null {
  const share = document.querySelector<HTMLElement>('[data-testid="share-chat-button"]');
  if (!share || !share.parentElement) return null;
  const horizontal = findHorizontalRowAncestor(share);
  if (horizontal) {
    return { parent: horizontal.parent, before: horizontal.before, styleSource: share };
  }
  return { parent: share.parentElement, before: share, styleSource: share };
}
