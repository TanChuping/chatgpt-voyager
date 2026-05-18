/**
 * Favorites sidebar embedded inside the floating folder panel.
 *
 * Top section: stars from the *current* conversation only — clicking jumps
 * in-page via the timeline manager (no confirmation).
 * Bottom section: every starred message across every conversation, with a
 * flat-by-time view and a grouped-by-conversation view. Clicking a row in a
 * *different* conversation prompts a confirmation before navigating away.
 */
import { getTranslationSyncUnsafe } from '@/utils/i18n';

import { StarredMessagesService } from '../timeline/StarredMessagesService';
import type { StarredMessage } from '../timeline/starredTypes';

export const FAVORITES_SIDEBAR_CLASS = 'gv-favorites-sidebar';

export type FavoritesView = 'flat' | 'grouped';

export interface FavoritesSidebarArgs {
  getCurrentConversationId: () => string | null;
  onJumpInPage: (turnId: string) => void;
  onJumpCrossConversation: (message: StarredMessage) => Promise<void> | void;
  initialView?: FavoritesView;
  onViewChange?: (view: FavoritesView) => void;
}

export interface FavoritesSidebarHandle {
  element: HTMLElement;
  refresh: () => Promise<void>;
  /**
   * Re-read i18n strings for every static label. Call this from the host
   * panel's `refreshUITexts` so a sidebar built while cachedLanguage was
   * still 'en' picks up zh after the user toggles the popup language —
   * otherwise the popover stays stuck in its mount-time language.
   */
  refreshLabels: () => void;
  destroy: () => void;
}

function t(key: string): string {
  return getTranslationSyncUnsafe(key);
}

function truncate(input: string, max: number): string {
  if (!input) return '';
  const trimmed = input.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}

function formatStarTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

function createIconBtn(
  cls: string,
  label: string,
  innerHtml: string,
  onClick: (e: MouseEvent) => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `${FAVORITES_SIDEBAR_CLASS}__icon-btn ${cls}`;
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.innerHTML = innerHtml;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return btn;
}

const TRASH_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';

const STAR_SVG =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M12 2l2.9 6.9 7.5.6-5.7 4.9 1.8 7.3L12 17.8 5.5 21.7l1.8-7.3L1.6 9.5l7.5-.6L12 2z"/></svg>';

function createRow(
  message: StarredMessage,
  options: {
    isCurrentConversation: boolean;
    showConversationTitle: boolean;
    onClick: () => void;
    onRemove: () => void;
  },
): HTMLElement {
  const row = document.createElement('div');
  row.className = `${FAVORITES_SIDEBAR_CLASS}__row`;
  if (options.isCurrentConversation) {
    row.classList.add(`${FAVORITES_SIDEBAR_CLASS}__row--current`);
  }
  row.tabIndex = 0;
  row.setAttribute('role', 'button');

  const star = document.createElement('span');
  star.className = `${FAVORITES_SIDEBAR_CLASS}__row-star`;
  star.innerHTML = STAR_SVG;
  star.setAttribute('aria-hidden', 'true');

  const body = document.createElement('div');
  body.className = `${FAVORITES_SIDEBAR_CLASS}__row-body`;

  const text = document.createElement('div');
  text.className = `${FAVORITES_SIDEBAR_CLASS}__row-text`;
  text.textContent = truncate(message.content || '', 80);
  text.title = message.content || '';
  body.appendChild(text);

  const meta = document.createElement('div');
  meta.className = `${FAVORITES_SIDEBAR_CLASS}__row-meta`;

  if (options.showConversationTitle) {
    const conv = document.createElement('span');
    conv.className = `${FAVORITES_SIDEBAR_CLASS}__row-conv`;
    conv.textContent = message.conversationTitle || t('favoritesUntitledConversation');
    conv.title = message.conversationTitle || '';
    meta.appendChild(conv);
  }

  const time = document.createElement('span');
  time.className = `${FAVORITES_SIDEBAR_CLASS}__row-time`;
  time.textContent = formatStarTime(message.starredAt);
  meta.appendChild(time);

  body.appendChild(meta);

  const removeBtn = createIconBtn(
    `${FAVORITES_SIDEBAR_CLASS}__icon-btn--remove`,
    t('favoritesRemove'),
    TRASH_SVG,
    options.onRemove,
  );

  row.appendChild(star);
  row.appendChild(body);
  row.appendChild(removeBtn);

  const trigger = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest(`.${FAVORITES_SIDEBAR_CLASS}__icon-btn`)) return;
    options.onClick();
  };
  row.addEventListener('click', trigger);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      options.onClick();
    }
  });

  return row;
}

