/**
 * ChatGPT DOM health check — the first thing to run after a ChatGPT redesign.
 *
 * Every feature reaches ChatGPT through a handful of primitives (sidebar rows,
 * header "…", thread rows, message roles, composer, code blocks, theme tokens,
 * captured conversation data). The 2026-09 redesign broke all of them at once
 * while the features themselves were fine, so the repair was entirely in the
 * adapter layer (`domCompat.ts`, `chatgptDom.ts`, `headerActionSlot.ts`,
 * `pageWorld/threadMirror.ts`, `pageWorld/conversationHook.ts`). This check
 * names the primitive that no longer resolves and the features riding on it,
 * so the next repair starts at the right adapter instead of in every feature.
 * See `docs/CHATGPT-DOM-ADAPTER.md`.
 *
 * Exposed on the extension's isolated-world `window` as `__gvDomHealth()`
 * (DevTools → console context "GPT-Voyager", or CDP with the extension's
 * isolated execution context). Read-only.
 */
import { getConversationCaptureService } from '@/features/conversationApi/ConversationCaptureService';

import { extractChatGptConversationIdFromUrl, findChatGptSidebar } from '../chatgptDom';

export interface DomHealthCheck {
  primitive: string;
  ok: boolean;
  detail: string;
  /** Features that depend on this primitive. */
  features: string;
}

const count = (selector: string): number => document.querySelectorAll(selector).length;

export function runDomHealthCheck(): DomHealthCheck[] {
  const onConversation = !!extractChatGptConversationIdFromUrl(location.href);
  const convId = extractChatGptConversationIdFromUrl(location.href);
  const rootStyle = getComputedStyle(document.documentElement);
  const checks: DomHealthCheck[] = [];
  const add = (primitive: string, ok: boolean, detail: string, features: string) =>
    checks.push({ primitive, ok, detail, features });

  const theme =
    document.documentElement.getAttribute('data-theme') ||
    (document.documentElement.classList.contains('dark') ? 'dark (class)' : '');
  add('theme marker', !!theme, `data-theme / .dark = ${theme || 'none'}`, 'gentle dark');
  const surface = rootStyle.getPropertyValue('--app-color-background-surface').trim();
  add(
    'theme surface token',
    !!surface || !!rootStyle.getPropertyValue('--main-surface-primary').trim(),
    `--app-color-background-surface = ${surface || 'unset'}`,
    'gentle dark',
  );

  const sidebar = findChatGptSidebar();
  add(
    'sidebar panel',
    !!sidebar,
    sidebar ? sidebar.tagName.toLowerCase() : 'not found',
    'folders, sidebar width',
  );
  const rows = count('[data-sidebar-chatgpt-conversation-key^="chatgpt:conversation:"]');
  const links = count('a[href*="/c/"]');
  add(
    'sidebar conversation links',
    links > 0,
    `${rows} app-shell rows, ${links} /c/ links (shim: a[data-gv-conv-link] = ${count('a[data-gv-conv-link]')})`,
    'folders, move-to-folder, sidebar export, batch delete',
  );
  add(
    'sidebar width variable',
    !!rootStyle.getPropertyValue('--app-shell-left-panel-width').trim() ||
      !!document.getElementById('stage-slideover-sidebar'),
    `--app-shell-left-panel-width = ${rootStyle.getPropertyValue('--app-shell-left-panel-width').trim() || 'unset'}`,
    'sidebar width',
  );

  if (onConversation) {
    add(
      'header "…" options button',
      count('[data-testid="conversation-options-button"]') > 0,
      `header[data-app-shell-titlebar] = ${count('header[data-app-shell-titlebar]')}, #page-header = ${count('header#page-header')}`,
      'export button, folder header button, announcement, move-to-folder (header menu)',
    );
    const turnRows = count('[data-turn-key]') + count('[data-testid^="conversation-turn-"]');
    add(
      'thread rows',
      turnRows > 0,
      `${turnRows} mounted turn rows`,
      'timeline, export, quote reply',
    );
    add(
      'thread mirror anchors',
      count('[data-gv-thread-anchor]') > 0 || count('[data-turn-id-container]') > 0,
      `${count('[data-gv-thread-anchor]')} anchors (page-world threadMirror)`,
      'timeline (all turns incl. virtualised), starred jump',
    );
    add(
      'message roles',
      count('[data-message-author-role]') > 0,
      `user ${count('[data-message-author-role="user"]')}, assistant ${count('[data-message-author-role="assistant"]')}`,
      'export (selection / live), fork, response image actions, user LaTeX',
    );
    const scroller =
      document.querySelector<HTMLElement>('.thread-scroll-container') ??
      document.querySelector<HTMLElement>('div[class*="scrollbar-gutter"]');
    add(
      'thread scroller',
      !!scroller,
      scroller ? `flex-direction = ${getComputedStyle(scroller).flexDirection}` : 'not found',
      'timeline navigation, export history hydration',
    );
    const capture = convId ? getConversationCaptureService().getLatest(convId) : null;
    add(
      'captured conversation data',
      !!capture,
      capture
        ? `${capture.messages.length} messages, complete = ${getConversationCaptureService().isComplete(convId!)}`
        : 'no /backend-api/conversation(s) capture yet',
      'export (whole), timeline text cache',
    );
  }

  add(
    'composer',
    !!document.getElementById('prompt-textarea') ||
      count('form[data-type="unified-composer"] [contenteditable="true"]') > 0,
    `#prompt-textarea = ${!!document.getElementById('prompt-textarea')}, unified-composer form = ${count('form[data-type="unified-composer"]')}`,
    'prompt insert, quote reply, send behavior, plain-text input, input collapse, draft save',
  );
  const codeBlocks = count('[data-markdown-copy="code-block"]') + count('pre > code');
  add(
    'code blocks',
    true,
    `${codeBlocks} blocks (app-shell ${count('[data-markdown-copy="code-block"]')}, legacy pre>code ${count('pre > code')})`,
    'long code block collapse, mermaid',
  );
  return checks;
}

/** Log the report as a table; returns the failing primitives. */
export function logDomHealthCheck(): DomHealthCheck[] {
  const checks = runDomHealthCheck();
  console.warn('[GPT-Voyager] DOM health', location.pathname);
  // eslint-disable-next-line no-console -- developer diagnostic, only on demand
  console.table(checks);
  return checks.filter((check) => !check.ok);
}

export function exposeDomHealthCheck(): void {
  try {
    (window as unknown as { __gvDomHealth?: () => DomHealthCheck[] }).__gvDomHealth =
      logDomHealthCheck;
  } catch {
    /* ignore */
  }
}
