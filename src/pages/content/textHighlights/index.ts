import { extractConversationIdFromUrl } from '@/core/utils/conversationIdentity';
import { getTranslationSync } from '@/utils/i18n';

import { findActiveConversationRoot, findActiveConversationScrollContainer } from '../chatgptDom';
import {
  HIGHLIGHTS_PREFIX,
  HIGHLIGHT_COLORS,
  type HighlightColor,
  type TextHighlight,
  captureTextAnchor,
  readHighlights,
  resolveTextAnchor,
} from './anchors';
import editorCss from './editor.css?inline';
import { PENDING_HIGHLIGHT, getHighlightConversationTitle, navigateToHighlight } from './history';

const MESSAGE = '[data-chatgpt-search-unit-key], [data-message-id][data-message-author-role]';
const USER_CONTENT = '[data-user-message-bubble]';
const ASSISTANT_CONTENT = '[data-markdown-text-style]';
const NATIVE_CONTENT = `${USER_CONTENT}, ${ASSISTANT_CONTENT}`;
const CONTENT = '[data-message-content], .markdown, .whitespace-pre-wrap';
const PALETTE = {
  yellow: { ink: '#edc65c', label: 'textHighlightYellow' },
  green: { ink: '#73cba0', label: 'textHighlightGreen' },
  blue: { ink: '#80b7f1', label: 'textHighlightBlue' },
  pink: { ink: '#e99bbb', label: 'textHighlightPink' },
} as const;

