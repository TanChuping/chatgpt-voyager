import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enMessages from '@locales/en/messages.json';
import ruMessages from '@locales/ru/messages.json';

import {
  FLOATING_PANEL_CLASS,
  type FloatingPanelHandle,
  mountFloatingPanel,
} from './floatingPanel';
import type { FolderData } from './types';

const locale = vi.hoisted(() => ({ messages: {} as Record<string, { message: string }> }));
vi.mock('@/utils/i18n', () => ({
  getTranslationSyncUnsafe: (key: string) => locale.messages[key]?.message ?? key,
}));

let panel: FloatingPanelHandle | undefined;

function ready(messages: typeof enMessages | typeof ruMessages): void {
  locale.messages = messages;
  window.dispatchEvent(new CustomEvent('voyager:language-changed'));
}

function element<T extends HTMLElement = HTMLElement>(root: ParentNode, suffix: string): T {
  const result = root.querySelector<T>(`.${FLOATING_PANEL_CLASS}__${suffix}`);
  if (!result) throw new Error(`Missing floating panel element: ${suffix}`);
  return result;
}

function folderHeader(id: string): HTMLElement {
  return element(panel!.element, `folder-header[data-folder-id="${id}"]`);
}

function data(): FolderData {
  return {
    folders: ['a', 'b'].map((id) => ({
      id,
      name: id === 'a' ? '研究 Alpha ✦' : '客户 Beta',
      parentId: null,
      isExpanded: true,
      sortIndex: id === 'a' ? 0 : 1,
      createdAt: 1,
      updatedAt: 1,
      color: 'red',
    })),
    folderContents: {
      a: [
        { conversationId: 'one', title: 'Résumé 保留', url: '/c/one', addedAt: 1 },
        { conversationId: 'two', title: '', url: '/c/two', addedAt: 2 },
      ],
      b: [],
    },
  };
}

beforeEach(() => {
  locale.messages = enMessages;
  vi.useFakeTimers();
});

