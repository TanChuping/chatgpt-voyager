import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startFolderHeaderButton, stopFolderHeaderButton } from '../index';

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

const BUTTON = '[data-gv-folder-header-btn]';
const RENAME_BUTTON = '[data-gv-conversation-rename-header-btn]';
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

function fakeManager(open = vi.fn().mockReturnValue(true)) {
  const applyRename = vi.fn();
  let suppressedTrigger: HTMLElement | null = null;
  const runSuppressed = vi.fn(<T>(trigger: HTMLElement, action: () => T): T => {
    const previous = suppressedTrigger;
    suppressedTrigger = trigger;
    try {
      return action();
    } finally {
      suppressedTrigger = previous;
    }
  });
  return {
    manager: {
      openMoveToFolderDialogForCurrentConversation: open,
      applyNativeConversationRename: applyRename,
      runWithNativeConversationMenuTrackingSuppressed: runSuppressed,
    } as never,
    open,
    applyRename,
    runSuppressed,
    isSuppressed: (trigger: HTMLElement) => suppressedTrigger === trigger,
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
    expect(document.querySelector(`${RENAME_BUTTON} svg`)).not.toBeNull();
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
    expect(document.querySelectorAll(RENAME_BUTTON).length).toBe(1);
  });

  it('opens ChatGPT native rename and syncs the committed title into folders', async () => {
    document.title = 'Original title - ChatGPT';
    const sidebarRow = document.createElement('li');
    const conversationLink = document.createElement('a');
    conversationLink.href = `/c/${CONVERSATION_ID}`;
    conversationLink.textContent = 'Original title';
    sidebarRow.appendChild(conversationLink);
    document.body.appendChild(sidebarRow);
    // A lagging duplicate source already has the target title. The submitted
    // value must be compared with the editor's initial value, not this union.
    const laggingRow = document.createElement('li');
    const laggingLink = document.createElement('a');
    laggingLink.href = `/c/${CONVERSATION_ID}`;
    laggingLink.textContent = 'Committed title';
    laggingRow.appendChild(laggingLink);
    document.body.appendChild(laggingRow);
    const permanentlyStaleRow = document.createElement('li');
    const permanentlyStaleLink = document.createElement('a');
    permanentlyStaleLink.href = `/c/${CONVERSATION_ID}`;
    permanentlyStaleLink.textContent = 'Original title';
    permanentlyStaleRow.appendChild(permanentlyStaleLink);
    document.body.appendChild(permanentlyStaleRow);

    const options = document.querySelector<HTMLButtonElement>(
      '[data-testid="conversation-options-button"]',
    )!;
    options.addEventListener('click', () => {
      options.id = 'rename-trigger';
      options.setAttribute('aria-haspopup', 'menu');
      options.setAttribute('aria-expanded', 'true');
      options.setAttribute('aria-controls', 'rename-menu');

      const menu = document.createElement('div');
      menu.id = 'rename-menu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('data-state', 'open');
      menu.setAttribute('aria-labelledby', 'rename-trigger');

      const rename = document.createElement('button');
      rename.setAttribute('role', 'menuitem');
      rename.setAttribute('data-testid', 'rename-chat-menu-item');
      rename.textContent = 'Rename';
      rename.addEventListener('click', () => {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('data-state', 'open');
        dialog.setAttribute('aria-label', 'Rename conversation');
        const form = document.createElement('form');
        const input = document.createElement('input');
        input.setAttribute('data-testid', 'rename-conversation-input');
        input.value = 'Original title';
        const save = document.createElement('button');
        save.type = 'submit';
        save.textContent = 'Save';
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          conversationLink.textContent = input.value;
          document.title = `${input.value} - ChatGPT`;
          dialog.remove();
        });
        form.append(input, save);
        dialog.appendChild(form);
        document.body.appendChild(dialog);
      });

      const remove = document.createElement('button');
      remove.setAttribute('role', 'menuitem');
      remove.setAttribute('data-testid', 'delete-chat-menu-item');
      menu.append(rename, remove);
      document.body.appendChild(menu);
    });

    const { manager, applyRename, isSuppressed, runSuppressed } = fakeManager();
    const competingCaptureListener = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target !== options || isSuppressed(target)) return;
      target.setAttribute('data-gv-native-menu-token', 'competing-folder-manager-token');
    };
    document.addEventListener('click', competingCaptureListener, true);
    startFolderHeaderButton(manager);
    document.querySelector<HTMLButtonElement>(RENAME_BUTTON)!.click();

    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="rename-conversation-input"]')).not.toBeNull();
    });
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="rename-conversation-input"]',
    )!;
    input.value = 'Committed title';
    input.closest('form')!.requestSubmit();

    await vi.waitFor(
      () => {
        expect(applyRename).toHaveBeenCalledWith(CONVERSATION_ID, 'Committed title');
      },
      { timeout: 6000 },
    );
    expect(runSuppressed).toHaveBeenCalledTimes(1);
    document.removeEventListener('click', competingCaptureListener, true);
  }, 10_000);

  it('does not treat cancel followed by an automatic title change as a committed rename', async () => {
    const sidebarRow = document.createElement('li');
    const conversationLink = document.createElement('a');
    conversationLink.href = `/c/${CONVERSATION_ID}`;
    conversationLink.textContent = 'Original title';
    sidebarRow.appendChild(conversationLink);
    document.body.appendChild(sidebarRow);

    const options = document.querySelector<HTMLButtonElement>(
      '[data-testid="conversation-options-button"]',
    )!;
    options.addEventListener('click', () => {
      options.id = 'cancel-trigger';
      options.setAttribute('aria-haspopup', 'menu');
      options.setAttribute('aria-expanded', 'true');
      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('data-state', 'open');
      menu.setAttribute('aria-labelledby', 'cancel-trigger');
      const rename = document.createElement('button');
      rename.setAttribute('role', 'menuitem');
      rename.setAttribute('data-testid', 'rename-chat-menu-item');
      rename.textContent = 'Rename';
      rename.addEventListener('click', () => {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('data-state', 'open');
        const input = document.createElement('input');
        input.value = 'Original title';
        input.setAttribute('data-testid', 'rename-conversation-input');
        const cancel = document.createElement('button');
        cancel.type = 'button';
        // Deliberately use an unrecognised label and keep the Radix-style
        // dialog force-mounted. Lifecycle cleanup must follow open state, not
        // depend on a localised "Cancel" string or node removal.
        cancel.textContent = 'Dismiss';
        cancel.addEventListener('click', () => {
          dialog.setAttribute('data-state', 'closed');
          dialog.hidden = true;
        });
        dialog.append(input, cancel);
        document.body.appendChild(dialog);
      });
      const remove = document.createElement('button');
      remove.setAttribute('role', 'menuitem');
      remove.setAttribute('data-testid', 'delete-chat-menu-item');
      menu.append(rename, remove);
      document.body.appendChild(menu);
    });

    const { manager, applyRename } = fakeManager();
    startFolderHeaderButton(manager);
    document.querySelector<HTMLButtonElement>(RENAME_BUTTON)!.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="rename-conversation-input"]')).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click();
    conversationLink.textContent = 'Automatic title';
    await new Promise((resolve) => window.setTimeout(resolve, 300));

    expect(applyRename).not.toHaveBeenCalled();
  });

  it('detects a force-mounted rename editor that opens by class change only', async () => {
    document.title = 'Original title - ChatGPT';
    const style = document.createElement('style');
    style.textContent = '.gv-test-hidden { display: none; }';
    document.head.appendChild(style);
    const sidebarRow = document.createElement('li');
    const conversationLink = document.createElement('a');
    conversationLink.href = `/c/${CONVERSATION_ID}`;
    conversationLink.textContent = 'Original title';
    sidebarRow.appendChild(conversationLink);
    document.body.appendChild(sidebarRow);

    const dialog = document.createElement('div');
    dialog.className = 'gv-test-hidden';
    dialog.inert = true;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'Rename conversation');
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.value = 'Original title';
    input.setAttribute('data-testid', 'rename-conversation-input');
    const save = document.createElement('button');
    save.type = 'button';
    save.dataset.testid = 'modal-confirm-button';
    save.textContent = 'Save';
    save.addEventListener('click', () => {
      if (!input.value.trim()) return;
      conversationLink.textContent = input.value;
      document.title = `${input.value} - ChatGPT`;
      dialog.classList.add('gv-test-hidden');
    });
    form.append(input, save);
    dialog.appendChild(form);
    document.body.appendChild(dialog);

    const options = document.querySelector<HTMLButtonElement>(
      '[data-testid="conversation-options-button"]',
    )!;
    options.addEventListener('click', () => {
      options.id = 'class-trigger';
      options.setAttribute('aria-haspopup', 'menu');
      options.setAttribute('aria-expanded', 'true');
      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('data-state', 'open');
      menu.setAttribute('aria-labelledby', 'class-trigger');
      const rename = document.createElement('button');
      rename.setAttribute('role', 'menuitem');
      rename.setAttribute('data-testid', 'rename-chat-menu-item');
      rename.addEventListener('click', () => {
        window.setTimeout(() => {
          dialog.classList.remove('gv-test-hidden');
          dialog.removeAttribute('inert');
        }, 0);
      });
      const remove = document.createElement('button');
      remove.setAttribute('role', 'menuitem');
      remove.setAttribute('data-testid', 'delete-chat-menu-item');
      menu.append(rename, remove);
      document.body.appendChild(menu);
    });

    const { manager, applyRename } = fakeManager();
    startFolderHeaderButton(manager);
    document.querySelector<HTMLButtonElement>(RENAME_BUTTON)!.click();
    await vi.waitFor(() => expect(getComputedStyle(dialog).display).not.toBe('none'));
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    input.value = '';
    save.click();
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(getComputedStyle(dialog).display).not.toBe('none');
    expect(applyRename).not.toHaveBeenCalled();
    input.value = 'ChatGPT';
    save.click();

    await vi.waitFor(() => expect(applyRename).toHaveBeenCalledWith(CONVERSATION_ID, 'ChatGPT'), {
      timeout: 6000,
    });
    style.remove();
  }, 10_000);

  it('does not treat a pre-existing target-title duplicate as submit success', async () => {
    const sidebarRow = document.createElement('li');
    const conversationLink = document.createElement('a');
    conversationLink.href = `/c/${CONVERSATION_ID}`;
    conversationLink.textContent = 'Original title';
    sidebarRow.appendChild(conversationLink);
    document.body.appendChild(sidebarRow);
    const preexistingTargetRow = document.createElement('li');
    preexistingTargetRow.innerHTML = `<a href="/c/${CONVERSATION_ID}">Optimistic title</a>`;
    document.body.appendChild(preexistingTargetRow);

    const options = document.querySelector<HTMLButtonElement>(
      '[data-testid="conversation-options-button"]',
    )!;
    options.addEventListener('click', () => {
      options.id = 'rollback-trigger';
      options.setAttribute('aria-haspopup', 'menu');
      options.setAttribute('aria-expanded', 'true');
      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('data-state', 'open');
      menu.setAttribute('aria-labelledby', 'rollback-trigger');
      const rename = document.createElement('button');
      rename.setAttribute('role', 'menuitem');
      rename.setAttribute('data-testid', 'rename-chat-menu-item');
      rename.addEventListener('click', () => {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        const form = document.createElement('form');
        const input = document.createElement('input');
        input.value = 'Original title';
        input.setAttribute('data-testid', 'rename-conversation-input');
        const save = document.createElement('button');
        save.type = 'submit';
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          // Simulate a rejected native save: the dialog closes but no
          // identity-bound title source ever transitions to the target.
          const replacementDuplicate = preexistingTargetRow.cloneNode(true);
          preexistingTargetRow.replaceWith(replacementDuplicate);
          sidebarRow.remove();
          dialog.remove();
        });
        form.append(input, save);
        dialog.appendChild(form);
        document.body.appendChild(dialog);
      });
      const remove = document.createElement('button');
      remove.setAttribute('role', 'menuitem');
      remove.setAttribute('data-testid', 'delete-chat-menu-item');
      menu.append(rename, remove);
      document.body.appendChild(menu);
    });

    const { manager, applyRename } = fakeManager();
    startFolderHeaderButton(manager);
    document.querySelector<HTMLButtonElement>(RENAME_BUTTON)!.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="rename-conversation-input"]')).not.toBeNull();
    });
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="rename-conversation-input"]',
    )!;
    input.value = 'Optimistic title';
    input.closest('form')!.requestSubmit();
    await new Promise((resolve) => window.setTimeout(resolve, 2600));

    expect(conversationLink.textContent).toBe('Original title');
    expect(applyRename).not.toHaveBeenCalled();
  });

  it('corrects a slower native rollback after provisional confirmation', async () => {
    const sidebarRow = document.createElement('li');
    const conversationLink = document.createElement('a');
    conversationLink.href = `/c/${CONVERSATION_ID}`;
    conversationLink.textContent = 'Original title';
    sidebarRow.appendChild(conversationLink);
    document.body.appendChild(sidebarRow);
    const header = document.querySelector('header')!;
    const initialHeading = document.createElement('h1');
    initialHeading.textContent = 'Original title';
    header.appendChild(initialHeading);

    const options = document.querySelector<HTMLButtonElement>(
      '[data-testid="conversation-options-button"]',
    )!;
    options.addEventListener('click', () => {
      options.id = 'slow-rollback-trigger';
      options.setAttribute('aria-haspopup', 'menu');
      options.setAttribute('aria-expanded', 'true');
      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('data-state', 'open');
      menu.setAttribute('aria-labelledby', 'slow-rollback-trigger');
      const rename = document.createElement('button');
      rename.setAttribute('role', 'menuitem');
      rename.setAttribute('data-testid', 'rename-chat-menu-item');
      rename.addEventListener('click', () => {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        const form = document.createElement('form');
        const input = document.createElement('input');
        input.value = 'Original title';
        input.setAttribute('data-testid', 'rename-conversation-input');
        const save = document.createElement('button');
        save.type = 'submit';
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          const optimisticHeading = document.createElement('h1');
          optimisticHeading.textContent = input.value;
          initialHeading.replaceWith(optimisticHeading);
          dialog.remove();
          window.setTimeout(() => {
            const rollbackHeading = document.createElement('h1');
            rollbackHeading.textContent = 'Original title';
            optimisticHeading.replaceWith(rollbackHeading);
          }, 3000);
        });
        form.append(input, save);
        dialog.appendChild(form);
        document.body.appendChild(dialog);
      });
      const remove = document.createElement('button');
      remove.setAttribute('role', 'menuitem');
      remove.setAttribute('data-testid', 'delete-chat-menu-item');
      menu.append(rename, remove);
      document.body.appendChild(menu);
    });

    const { manager, applyRename } = fakeManager();
    startFolderHeaderButton(manager);
    document.querySelector<HTMLButtonElement>(RENAME_BUTTON)!.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="rename-conversation-input"]')).not.toBeNull();
    });
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="rename-conversation-input"]',
    )!;
    input.value = 'Slow optimistic title';
    input.closest('form')!.requestSubmit();

    await vi.waitFor(
      () => expect(applyRename).toHaveBeenCalledWith(CONVERSATION_ID, 'Slow optimistic title'),
      { timeout: 6000 },
    );
    await vi.waitFor(
      () => expect(applyRename).toHaveBeenCalledWith(CONVERSATION_ID, 'Original title'),
      { timeout: 7000 },
    );
  }, 10_000);

  it('does not roll back while another confirmed native source still has the submitted title', async () => {
    document.title = 'Original title - ChatGPT';
    const header = document.querySelector('header')!;
    const initialHeading = document.createElement('h1');
    initialHeading.textContent = 'Original title';
    header.appendChild(initialHeading);

    const options = document.querySelector<HTMLButtonElement>(
      '[data-testid="conversation-options-button"]',
    )!;
    options.addEventListener('click', () => {
      options.id = 'conflicting-rollback-trigger';
      options.setAttribute('aria-haspopup', 'menu');
      options.setAttribute('aria-expanded', 'true');
      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('data-state', 'open');
      menu.setAttribute('aria-labelledby', 'conflicting-rollback-trigger');
      const rename = document.createElement('button');
      rename.setAttribute('role', 'menuitem');
      rename.setAttribute('data-testid', 'rename-chat-menu-item');
      rename.addEventListener('click', () => {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        const form = document.createElement('form');
        const input = document.createElement('input');
        input.value = 'Original title';
        input.setAttribute('data-testid', 'rename-conversation-input');
        const save = document.createElement('button');
        save.type = 'submit';
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          initialHeading.textContent = input.value;
          document.title = `${input.value} - ChatGPT`;
          dialog.remove();
          window.setTimeout(() => {
            initialHeading.textContent = 'Original title';
          }, 3000);
        });
        form.append(input, save);
        dialog.appendChild(form);
        document.body.appendChild(dialog);
      });
      const remove = document.createElement('button');
      remove.setAttribute('role', 'menuitem');
      remove.setAttribute('data-testid', 'delete-chat-menu-item');
      menu.append(rename, remove);
      document.body.appendChild(menu);
    });

    const { manager, applyRename } = fakeManager();
    startFolderHeaderButton(manager);
    document.querySelector<HTMLButtonElement>(RENAME_BUTTON)!.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="rename-conversation-input"]')).not.toBeNull();
    });
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="rename-conversation-input"]',
    )!;
    input.value = 'Committed title';
    input.closest('form')!.requestSubmit();

    await vi.waitFor(
      () => expect(applyRename).toHaveBeenCalledWith(CONVERSATION_ID, 'Committed title'),
      { timeout: 6000 },
    );
    await new Promise((resolve) => window.setTimeout(resolve, 3500));
    expect(applyRename).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('does not let an old header operation re-enable a replacement rename button', async () => {
    const { manager } = fakeManager();
    startFolderHeaderButton(manager);
    const oldRenameButton = document.querySelector<HTMLButtonElement>(RENAME_BUTTON)!;
    oldRenameButton.click();

    mountHeader();
    await vi.waitFor(() => {
      const replacement = document.querySelector<HTMLButtonElement>(RENAME_BUTTON);
      expect(replacement).not.toBeNull();
      expect(replacement).not.toBe(oldRenameButton);
    });

    const replacementButton = document.querySelector<HTMLButtonElement>(RENAME_BUTTON)!;
    expect(replacementButton.disabled).toBe(true);
    await vi.waitFor(() => expect(replacementButton.disabled).toBe(false), { timeout: 4000 });
  });

  it('moves shortcuts from a force-mounted hidden header to the active replacement', async () => {
    const { manager } = fakeManager();
    startFolderHeaderButton(manager);
    const oldHeader = document.querySelector<HTMLElement>('header#page-header')!;
    const template = document.createElement('div');
    template.innerHTML = oldHeader.outerHTML;
    const newHeader = template.firstElementChild as HTMLElement;
    newHeader.querySelectorAll(`${BUTTON}, ${RENAME_BUTTON}`).forEach((node) => node.remove());
    document.body.appendChild(newHeader);
    oldHeader.style.display = 'none';

    await vi.waitFor(() => {
      expect(newHeader.querySelector(RENAME_BUTTON)).not.toBeNull();
      expect(oldHeader.querySelector(RENAME_BUTTON)).toBeNull();
    });
    expect(document.querySelectorAll(RENAME_BUTTON)).toHaveLength(1);
  });

  it('removes the button and stops responding after stop()', () => {
    const { manager, open } = fakeManager();
    startFolderHeaderButton(manager);
    const button = document.querySelector<HTMLElement>(BUTTON)!;

    stopFolderHeaderButton();
    expect(document.querySelector(BUTTON)).toBeNull();
    expect(document.querySelector(RENAME_BUTTON)).toBeNull();

    button.click();
    expect(open).not.toHaveBeenCalled();
  });
});
