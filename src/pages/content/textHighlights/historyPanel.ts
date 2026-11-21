import { extractConversationIdFromUrl } from '@/core/utils/conversationIdentity';
import { getTranslationSyncUnsafe } from '@/utils/i18n';

import { showJumpConfirmDialog } from '../favorites/jumpConfirmDialog';
import { readHighlightHistory } from './history';

const BASE = 'gv-favorites-sidebar';
const PAGE_SIZE = 30;
const t = getTranslationSyncUnsafe;
const colorInk = { yellow: '#edc65c', green: '#73cba0', blue: '#80b7f1', pink: '#e99bbb' };

function element<K extends keyof HTMLElementTagNameMap>(tag: K, suffix?: string) {
  const node = document.createElement(tag);
  if (suffix) node.className = `${BASE}__${suffix}`;
  return node;
}

function button(label: string, action: () => void, style = 'view-btn') {
  const control = element('button', style);
  control.type = 'button';
  control.textContent = label;
  control.addEventListener('click', action);
  return control;
}

function appendPages<T>(list: HTMLElement, entries: T[], render: (entry: T) => HTMLElement) {
  let offset = 0;
  function appendNextPage() {
    more.remove();
    for (const entry of entries.slice(offset, offset + PAGE_SIZE)) list.append(render(entry));
    offset += PAGE_SIZE;
    if (offset < entries.length) list.append(more);
  }
  const more = button(t('highlightHistoryMore'), () => {
    const index = list.children.length - 1;
    appendNextPage();
    const next = list.children[index];
    (next instanceof HTMLButtonElement ? next : next?.querySelector('summary'))?.focus();
  });
  appendNextPage();
}

export function renderHighlightHistory(
  root: HTMLElement,
  enabled: boolean,
  openSettings: () => void,
  onJump: () => void,
) {
  const header = element('div', 'header');
  const title = element('div', 'title');
  title.textContent = t('highlightHistoryTitle');
  header.append(title);
  const list = element('div', 'list');
  const status = element('div', 'empty');
  status.setAttribute('role', 'status');
  status.hidden = true;
  root.className = BASE;
  root.replaceChildren(header, status, list);
  const showStatus = (key: string) => {
    status.hidden = false;
    status.textContent = t(key);
  };
  if (!enabled) {
    showStatus('highlightHistoryDisabled');
    list.append(button(t('highlightHistoryOpenSettings'), openSettings, 'group-header'));
    return;
  }
  const groups = readHighlightHistory();
  if (!groups.length) {
    showStatus('highlightHistoryEmpty');
    return;
  }
  const currentId = extractConversationIdFromUrl(location.href);
  let jumping = false;
  appendPages(list, groups, ({ id, url, title, records }) => {
    const group = element('details', 'group');
    const heading = element('summary', 'group-header');
    const caret = element('span', 'group-caret');
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = id === currentId ? '▾' : '▸';
    const name = title || t('favoritesUntitledConversation');
    const groupTitle = element('span', 'group-title');
    groupTitle.textContent = name;
    groupTitle.title = name;
    const count = element('span', 'group-count');
    count.textContent = String(records.length);
    heading.append(caret, groupTitle, count);
    const rows = element('div', 'group-body');
    group.append(heading, rows);
    group.open = id === currentId;
    function mountRows() {
      if (rows.childElementCount) return;
      const chatLink = element('a', 'view-btn');
      chatLink.href = url.href;
      chatLink.target = '_blank';
      chatLink.rel = 'noopener';
      chatLink.textContent = name;
      chatLink.title = name;
      rows.append(chatLink);
      appendPages(rows, records, (record) => {
        const row = button(
          '',
          () => {
            if (jumping) return;
            jumping = true;
            const sourcePath = location.pathname;
            void (async () => {
              if (
                id !== extractConversationIdFromUrl(location.href) &&
                !(await showJumpConfirmDialog({
                  conversationTitle: name,
                  contentPreview: record.note || record.quote,
                }))
              )
                return;
              const { jumpToSavedHighlight } = await import('./index');
              // Confirming the jump closes the floating list before this import resolves.
              if (location.pathname !== sourcePath) return;
              await jumpToSavedHighlight(id, url, record);
              onJump();
            })()
              .catch(() => showStatus('highlightHistoryJumpFailed'))
              .finally(() => {
                jumping = false;
              });
          },
          'row',
        );
        row.style.width = '100%';
        row.style.textAlign = 'start';
        const swatch = element('span', 'row-star');
        swatch.textContent = '●';
        swatch.style.color = colorInk[record.color];
        swatch.setAttribute('aria-hidden', 'true');
        const body = element('span', 'row-body');
        const quote = element('span', 'row-text');
        if (record.note.trim()) quote.style.opacity = '0.66';
        quote.textContent = record.quote.trim().slice(0, 160);
        quote.title = record.quote;
        if (record.note.trim()) {
          const note = element('span', 'row-text');
          note.textContent = record.note.trim().slice(0, 160);
          note.title = record.note;
          body.append(note);
        }
        body.append(quote);
        row.append(swatch, body);
        return row;
      });
    }
    if (group.open) mountRows();
    group.addEventListener('toggle', () => {
      caret.textContent = group.open ? '▾' : '▸';
      if (group.open) mountRows();
    });
    return group;
  });
}