afterEach(() => {
  panel?.destroy();
  panel = undefined;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('floating panel dictionary-ready refresh', () => {
  it('refreshes the open empty panel, hints and accessible labels, then unsubscribes on destroy', () => {
    panel = mountFloatingPanel({ data: { folders: [], folderContents: {} } });
    const root = panel.element;
    const title = element(root, 'title');
    const empty = element(root, 'empty-label');
    const create = element(root, 'icon-button--create');
    expect(empty.textContent).toBe(enMessages.floatingPanelEmpty.message);

    ready(ruMessages);

    expect(element(root, 'title')).toBe(title);
    expect(element(root, 'empty-label')).toBe(empty);
    expect(title.textContent).toBe(ruMessages.floatingPanelTitle.message);
    expect(empty.textContent).toBe(ruMessages.floatingPanelEmpty.message);
    expect(root.getAttribute('aria-label')).toBe(ruMessages.floatingPanelTitle.message);
    expect(create.getAttribute('aria-label')).toBe(ruMessages.floatingPanelCreateFolder.message);
    expect(create.title).toBe(ruMessages.floatingPanelCreateFolder.message);
    expect(element(root, 'close').getAttribute('aria-label')).toBe(
      ruMessages.floatingPanelClose.message,
    );
    expect(element(root, 'hint-stack').textContent).toContain(
      ruMessages.floatingPanelMoveHint.message,
    );
    expect(element(root, 'hint-stack').textContent).toContain(
      ruMessages.floatingPanelGestureHint.message,
    );

    panel.destroy();
    ready(enMessages);
    expect(root.isConnected).toBe(false);
    expect(title.textContent).toBe(ruMessages.floatingPanelTitle.message);
  });

  it.each(['create', 'rename-folder', 'rename-conversation'] as const)(
    'preserves the %s draft, selection, focus, scroll and expanded state through a switch and return',
    (mode) => {
      const original = data();
      const before = JSON.stringify(original);
      const onCreateFolder = vi.fn();
      const onRenameFolder = vi.fn();
      const onRenameConversation = vi.fn();
      panel = mountFloatingPanel({
        data: original,
        onCreateFolder,
        onRenameFolder,
        onRenameConversation,
      });

      // Change expansion through the existing visible row interaction.
      folderHeader('b').click();
      if (mode === 'create') element(panel.element, 'icon-button--create').click();
      else if (mode === 'rename-folder') {
        element(folderHeader('a'), 'folder-name').dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true }),
        );
      } else {
        const conversation = element(panel.element, 'conv[data-conversation-id="one"]');
        element(conversation, 'icon-button--rename-conversation').click();
      }

      vi.runOnlyPendingTimers();
      const input = element<HTMLInputElement>(panel.element, 'inline-input');
      const draft = 'Draft — 草稿 未保存';
      input.value = draft;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      input.setSelectionRange(2, 8, 'backward');
      const body = element(panel.element, 'body');
      body.scrollTop = 145;
      body.scrollLeft = 17;
      const collapsedBody = element(folderHeader('b').parentElement!, 'folder-body');
      expect(collapsedBody.style.display).toBe('none');

      ready(ruMessages);

      expect(element(panel.element, 'inline-input')).toBe(input);
      expect(input.value).toBe(draft);
      expect(input.selectionStart).toBe(2);
      expect(input.selectionEnd).toBe(8);
      expect(input.selectionDirection).toBe('backward');
      expect(document.activeElement).toBe(input);
      expect(body.scrollTop).toBe(145);
      expect(body.scrollLeft).toBe(17);
      expect(element(folderHeader('b').parentElement!, 'folder-body')).toBe(collapsedBody);
      expect(collapsedBody.style.display).toBe('none');
      expect(element(panel.element, 'icon-button--save').getAttribute('aria-label')).toBe(
        ruMessages.floatingPanelSave.message,
      );
      expect(input.placeholder).toBe(
        mode === 'rename-conversation'
          ? ruMessages.conversation_rename.message
          : ruMessages.floatingPanelFolderNamePlaceholder.message,
      );
      if (mode === 'rename-conversation') {
        expect(input.getAttribute('aria-label')).toBe(
          `${ruMessages.conversation_rename.message}: Résumé 保留`,
        );
      }
      expect(panel.element.textContent).toContain('客户 Beta');
      expect(panel.element.textContent).toContain(ruMessages.floatingPanelUntitled.message);
      expect(JSON.stringify(original)).toBe(before);
      expect(onCreateFolder).not.toHaveBeenCalled();
      expect(onRenameFolder).not.toHaveBeenCalled();
      expect(onRenameConversation).not.toHaveBeenCalled();

      ready(enMessages);
      expect(element(panel.element, 'inline-input')).toBe(input);
      expect(input.value).toBe(draft);
      expect(document.activeElement).toBe(input);
      expect(body.scrollTop).toBe(145);
      expect(element(panel.element, 'title').textContent).toBe(
        enMessages.floatingPanelTitle.message,
      );
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      if (mode === 'create') expect(onCreateFolder).toHaveBeenCalledWith(draft, null);
      else if (mode === 'rename-folder') expect(onRenameFolder).toHaveBeenCalledWith('a', draft);
      else expect(onRenameConversation).toHaveBeenCalledWith('a', 'one', draft);
    },
  );

  it('refreshes an open context menu and its delete confirmation without invoking actions', () => {
    const onDeleteFolder = vi.fn();
    panel = mountFloatingPanel({ data: data(), onDeleteFolder });
    folderHeader('a').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const menu = element(panel.element, 'context-menu');
    const red = element(menu, `color-swatch[aria-label="${enMessages.folder_color_red.message}"]`);

    ready(ruMessages);

    expect(element(panel.element, 'context-menu')).toBe(menu);
    expect(red.getAttribute('aria-label')).toBe(ruMessages.folder_color_red.message);
    expect(red.title).toBe(ruMessages.folder_color_red.message);
    expect(red.classList.contains(`${FLOATING_PANEL_CLASS}__color-swatch--active`)).toBe(true);
    expect(element(menu, 'color-title').textContent).toBe(ruMessages.floatingPanelColor.message);
    expect(menu.textContent).toContain(ruMessages.floatingPanelPinFolder.message);
    element(menu, 'menu-item--danger').click();
    const confirmation = element(panel.element, 'confirm-inline');

    ready(enMessages);

    expect(element(panel.element, 'confirm-inline')).toBe(confirmation);
    expect(confirmation.textContent).toContain(enMessages.floatingPanelDeleteFolder.message);
    expect(confirmation.textContent).toContain(enMessages.floatingPanelCancel.message);
    expect(onDeleteFolder).not.toHaveBeenCalled();
  });
});
