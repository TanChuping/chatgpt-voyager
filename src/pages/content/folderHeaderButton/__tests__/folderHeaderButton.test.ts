import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startFolderHeaderButton, stopFolderHeaderButton } from '../index';

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

const BUTTON = '[data-gv-folder-header-btn]';
const TITLE = '[data-gv-conversation-title-header]';
const CONVERSATION_ID = '69ecf9a2-d5b4-83ea-a03c-80b3b2514998';

/**
 * ChatGPT's 2026-08 conversation header: a centred (absolutely positioned)
 * switcher, an in-flow left group holding the `.translucent-surface` cluster,
 * and the right-hand actions container.
 */
function mountHeader(): void {
  document.body.innerHTML = `
    <header id="page-header">
      <div class="absolute start-1/2" style="position: absolute">switcher</div>
      <div class="flex flex-1 items-center">
        <div class="translucent-surface flex items-center rounded-lg"></div>
      </div>
      <div data-testid="thread-header-right-actions-container">
        <div id="conversation-header-actions">
          <div class="flex items-center">
            <button data-testid="conversation-options-button" class="flex h-9 w-9 opacity-50">…</button>
          </div>
        </div>
      </div>
    </header>`;
}

function mountSidebarConversation(title = 'Original title'): {
  sidebar: HTMLDivElement;
  row: HTMLLIElement;
  link: HTMLAnchorElement;
  titleNode: HTMLSpanElement;
  options: HTMLButtonElement;
} {
  let sidebar = document.querySelector<HTMLDivElement>('#stage-slideover-sidebar');
  if (!sidebar) {
    sidebar = document.createElement('div');
    sidebar.id = 'stage-slideover-sidebar';
    sidebar.dataset.state = 'open';
    document.body.appendChild(sidebar);
  }
  const row = document.createElement('li');
  const link = document.createElement('a');
  link.href = `/c/${CONVERSATION_ID}`;
  const titleNode = document.createElement('span');
  titleNode.textContent = title;
  const options = document.createElement('button');
  options.id = 'sidebar-options-trigger';
  options.type = 'button';
  options.dataset.testid = 'history-item-10-options';
  options.dataset.conversationOptionsTrigger = CONVERSATION_ID;
  options.setAttribute('aria-haspopup', 'menu');
  options.setAttribute('aria-expanded', 'false');
  options.setAttribute('data-state', 'closed');
  link.append(titleNode, options);
  row.appendChild(link);
  sidebar.appendChild(row);
  return { sidebar, row, link, titleNode, options };
}

function fakeManager(open = vi.fn().mockReturnValue(true)) {
  return {
    manager: {
      openMoveToFolderDialogForCurrentConversation: open,
    } as never,
    open,
  };
}

beforeEach(() => {
  window.history.pushState({}, '', '/c/69ecf9a2-d5b4-83ea-a03c-80b3b2514998');
  mountHeader();
});

afterEach(() => {
  stopFolderHeaderButton();
  document.body.innerHTML = '';
  document.title = '';
  window.history.pushState({}, '', '/');
});

describe('folder header button', () => {
  it('injects into ChatGPT’s left cluster, not the right-hand actions', () => {
    const { manager } = fakeManager();
    startFolderHeaderButton(manager);

    const button = document.querySelector<HTMLElement>(BUTTON);
    expect(button).not.toBeNull();
    expect(button!.closest('.translucent-surface')).not.toBeNull();
    expect(button!.closest('[data-testid="thread-header-right-actions-container"]')).toBeNull();
    // The Issue #9 rename shortcut was removed in 1.8.15.
    expect(document.querySelector('[data-gv-conversation-rename-header-btn]')).toBeNull();
  });

  it('draws a real SVG, never a Material ligature', () => {
    // The folder UI's Gemini heritage renders icons as ligature text, which
    // ChatGPT has no font for — it would print the literal word "folder".
    const { manager } = fakeManager();
    startFolderHeaderButton(manager);

    const button = document.querySelector<HTMLElement>(BUTTON)!;
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.querySelector('mat-icon')).toBeNull();
    expect(button.textContent).toBe('');
  });

  it('drops ChatGPT’s transient disabled classes when cloning header styling', () => {
    const { manager } = fakeManager();
    startFolderHeaderButton(manager);

    const button = document.querySelector<HTMLElement>(BUTTON)!;
    expect(button.className).toContain('h-9');
    expect(button.className).not.toContain('opacity-50');
  });

  it('opens the move-to-folder dialog for the current conversation on click', () => {
    const { manager, open } = fakeManager();
    startFolderHeaderButton(manager);

    document.querySelector<HTMLElement>(BUTTON)!.click();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('shows the current conversation title beside the shortcuts and keeps it synced', async () => {
    const { titleNode } = mountSidebarConversation('Current conversation');
    const { manager } = fakeManager();
    startFolderHeaderButton(manager);

    const title = document.querySelector<HTMLElement>(TITLE)!;
    expect(title.textContent).toBe('Current conversation');
    expect(title.title).toBe('Current conversation');

    titleNode.textContent = 'Renamed conversation';
    await vi.waitFor(() => expect(title.textContent).toBe('Renamed conversation'));
    expect(title.getAttribute('aria-label')).toBe('Renamed conversation');
  });

  it('does not inject outside a conversation', () => {
    window.history.pushState({}, '', '/');
    const { manager } = fakeManager();
    startFolderHeaderButton(manager);

    expect(document.querySelector(BUTTON)).toBeNull();
  });

  it('injects exactly once even when started twice', () => {
    const { manager } = fakeManager();
    startFolderHeaderButton(manager);
    startFolderHeaderButton(manager);

    expect(document.querySelectorAll(BUTTON).length).toBe(1);
  });

  it('moves shortcuts from a force-mounted hidden header to the active replacement', async () => {
    const { manager } = fakeManager();
    startFolderHeaderButton(manager);
    const oldHeader = document.querySelector<HTMLElement>('header#page-header')!;
    const template = document.createElement('div');
    template.innerHTML = oldHeader.outerHTML;
    const newHeader = template.firstElementChild as HTMLElement;
    newHeader.querySelectorAll(BUTTON).forEach((node) => node.remove());
    document.body.appendChild(newHeader);
    oldHeader.style.display = 'none';

    await vi.waitFor(() => {
      expect(newHeader.querySelector(BUTTON)).not.toBeNull();
      expect(oldHeader.querySelector(BUTTON)).toBeNull();
    });
    expect(document.querySelectorAll(BUTTON)).toHaveLength(1);
  });

  it('removes the button and stops responding after stop()', () => {
    const { manager, open } = fakeManager();
    startFolderHeaderButton(manager);
    const button = document.querySelector<HTMLElement>(BUTTON)!;

    stopFolderHeaderButton();
    expect(document.querySelector(BUTTON)).toBeNull();

    button.click();
    expect(open).not.toHaveBeenCalled();
  });
});
