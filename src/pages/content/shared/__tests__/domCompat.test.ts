import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  conversationIdFromRow,
  conversationTitleFromRow,
  syncChatGptDomCompat,
} from '../domCompat';

const CONV = '6aaec8d9-4ae0-83eb-a82c-25b30e4ba56a';
const USER_MSG = '33d777ff-9dd3-438c-b638-f5a9ebe29f51';
const REPLY_MSG = '49d0740e-e029-45ab-b1f6-fc50fa662e74';

/** Minimal 2026-09 (Codex app shell) page: sidebar row, one exchange, header, composer. */
function renderAppShell(): void {
  document.body.innerHTML = `
    <nav role="navigation">
      <div role="list">
        <div role="listitem" data-sidebar-chatgpt-conversation-key="chatgpt:conversation:${CONV}">
          <div role="button" aria-label="介绍Jev模型"><span data-thread-title="true">介绍Jev模型</span></div>
          <button type="button" aria-haspopup="menu" id="row-trigger">…</button>
        </div>
        <div role="listitem" data-sidebar-chatgpt-conversation-key="chatgpt:project:abc">
          <div role="button" aria-label="A project"></div>
        </div>
      </div>
    </nav>
    <header data-app-shell-titlebar="true">
      <div data-app-shell-header-obstacle="true">
        <button type="button" aria-label="分享">Share</button>
        <button type="button" aria-haspopup="menu" id="header-trigger">…</button>
      </div>
    </header>
    <main>
      <div data-turn-key="${USER_MSG}">
        <div class="group/user-message" data-chatgpt-search-unit-key="t:0:user"
             data-chatgpt-search-message-ids="${USER_MSG}">
          <div data-user-message-bubble="true">question</div>
        </div>
        <div data-chatgpt-search-unit-key="t:2:assistant"
             data-chatgpt-search-message-ids="${REPLY_MSG} ${REPLY_MSG}">
          <div data-chatgpt-selection-message-id="${REPLY_MSG}">
            <div data-markdown-text-style="assistant-message">answer</div>
          </div>
        </div>
      </div>
      <form>
        <div class="ProseMirror" contenteditable="true" role="textbox"></div>
        <button type="button" data-composer-navigation-target="add-context">+</button>
        <button type="submit" aria-label="发送">send</button>
      </form>
    </main>`;
}

describe('ChatGPT 2026-09 DOM compatibility shim', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', `/c/${CONV}`);
    renderAppShell();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    window.history.replaceState(null, '', '/');
  });

  it('gives conversation rows a hidden legacy /c/<id> link, and only conversation rows', () => {
    syncChatGptDomCompat();
    const links = document.querySelectorAll<HTMLAnchorElement>('a[href*="/c/"]');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe(`/c/${CONV}`);
    expect(links[0].title).toBe('介绍Jev模型');
    expect(links[0].hidden).toBe(true);

    const row = document.querySelector('[role="listitem"]')!;
    expect(conversationIdFromRow(row)).toBe(CONV);
    expect(conversationTitleFromRow(row)).toBe('介绍Jev模型');
  });

  it('is idempotent and follows a rename', () => {
    syncChatGptDomCompat();
    document.querySelector('[role="button"][aria-label]')!.setAttribute('aria-label', 'Renamed');
    syncChatGptDomCompat();
    const links = document.querySelectorAll<HTMLAnchorElement>('a[data-gv-conv-link]');
    expect(links).toHaveLength(1);
    expect(links[0].title).toBe('Renamed');
  });

  it('stamps legacy message roles, ids and text roots', () => {
    syncChatGptDomCompat();
    const user = document.querySelector('[data-message-author-role="user"]');
    const reply = document.querySelector('[data-message-author-role="assistant"]');
    expect(user?.getAttribute('data-message-id')).toBe(USER_MSG);
    // The selectable final answer, not the first id of the block.
    expect(reply?.getAttribute('data-message-id')).toBe(REPLY_MSG);
    expect(user?.querySelector('[data-message-content]')?.textContent).toBe('question');
    expect(reply?.querySelector('[data-message-content]')?.textContent).toBe('answer');
  });

  it('restores the header and row option test ids', () => {
    syncChatGptDomCompat();
    expect(document.getElementById('header-trigger')?.getAttribute('data-testid')).toBe(
      'conversation-options-button',
    );
    expect(document.getElementById('row-trigger')?.getAttribute('data-testid')).toBe(
      'history-item-0-options',
    );
  });

  it('leaves the header alone off a conversation route', () => {
    window.history.replaceState(null, '', '/');
    syncChatGptDomCompat();
    expect(document.getElementById('header-trigger')?.hasAttribute('data-testid')).toBe(false);
  });

  it('tags delete / share / rename only in menus owned by a conversation trigger', () => {
    syncChatGptDomCompat();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-labelledby', 'row-trigger');
    menu.innerHTML = `
      <div role="menuitem">分享</div><div role="menuitem">重命名</div>
      <div role="menuitem">归档</div><div role="menuitem">删除</div>`;
    const unrelated = menu.cloneNode(true) as HTMLElement;
    unrelated.setAttribute('aria-labelledby', 'model-picker');
    document.body.append(menu, unrelated);

    syncChatGptDomCompat();
    const ids = [...menu.querySelectorAll('[role="menuitem"]')].map((item) =>
      item.getAttribute('data-testid'),
    );
    expect(ids).toEqual([
      'share-chat-menu-item',
      'rename-chat-menu-item',
      null,
      'delete-chat-menu-item',
    ]);
    expect(unrelated.querySelector('[data-testid]')).toBeNull();
  });

  it('marks the main composer, its editor and send / stop buttons', () => {
    syncChatGptDomCompat();
    const form = document.querySelector('form')!;
    expect(form.getAttribute('data-type')).toBe('unified-composer');
    expect(document.getElementById('prompt-textarea')?.classList.contains('ProseMirror')).toBe(
      true,
    );
    const submit = form.querySelector('button[type="submit"]')!;
    expect(submit.getAttribute('data-testid')).toBe('send-button');

    submit.setAttribute('aria-label', '停止流式传输');
    syncChatGptDomCompat();
    expect(submit.getAttribute('data-testid')).toBe('stop-button');
  });

  it('never claims a form without the composer navigation targets', () => {
    document.querySelector('[data-composer-navigation-target]')!.remove();
    syncChatGptDomCompat();
    expect(document.querySelector('form')!.hasAttribute('data-type')).toBe(false);
    expect(document.getElementById('prompt-textarea')).toBeNull();
  });
});