export function mountFavoritesSidebar(args: FavoritesSidebarArgs): FavoritesSidebarHandle {
  const root = document.createElement('div');
  root.className = FAVORITES_SIDEBAR_CLASS;

  const header = document.createElement('div');
  header.className = `${FAVORITES_SIDEBAR_CLASS}__header`;
  const title = document.createElement('div');
  title.className = `${FAVORITES_SIDEBAR_CLASS}__title`;
  title.textContent = t('favoritesSidebarTitle');
  header.appendChild(title);
  root.appendChild(header);

  const currentSection = document.createElement('section');
  currentSection.className = `${FAVORITES_SIDEBAR_CLASS}__section ${FAVORITES_SIDEBAR_CLASS}__section--current`;

  const currentTitle = document.createElement('div');
  currentTitle.className = `${FAVORITES_SIDEBAR_CLASS}__section-title`;
  currentTitle.textContent = t('favoritesCurrentSectionTitle');
  currentSection.appendChild(currentTitle);

  const currentList = document.createElement('div');
  currentList.className = `${FAVORITES_SIDEBAR_CLASS}__list`;
  currentSection.appendChild(currentList);

  root.appendChild(currentSection);

  const allSection = document.createElement('section');
  allSection.className = `${FAVORITES_SIDEBAR_CLASS}__section ${FAVORITES_SIDEBAR_CLASS}__section--all`;

  const allHeader = document.createElement('div');
  allHeader.className = `${FAVORITES_SIDEBAR_CLASS}__section-header`;

  const allTitle = document.createElement('div');
  allTitle.className = `${FAVORITES_SIDEBAR_CLASS}__section-title`;
  allTitle.textContent = t('favoritesAllSectionTitle');
  allHeader.appendChild(allTitle);

  const viewToggle = document.createElement('div');
  viewToggle.className = `${FAVORITES_SIDEBAR_CLASS}__view-toggle`;
  viewToggle.setAttribute('role', 'tablist');

  let currentView: FavoritesView = args.initialView === 'grouped' ? 'grouped' : 'flat';

  const makeToggleBtn = (label: string, view: FavoritesView): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${FAVORITES_SIDEBAR_CLASS}__view-btn`;
    btn.textContent = label;
    btn.setAttribute('role', 'tab');
    btn.dataset.view = view;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentView === view) return;
      currentView = view;
      args.onViewChange?.(view);
      updateToggleSelection();
      void renderAllList();
    });
    return btn;
  };

  const flatBtn = makeToggleBtn(t('favoritesViewFlat'), 'flat');
  const groupedBtn = makeToggleBtn(t('favoritesViewGrouped'), 'grouped');
  viewToggle.appendChild(flatBtn);
  viewToggle.appendChild(groupedBtn);

  const updateToggleSelection = () => {
    flatBtn.classList.toggle(
      `${FAVORITES_SIDEBAR_CLASS}__view-btn--active`,
      currentView === 'flat',
    );
    groupedBtn.classList.toggle(
      `${FAVORITES_SIDEBAR_CLASS}__view-btn--active`,
      currentView === 'grouped',
    );
    flatBtn.setAttribute('aria-selected', currentView === 'flat' ? 'true' : 'false');
    groupedBtn.setAttribute('aria-selected', currentView === 'grouped' ? 'true' : 'false');
  };
  updateToggleSelection();

  allHeader.appendChild(viewToggle);
  allSection.appendChild(allHeader);

  const allList = document.createElement('div');
  allList.className = `${FAVORITES_SIDEBAR_CLASS}__list`;
  allSection.appendChild(allList);

  root.appendChild(allSection);

  let destroyed = false;
  // Track open/closed state per conversation group while toggling views; falsy
  // = collapsed. Persists for the lifetime of the panel.
  const groupExpanded = new Map<string, boolean>();
  let allMessages: StarredMessage[] = [];

  const handleRowClick = (message: StarredMessage): void => {
    const currentId = args.getCurrentConversationId();
    if (currentId && message.conversationId === currentId) {
      args.onJumpInPage(message.turnId);
    } else {
      void args.onJumpCrossConversation(message);
    }
  };

  const handleRowRemove = async (message: StarredMessage): Promise<void> => {
    try {
      await StarredMessagesService.removeStarredMessage(message.conversationId, message.turnId);
    } catch (error) {
      console.error('[FavoritesSidebar] Failed to remove starred message:', error);
    }
    await refresh();
  };

  const renderEmpty = (list: HTMLElement, key: string) => {
    list.textContent = '';
    const empty = document.createElement('div');
    empty.className = `${FAVORITES_SIDEBAR_CLASS}__empty`;
    empty.textContent = t(key);
    list.appendChild(empty);
  };

  const renderCurrentList = (): void => {
    currentList.textContent = '';
    const currentId = args.getCurrentConversationId();
    if (!currentId) {
      renderEmpty(currentList, 'favoritesEmptyCurrent');
      return;
    }
    const filtered = allMessages
      .filter((m) => m.conversationId === currentId)
      .sort((a, b) => b.starredAt - a.starredAt);
    if (filtered.length === 0) {
      renderEmpty(currentList, 'favoritesEmptyCurrent');
      return;
    }
    for (const m of filtered) {
      currentList.appendChild(
        createRow(m, {
          isCurrentConversation: true,
          showConversationTitle: false,
          onClick: () => handleRowClick(m),
          onRemove: () => {
            void handleRowRemove(m);
          },
        }),
      );
    }
  };

  const renderFlat = (): void => {
    const currentId = args.getCurrentConversationId();
    const sorted = [...allMessages].sort((a, b) => b.starredAt - a.starredAt);
    for (const m of sorted) {
      allList.appendChild(
        createRow(m, {
          isCurrentConversation: !!currentId && m.conversationId === currentId,
          showConversationTitle: true,
          onClick: () => handleRowClick(m),
          onRemove: () => {
            void handleRowRemove(m);
          },
        }),
      );
    }
  };

  const renderGrouped = (): void => {
    const currentId = args.getCurrentConversationId();
    // Group by conversationId. Within a group sort by starredAt desc; sort
    // groups by their newest star desc so recently used conversations bubble
    // to the top.
    const byConv = new Map<string, StarredMessage[]>();
    for (const m of allMessages) {
      const list = byConv.get(m.conversationId) ?? [];
      list.push(m);
      byConv.set(m.conversationId, list);
    }
    const groups = Array.from(byConv.entries()).map(([convId, messages]) => {
      const sortedMessages = [...messages].sort((a, b) => b.starredAt - a.starredAt);
      const newest = sortedMessages[0]?.starredAt ?? 0;
      const title = sortedMessages[0]?.conversationTitle || '';
      return { convId, title, messages: sortedMessages, newest };
    });
    groups.sort((a, b) => {
      // Current conversation always pinned to the top of the grouped list.
      if (currentId) {
        if (a.convId === currentId && b.convId !== currentId) return -1;
        if (b.convId === currentId && a.convId !== currentId) return 1;
      }
      return b.newest - a.newest;
    });

    for (const group of groups) {
      const groupEl = document.createElement('div');
      groupEl.className = `${FAVORITES_SIDEBAR_CLASS}__group`;
      if (currentId && group.convId === currentId) {
        groupEl.classList.add(`${FAVORITES_SIDEBAR_CLASS}__group--current`);
      }

      const headerEl = document.createElement('button');
      headerEl.type = 'button';
      headerEl.className = `${FAVORITES_SIDEBAR_CLASS}__group-header`;

      const caret = document.createElement('span');
      caret.className = `${FAVORITES_SIDEBAR_CLASS}__group-caret`;
      // Current conversation defaults to expanded; others collapsed unless
      // user toggled them.
      const defaultExpanded = currentId === group.convId;
      const isExpanded = groupExpanded.get(group.convId) ?? defaultExpanded;
      groupExpanded.set(group.convId, isExpanded);
      caret.textContent = isExpanded ? '▾' : '▸';

      const titleEl = document.createElement('span');
      titleEl.className = `${FAVORITES_SIDEBAR_CLASS}__group-title`;
      titleEl.textContent = group.title || t('favoritesUntitledConversation');
      titleEl.title = group.title || '';

      const count = document.createElement('span');
      count.className = `${FAVORITES_SIDEBAR_CLASS}__group-count`;
      count.textContent = String(group.messages.length);

      headerEl.appendChild(caret);
      headerEl.appendChild(titleEl);
      headerEl.appendChild(count);

      const body = document.createElement('div');
      body.className = `${FAVORITES_SIDEBAR_CLASS}__group-body`;
      if (!isExpanded) body.style.display = 'none';

      for (const m of group.messages) {
        body.appendChild(
          createRow(m, {
            isCurrentConversation: !!currentId && m.conversationId === currentId,
            showConversationTitle: false,
            onClick: () => handleRowClick(m),
            onRemove: () => {
              void handleRowRemove(m);
            },
          }),
        );
      }

      headerEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const next = !(groupExpanded.get(group.convId) ?? defaultExpanded);
        groupExpanded.set(group.convId, next);
        caret.textContent = next ? '▾' : '▸';
        body.style.display = next ? '' : 'none';
      });

      groupEl.appendChild(headerEl);
      groupEl.appendChild(body);
      allList.appendChild(groupEl);
    }
  };

  const renderAllList = async (): Promise<void> => {
    allList.textContent = '';
    if (allMessages.length === 0) {
      renderEmpty(allList, 'favoritesEmptyAll');
      return;
    }
    if (currentView === 'flat') {
      renderFlat();
    } else {
      renderGrouped();
    }
  };

  const refresh = async (): Promise<void> => {
    if (destroyed) return;
    try {
      allMessages = await StarredMessagesService.getAllStarredMessagesSorted();
    } catch (error) {
      console.error('[FavoritesSidebar] Failed to load starred messages:', error);
      allMessages = [];
    }
    if (destroyed) return;
    renderCurrentList();
    await renderAllList();
  };

  const refreshLabels = (): void => {
    title.textContent = t('favoritesSidebarTitle');
    currentTitle.textContent = t('favoritesCurrentSectionTitle');
    allTitle.textContent = t('favoritesAllSectionTitle');
    flatBtn.textContent = t('favoritesViewFlat');
    groupedBtn.textContent = t('favoritesViewGrouped');
    // Re-render row content so empty-state copy and per-row labels (remove
    // button title, untitled-conversation fallback) pick up the new locale.
    renderCurrentList();
    void renderAllList();
  };

  // Initial load — fire-and-forget; the empty placeholders will be visible
  // until the data lands.
  renderEmpty(currentList, 'favoritesEmptyCurrent');
  renderEmpty(allList, 'favoritesEmptyAll');
  void refresh();

  return {
    element: root,
    refresh,
    refreshLabels,
    destroy: () => {
      destroyed = true;
      root.remove();
    },
  };
}
