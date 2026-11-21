import { extractConversationIdFromUrl } from '@/core/utils/conversationIdentity';
import { buildStarredMessageUrl } from '@/core/utils/starredNavigation';

import { getChatGptConversationTitle } from '../chatgptDom';
import { HIGHLIGHTS_PREFIX, type TextHighlight, readHighlights } from './anchors';

export const PENDING_HIGHLIGHT = 'gv:pending-highlight';

function getConversationLinks() {
  const links = new Map<string, HTMLAnchorElement>();
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>(
    'nav a[href*="/c/"], aside a[href*="/c/"], .gv-folder-panel a[href*="/c/"]',
  )) {
    const id = extractConversationIdFromUrl(anchor.href);
    if (id && !links.has(id)) links.set(id, anchor);
  }
  return links;
}

export function getHighlightConversationTitle(
  id: string,
  link: HTMLAnchorElement | null | undefined = getConversationLinks().get(id),
): string | undefined {
  const pageTitle = extractConversationIdFromUrl(location.href) === id ? document.title.trim() : '';
  return (
    (link && getChatGptConversationTitle(link)) ||
    (pageTitle && !/^ChatGPT$/i.test(pageTitle) ? pageTitle : undefined)
  );
}

export function getHighlightConversationUrl(id: string, savedUrl?: string): URL {
  try {
    const url = new URL(savedUrl ?? '', location.origin);
    if (url.origin === location.origin && extractConversationIdFromUrl(url.href) === id) {
      url.hash = '';
      url.search = '';
      return url;
    }
  } catch {
    // Older records and invalid URLs fall back to the canonical chat route.
  }
  return new URL('/c/' + encodeURIComponent(id), location.origin);
}

export function readHighlightHistory() {
  const groups: { id: string; url: URL; title?: string; records: TextHighlight[] }[] = [];
  const links = getConversationLinks();
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(HIGHLIGHTS_PREFIX)) continue;
      const id = key.slice(HIGHLIGHTS_PREFIX.length);
      const records = readHighlights(key).sort((a, b) => b.updatedAt - a.updatedAt);
      if (!id || !records.length) continue;
      const title =
        getHighlightConversationTitle(id, links.get(id) ?? null) ||
        records.find(
          (record) => typeof record.conversationTitle === 'string' && record.conversationTitle,
        )?.conversationTitle;
      const url = getHighlightConversationUrl(
        id,
        records.find((record) => typeof record.conversationUrl === 'string')?.conversationUrl ??
          links.get(id)?.href,
      );
      groups.push({ id, url, title, records });
    }
  } catch {
    // Storage may be unavailable.
  }
  const currentId = extractConversationIdFromUrl(location.href);
  return groups.sort(
    (a, b) =>
      Number(b.id === currentId) - Number(a.id === currentId) ||
      b.records[0].updatedAt - a.records[0].updatedAt,
  );
}

export function navigateToHighlight(id: string, url: URL, record: TextHighlight): void {
  sessionStorage.setItem(
    PENDING_HIGHLIGHT,
    JSON.stringify({ id, recordId: record.id, expires: Date.now() + 60_000 }),
  );
  const turnId = (typeof record.turnId === 'string' && record.turnId) || record.messageId;
  const targetUrl = new URL(buildStarredMessageUrl(url.href, turnId));
  targetUrl.hash = '';
  try {
    // Re-clicking a native deeplink must reload if the row was unloaded since
    // the previous visit. A same-URL assign can otherwise be a no-op.
    if (targetUrl.href === location.href) location.reload();
    else location.assign(targetUrl.href);
  } catch (error) {
    sessionStorage.removeItem(PENDING_HIGHLIGHT);
    throw error;
  }
}