function glyph(name: 'pen' | 'check' | 'note' | 'delete') {
  const paths = {
    pen: 'm13 5 6 6M4 18l3-6L17 2l5 5L12 17l-6 3-2-2ZM3 22h9',
    check: 'm5 12 4 4L19 6',
    note: 'M5 4h14v10l-6 6H5zM13 20v-6h6M8 8h8M8 11h5',
    delete: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.9');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[name]);
  svg.append(path);
  return svg;
}

function getKey(): string | null {
  const id = extractConversationIdFromUrl(location.href);
  return id ? HIGHLIGHTS_PREFIX + id : null;
}

function getTextRoot(message: Element): Element {
  if (message.matches(NATIVE_CONTENT)) return message;
  return message.querySelector(NATIVE_CONTENT) ?? message.querySelector(CONTENT) ?? message;
}

function getMessageId(message: Element): string | null {
  const unit = message.getAttribute('data-chatgpt-search-unit-key');
  const content = getTextRoot(message);
  const isUser = unit?.endsWith(':user') || content.matches(USER_CONTENT);
  const isAssistant = unit?.endsWith(':assistant') || content.matches(ASSISTANT_CONTENT);
  const selected =
    isAssistant &&
    (content.closest('[data-chatgpt-selection-message-id]') ??
      message.querySelector('[data-chatgpt-selection-message-id]'));
  const selectedId = selected && selected.getAttribute('data-chatgpt-selection-message-id');
  const legacyId = message.getAttribute('data-message-id');
  const searchId = message.getAttribute('data-chatgpt-search-message-ids')?.trim().split(/\s+/)[0];
  const turn = message.closest('[data-turn-key]')?.getAttribute('data-turn-key');
  if (unit && !isUser && !isAssistant && !legacyId) return null;
  return (
    selectedId ||
    legacyId ||
    searchId ||
    (unit && `unit:${unit}`) ||
    (turn && (isUser || isAssistant) ? `turn:${turn}:${isUser ? 'user' : 'assistant'}` : null)
  );
}

let jumpInPage: ((record: TextHighlight) => Promise<boolean>) | undefined;

export async function jumpToSavedHighlight(id: string, url: URL, record: TextHighlight) {
  if (extractConversationIdFromUrl(location.href) === id && (await jumpInPage?.(record))) return;
  navigateToHighlight(id, url, record);
}

export function startTextHighlights(): () => void {
  const registry = globalThis.CSS?.highlights;
  if (!registry || typeof Highlight !== 'function') return () => {};

  const style = document.createElement('style');
  style.textContent =
    editorCss +
    HIGHLIGHT_COLORS.map(
      (color) =>
        `::highlight(gv-text-${color}), ::highlight(gv-draft-${color}) { background-color: ${PALETTE[color].ink}7a; }`,
    ).join('\n');
  document.head.append(style);

  const panel = document.createElement('div');
  panel.hidden = true;
  panel.className = 'gv-hl-panel';
  document.body.append(panel);
  let frame = 0;
  let editorOpen = false;
  let key: string | null = null;
  let records: TextHighlight[] = [];
  let watchedRoot: HTMLElement | null = null;
  let rendered: { record: TextHighlight; range: Range }[] = [];

  let draftColor: HighlightColor | null = null;
  let editingId: string | null = null;
  function clearPreview() {
    if (draftColor) registry.delete(`gv-draft-${draftColor}`);
    draftColor = null;
  }
  function closePanel() {
    clearPreview();
    const restoreMark = editingId !== null;
    editingId = null;
    editorOpen = false;
    panel.hidden = true;
    panel.replaceChildren();
    if (restoreMark) refresh();
  }

  function refresh() {
    rendered = [];
    const groups = HIGHLIGHT_COLORS.map(() => new Highlight());
    if (watchedRoot) {
      if (records.length) {
        const messages = new Map(
          Array.from(watchedRoot.querySelectorAll(`${MESSAGE}, ${NATIVE_CONTENT}`), (element) => {
            const message = element.closest(MESSAGE) ?? element;
            return [getMessageId(message), message] as const;
          }),
        );
        for (const record of records) {
          if (record.id === editingId) continue;
          const message = messages.get(record.messageId);
          if (!message) continue;
          const range = resolveTextAnchor(getTextRoot(message), record);
          if (!range) continue;
          groups[HIGHLIGHT_COLORS.indexOf(record.color)].add(range);
          rendered.push({ record, range });
        }
      }
    }
    HIGHLIGHT_COLORS.forEach((color, index) => registry.set(`gv-text-${color}`, groups[index]));
  }

  function scrollToRect(top: number): boolean {
    const scroller = findActiveConversationScrollContainer();
    if (!scroller) return false;
    const viewportTop =
      scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
    scroller.scrollTop += top - viewportTop - scroller.clientHeight * 0.33;
    return true;
  }

  function findPlaceholder(record: TextHighlight): Element | null {
    const turnKey =
      (typeof record.turnId === 'string' && record.turnId) ||
      /^(?:unit|turn):(.+):(?:user|assistant)$/.exec(record.messageId)?.[1] ||
      record.messageId;
    const id = CSS.escape(turnKey);
    const root = findActiveConversationRoot();
    const activePage = root?.closest('[data-app-shell-active-page="true"]') ?? root;
    return (
      activePage?.querySelector(
        `[data-turn-key="${id}"], [data-turn-id-container="${id}"], [data-gv-thread-anchor="${id}"]`,
      ) ?? null
    );
  }

  function jumpToRange(record: TextHighlight): boolean {
    const root = findActiveConversationRoot();
    if (!root || root === document.body) return false;
    const messages = new Set(
      Array.from(
        root.querySelectorAll(`${MESSAGE}, ${NATIVE_CONTENT}`),
        (element) => element.closest(MESSAGE) ?? element,
      ),
    );
    for (const message of messages) {
      if (getMessageId(message) !== record.messageId) continue;
      const range = resolveTextAnchor(getTextRoot(message), record);
      const rect = range?.getBoundingClientRect();
      if (!range || !rect || (!rect.width && !rect.height)) continue;
      return scrollToRect(rect.top);
    }
    return false;
  }

  function scheduleRefresh() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      refresh();
    });
  }

  function button(
    label: Parameters<typeof getTranslationSync>[0],
    action: () => void,
  ): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = getTranslationSync(label);
    element.addEventListener('click', action);
    return element;
  }

  function showAt(x: number, y: number) {
    panel.hidden = false;
    panel.style.left = `${Math.max(8, Math.min(x, innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(y, innerHeight - panel.offsetHeight - 8))}px`;
  }

  function update(storageKey: string, record: TextHighlight, remove: boolean) {
    if (getKey() !== storageKey) {
      closePanel();
      return;
    }
    const records = readHighlights(storageKey).filter(({ id }) => id !== record.id);
    if (!remove) {
      const id = storageKey.slice(HIGHLIGHTS_PREFIX.length);
      const url = new URL(location.href);
      url.hash = '';
      url.search = '';
      records.push({
        ...record,
        conversationTitle: getHighlightConversationTitle(id) ?? record.conversationTitle,
        conversationUrl: url.href,
        updatedAt: Date.now(),
      });
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(records));
      closePanel();
      reload();
    } catch {
      const error = document.createElement('div');
      error.setAttribute('role', 'alert');
      error.textContent = getTranslationSync('textHighlightStorageError');
      panel.querySelector('[role="alert"]')?.remove();
      panel.append(error);
    }
  }

  function openEditor(
    storageKey: string,
    record: TextHighlight,
    existing: boolean,
    x: number,
    y: number,
    range: Range,
  ) {
    editorOpen = true;
    if (existing) {
      editingId = record.id;
      refresh();
    }
    const card = document.createElement('div');
    card.className = 'gv-hl-card';
    card.setAttribute('role', 'dialog');
    const title = getTranslationSync(existing ? 'textHighlightEdit' : 'textHighlightAdd');
    card.setAttribute('aria-label', title);
    const bar = document.createElement('div');
    bar.className = 'gv-hl-bar';
    const palette = document.createElement('div');
    palette.setAttribute('role', 'radiogroup');
    palette.setAttribute('aria-label', getTranslationSync('textHighlightColor'));
    palette.className = 'gv-hl-palette';
    let selected = record.color;
    function preview(color: HighlightColor) {
      clearPreview();
      selected = color;
      draftColor = color;
      registry.set(`gv-draft-${color}`, new Highlight(range));
    }
    for (const color of HIGHLIGHT_COLORS) {
      const swatch = document.createElement('label');
      swatch.className = 'gv-hl-swatch';
      swatch.title = getTranslationSync(PALETTE[color].label);
      swatch.style.setProperty('--hl-ink', PALETTE[color].ink);
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'gv-hl-color';
      input.value = color;
      input.checked = color === selected;
      input.setAttribute('aria-label', swatch.title);
      input.addEventListener('change', () => preview(color));
      const sample = document.createElement('span');
      sample.className = 'gv-hl-sample';
      sample.append(glyph('check'));
      swatch.append(input, sample);
      palette.append(swatch);
    }
    const note = document.createElement('textarea');
    note.className = 'gv-hl-note';
    note.dir = 'auto';
    note.rows = 2;
    note.placeholder = getTranslationSync('textHighlightNote');
    note.setAttribute('aria-label', note.placeholder);
    note.value = record.note;
    note.hidden = !record.note;
    function iconButton(
      label: Parameters<typeof getTranslationSync>[0],
      icon: Parameters<typeof glyph>[0],
      action: () => void,
    ) {
      const control = button(label, action);
      control.title = getTranslationSync(label);
      control.setAttribute('aria-label', control.title);
      control.replaceChildren(glyph(icon));
      return control;
    }
    const toggle = iconButton('textHighlightNote', 'note', () => {
      note.hidden = !note.hidden;
      toggle.setAttribute('aria-expanded', String(!note.hidden));
      showAt(x, y);
      if (!note.hidden) note.focus({ preventScroll: true });
    });
    toggle.className = 'gv-hl-note-toggle';
    toggle.setAttribute('aria-expanded', String(!note.hidden));
    bar.append(palette, toggle);
    if (existing) {
      const del = iconButton('textHighlightDelete', 'delete', () =>
        update(storageKey, record, true),
      );
      del.className = 'gv-hl-delete';
      bar.append(del);
    }
    const save = iconButton('textHighlightSave', 'check', () => {
      update(storageKey, { ...record, color: selected, note: note.value }, false);
    });
    save.className = 'gv-hl-save';
    bar.append(save);
    card.append(bar, note);
    panel.replaceChildren(card);
    preview(selected);
    showAt(x, y);
    window.getSelection()?.removeAllRanges();
    palette.querySelector<HTMLInputElement>('input:checked')?.focus({ preventScroll: true });
  }

  function onSelection() {
    if (editorOpen) return;
    closePanel();
    const storageKey = getKey();
    const selection = window.getSelection();
    if (!storageKey || !selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const element =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    const message = element?.closest(MESSAGE) ?? element?.closest(NATIVE_CONTENT);
    const messageId = message && getMessageId(message);
    if (!message || !messageId || !findActiveConversationRoot()?.contains(message)) return;
    if (element?.closest('[contenteditable],button')) return;
    const anchor = captureTextAnchor(getTextRoot(message), range);
    if (!anchor || anchor.quote.length > 20_000) return;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    if (storageKey !== key) reload();
    const existing = records.find(
      (record) =>
        record.messageId === messageId &&
        record.start === anchor.start &&
        record.quote === anchor.quote,
    );
    const chip = button(existing ? 'textHighlightEdit' : 'textHighlightAdd', () => {
      openEditor(
        storageKey,
        existing ?? {
          ...anchor,
          id: crypto.randomUUID(),
          messageId,
          turnId:
            message
              .closest('[data-turn-key], [data-turn-id-container]')
              ?.getAttribute('data-turn-key') ??
            message.closest('[data-turn-id-container]')?.getAttribute('data-turn-id-container') ??
            undefined,
          color: 'yellow',
          note: '',
          updatedAt: 0,
        },
        !!existing,
        rect.left,
        rect.bottom + 6,
        range,
      );
    });
    chip.className = 'gv-hl-chip';
    chip.prepend(glyph('pen'));
    panel.replaceChildren(chip);
    showAt(rect.left, rect.bottom + 6);
  }

  function onClick(event: MouseEvent) {
    if (!(event.target instanceof Node) || event.composedPath().includes(panel)) return;
    if (editorOpen) closePanel();
    if (!window.getSelection()?.isCollapsed) return;
    if (event.target instanceof Element && event.target.closest('a,button,[contenteditable]'))
      return;
    const storageKey = getKey();
    if (!storageKey || storageKey !== key) return;
    const match = [...rendered]
      .reverse()
      .find(
        ({ range }) =>
          range.commonAncestorContainer.isConnected &&
          Array.from(range.getClientRects()).some(
            ({ left, top, right, bottom }) =>
              event.clientX >= left &&
              event.clientX <= right &&
              event.clientY >= top &&
              event.clientY <= bottom,
          ),
      );
    if (match)
      openEditor(storageKey, match.record, true, event.clientX, event.clientY + 8, match.range);
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === 'Escape') closePanel();
    if (event.key === 'Shift' || event.key.startsWith('Arrow')) onSelection();
  }

  function onMouseUp(event: MouseEvent) {
    if (event.target instanceof Node && !panel.contains(event.target)) onSelection();
  }

  function onScroll(event: Event) {
    if (event.target instanceof Node && panel.contains(event.target)) return;
    if (!editorOpen) closePanel();
  }

  const relevant = `${MESSAGE}, ${NATIVE_CONTENT}, [data-turn-key]`;
  const observer = new MutationObserver((mutations) => {
    if (
      mutations.some(({ target, addedNodes, removedNodes }) => {
        const element = target instanceof Element ? target : target.parentElement;
        return (
          element?.closest(relevant) ||
          [...addedNodes, ...removedNodes].some(
            (node) =>
              node instanceof Element && (node.matches(relevant) || node.querySelector(relevant)),
          )
        );
      })
    )
      scheduleRefresh();
  });

  function watchConversation() {
    const root = records.length ? findActiveConversationRoot() : null;
    const nextRoot = root === document.body ? null : root;
    if (nextRoot === watchedRoot) return false;
    observer.disconnect();
    watchedRoot = nextRoot;
    if (watchedRoot)
      observer.observe(watchedRoot, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
          'data-message-id',
          'data-chatgpt-search-message-ids',
          'data-chatgpt-selection-message-id',
        ],
      });
    return true;
  }

  function reload() {
    const nextKey = getKey();
    if (nextKey !== key) closePanel();
    key = nextKey;
    records = key ? readHighlights(key) : [];
    watchConversation();
    refresh();
  }

  function onStorage(event: StorageEvent) {
    if (event.key === null || event.key === key) reload();
  }

  let path = location.pathname;
  const routeTimer = window.setInterval(() => {
    if (location.pathname !== path) {
      path = location.pathname;
      reload();
    } else if (
      (!watchedRoot?.isConnected || watchedRoot.closest('[data-app-shell-active-page="false"]')) &&
      records.length &&
      watchConversation()
    ) {
      scheduleRefresh();
    }
  }, 400);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keyup', onKey);
  document.addEventListener('click', onClick);
  window.addEventListener('storage', onStorage);
  window.addEventListener('popstate', reload);
  window.addEventListener('scroll', onScroll, true);
  reload();
  async function jumpToMountedRange(record: TextHighlight): Promise<boolean> {
    cancelPendingJump();
    if (jumpToRange(record)) return true;
    const placeholder = findPlaceholder(record);
    if (!placeholder || !scrollToRect(placeholder.getBoundingClientRect().top)) return false;
    const originKey = getKey();
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      // A user navigation or lifecycle teardown cancels the original request.
      if (getKey() !== originKey || jumpInPage !== jumpToMountedRange) return true;
      if (jumpToRange(record)) return true;
    }
    return false;
  }
  jumpInPage = jumpToMountedRange;
  const pendingJump = new AbortController();
  function cancelPendingJump() {
    pendingJump.abort();
  }
  async function resumePendingJump() {
    let pending: { id?: string; recordId?: string; expires?: number } | null;
    try {
      pending = JSON.parse(sessionStorage.getItem(PENDING_HIGHLIGHT) ?? 'null');
      if (!pending) return;
      sessionStorage.removeItem(PENDING_HIGHLIGHT);
    } catch {
      return;
    }
    if (!pending.expires || pending.expires <= Date.now() || key !== HIGHLIGHTS_PREFIX + pending.id)
      return;
    const record = records.find((entry) => entry.id === pending.recordId);
    if (!record) return;
    const originKey = key;
    const current = () => !pendingJump.signal.aborted && getKey() === originKey;
    document.addEventListener('wheel', cancelPendingJump, {
      signal: pendingJump.signal,
      passive: true,
    });
    document.addEventListener('touchstart', cancelPendingJump, {
      signal: pendingJump.signal,
      passive: true,
    });
    let stableTop = 0;
    let lastTop = Number.NaN;
    let lastHeight = -1;
    const nativeDeeplink = new URL(location.href).searchParams.has('messageId');
    const deadline = Date.now() + (nativeDeeplink ? 15_000 : 40_000);

    while (current() && Date.now() < deadline) {
      if (jumpToRange(record)) {
        cancelPendingJump();
        return;
      }
      const placeholder = findPlaceholder(record);
      const scroller = findActiveConversationScrollContainer();
      if (placeholder) {
        scrollToRect(placeholder.getBoundingClientRect().top);
      } else if (!nativeDeeplink && scroller?.clientHeight) {
        const height = scroller.scrollHeight;
        const top =
          getComputedStyle(scroller).flexDirection === 'column-reverse'
            ? Math.min(0, scroller.clientHeight - height)
            : 0;
        if (scroller.scrollTop <= top + 2 && top === lastTop && height === lastHeight) {
          if (++stableTop >= 3) break;
        } else stableTop = 0;
        lastTop = top;
        lastHeight = height;
        scroller.scrollTop = Math.max(top, scroller.scrollTop - scroller.clientHeight * 0.8);
      }
      await new Promise((resolve) => window.setTimeout(resolve, stableTop ? 900 : 180));
    }
    if (current()) {
      panel.textContent = getTranslationSync(
        'highlightHistoryJumpFailed' as Parameters<typeof getTranslationSync>[0],
      );
      panel.setAttribute('role', 'status');
      showAt(12, 12);
    }
    cancelPendingJump();
  }
  void resumePendingJump();
  return () => {
    cancelPendingJump();
    if (jumpInPage === jumpToMountedRange) jumpInPage = undefined;
    clearPreview();
    observer.disconnect();
    clearInterval(routeTimer);
    if (frame) cancelAnimationFrame(frame);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('keyup', onKey);
    document.removeEventListener('click', onClick);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('popstate', reload);
    window.removeEventListener('scroll', onScroll, true);
    HIGHLIGHT_COLORS.forEach((color) => registry.delete(`gv-text-${color}`));
    panel.remove();
    style.remove();
  };
}
