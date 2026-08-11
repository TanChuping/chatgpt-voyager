import { afterEach, describe, expect, it, vi } from 'vitest';

import { FolderManager } from '../manager';
import type { Folder, FolderData } from '../types';

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      sync: { get: vi.fn(), set: vi.fn() },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { id: 'test-extension-id', lastError: null },
  },
}));

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

type TestableManager = {
  data: FolderData;
  containerElement: HTMLElement | null;
  createFolderElement: (folder: Folder, level?: number) => HTMLElement;
  createConversationElement: (
    conversation: FolderData['folderContents'][string][number],
    folderId: string,
    level: number,
  ) => HTMLElement;
  saveData: () => Promise<boolean>;
  applyNativeConversationRename: (conversationId: string, title: string) => void;
  navigateToConversationById: (folderId: string, conversationId: string) => void;
  confirmRemoveConversation: (
    folderId: string,
    conversationId: string,
    title: string,
    event: MouseEvent,
  ) => void;
  teardownEmbeddedFolderUI: () => void;
  isMultiSelectMode: boolean;
  folderSearchQuery: string;
};

const folder: Folder = {
  id: 'folder-1',
  name: 'Folder 1',
  parentId: null,
  isExpanded: false,
  createdAt: 1,
  updatedAt: 1,
};

afterEach(() => {
  document.body.innerHTML = '';
  document.title = '';
  window.history.pushState({}, '', '/');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('folder expansion state', () => {
  it('keeps a real chevron mounted and updates aria state without rebuilding the row', () => {
    window.history.pushState({}, '', '/c/conversation-1');
    const manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    typedManager.data = {
      folders: [{ ...folder }],
      folderContents: {
        'folder-1': [
          {
            conversationId: 'conversation-1',
            title: 'Current conversation',
            url: 'https://chatgpt.com/c/conversation-1',
            addedAt: 1,
            customTitle: true,
          },
        ],
      },
    };
    vi.spyOn(typedManager, 'saveData').mockResolvedValue(true);
    const container = document.createElement('div');
    typedManager.containerElement = container;
    const folderElement = typedManager.createFolderElement(typedManager.data.folders[0]);
    container.appendChild(folderElement);
    document.body.appendChild(container);

    const button = folderElement.querySelector<HTMLButtonElement>('.gv-folder-expand-btn')!;
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.querySelector('.google-symbols')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-label')).toContain('Folder 1');
    expect(button.getAttribute('aria-controls')).toBeNull();
    expect(folderElement.querySelector(':scope > .gv-folder-content')).toBeNull();

    button.click();

    expect(button.isConnected).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const content = folderElement.querySelector<HTMLElement>(':scope > .gv-folder-content');
    expect(content).not.toBeNull();
    expect(button.getAttribute('aria-controls')).toBe(content!.id);
    expect(content!.querySelector('.gv-folder-conversation-selected')).not.toBeNull();

    button.click();

    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(folderElement.querySelector(':scope > .gv-folder-content')).toBeNull();
    manager.destroy();
  });

  it('does not silently change saved expansion while search forces results open', () => {
    const manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    typedManager.folderSearchQuery = 'folder';
    typedManager.data = { folders: [{ ...folder }], folderContents: { 'folder-1': [] } };
    const container = document.createElement('div');
    typedManager.containerElement = container;
    const folderElement = typedManager.createFolderElement(typedManager.data.folders[0]);
    container.appendChild(folderElement);
    document.body.appendChild(container);

    const button = folderElement.querySelector<HTMLButtonElement>('.gv-folder-expand-btn')!;
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.disabled).toBe(true);
    button.click();

    expect(typedManager.data.folders[0].isExpanded).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    manager.destroy();
  });

  it('clears the transient animation class even when animationend never fires', () => {
    vi.useFakeTimers();
    const manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    typedManager.data = { folders: [{ ...folder }], folderContents: { 'folder-1': [] } };
    vi.spyOn(typedManager, 'saveData').mockResolvedValue(true);
    const container = document.createElement('div');
    typedManager.containerElement = container;
    const folderElement = typedManager.createFolderElement(typedManager.data.folders[0]);
    container.appendChild(folderElement);
    document.body.appendChild(container);

    folderElement.querySelector<HTMLButtonElement>('.gv-folder-expand-btn')!.click();
    const content = folderElement.querySelector<HTMLElement>('.gv-folder-content')!;
    expect(content.classList.contains('gv-folder-content--entering')).toBe(true);
    vi.advanceTimersByTime(251);
    expect(content.classList.contains('gv-folder-content--entering')).toBe(false);
    manager.destroy();
  });

  it('syncs native followers, preserves folder aliases, and rejects a stale sidebar rollback', () => {
    window.history.pushState({}, '', '/c/conversation-1');
    document.title = 'Committed native title - ChatGPT';
    const manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    typedManager.data = {
      folders: [
        { ...folder, id: 'folder-1' },
        { ...folder, id: 'folder-2', name: 'Folder 2' },
      ],
      folderContents: {
        'folder-1': [
          {
            conversationId: 'conversation-1',
            title: 'Local alias',
            url: 'https://chatgpt.com/c/conversation-1',
            addedAt: 1,
            customTitle: true,
          },
        ],
        'folder-2': [
          {
            conversationId: 'conversation-1',
            title: 'Old native title',
            url: 'https://chatgpt.com/c/conversation-1',
            addedAt: 1,
          },
        ],
      },
    };
    const save = vi.spyOn(typedManager, 'saveData').mockResolvedValue(true);
    const nativeRow = document.createElement('li');
    const nativeLink = document.createElement('a');
    nativeLink.href = '/c/conversation-1';
    nativeLink.textContent = 'Old native title';
    nativeRow.appendChild(nativeLink);
    const sidebar = document.createElement('aside');
    sidebar.id = 'sidebar';
    sidebar.appendChild(nativeRow);
    document.body.appendChild(sidebar);

    typedManager.applyNativeConversationRename('conversation-1', 'Committed native title');

    expect(typedManager.data.folderContents['folder-1'][0].title).toBe('Local alias');
    expect(typedManager.data.folderContents['folder-1'][0].customTitle).toBe(true);
    const nativeFollower = typedManager.data.folderContents['folder-2'][0];
    expect(nativeFollower.title).toBe('Committed native title');

    typedManager.createConversationElement(nativeFollower, 'folder-2', 0);

    expect(nativeFollower.title).toBe('Committed native title');

    const header = document.createElement('header');
    const heading = document.createElement('h1');
    heading.textContent = 'Old native title';
    header.appendChild(heading);
    document.body.appendChild(header);
    typedManager.createConversationElement(nativeFollower, 'folder-2', 0);
    expect(nativeFollower.title).toBe('Committed native title');

    document.title = 'Old native title - ChatGPT';
    typedManager.createConversationElement(nativeFollower, 'folder-2', 0);
    expect(nativeFollower.title).toBe('Old native title');

    nativeLink.textContent = 'Later native rename';
    document.title = 'Later native rename - ChatGPT';
    typedManager.createConversationElement(nativeFollower, 'folder-2', 0);
    expect(nativeFollower.title).toBe('Later native rename');
    expect(save).toHaveBeenCalledTimes(1);
    manager.destroy();
  });

  it('keeps the committed guard while new and stale duplicate rows coexist', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
    window.history.pushState({}, '', '/c/conversation-1');
    document.title = 'Committed title - ChatGPT';
    const manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    typedManager.data = {
      folders: [{ ...folder, isExpanded: true }],
      folderContents: {
        'folder-1': [
          {
            conversationId: 'conversation-1',
            title: 'Old title',
            url: 'https://chatgpt.com/c/conversation-1',
            addedAt: 1,
          },
        ],
      },
    };
    vi.spyOn(typedManager, 'saveData').mockResolvedValue(true);
    const sidebar = document.createElement('aside');
    sidebar.id = 'sidebar';
    const committedRow = document.createElement('li');
    committedRow.innerHTML = '<a href="/c/conversation-1">Committed title</a>';
    const staleRow = document.createElement('li');
    staleRow.innerHTML = '<a href="/c/conversation-1">Old title</a>';
    sidebar.append(committedRow, staleRow);
    document.body.appendChild(sidebar);

    typedManager.applyNativeConversationRename('conversation-1', 'Committed title');
    const follower = typedManager.data.folderContents['folder-1'][0];
    typedManager.createConversationElement(follower, 'folder-1', 0);
    expect(follower.title).toBe('Committed title');

    vi.advanceTimersByTime(16_000);
    committedRow.remove();
    typedManager.createConversationElement(follower, 'folder-1', 0);
    expect(follower.title).toBe('Committed title');
    manager.destroy();
  });

  it('cancels a pending folder-row long press during embedded teardown', () => {
    vi.useFakeTimers();
    const manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    const conversation = {
      conversationId: 'conversation-1',
      title: 'Conversation',
      url: 'https://chatgpt.com/c/conversation-1',
      addedAt: 1,
      customTitle: true,
    };
    typedManager.data = {
      folders: [{ ...folder, isExpanded: true }],
      folderContents: { 'folder-1': [conversation] },
    };
    const container = document.createElement('div');
    typedManager.containerElement = container;
    const row = typedManager.createConversationElement(conversation, 'folder-1', 0);
    container.appendChild(row);
    document.body.appendChild(container);

    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    typedManager.teardownEmbeddedFolderUI();
    vi.advanceTimersByTime(501);

    expect(typedManager.isMultiSelectMode).toBe(false);
    manager.destroy();
  });

  it('exposes a rename icon on every folder conversation and opens the existing inline editor', () => {
    vi.useFakeTimers();
    const manager = new FolderManager();
    const typedManager = manager as unknown as TestableManager;
    const conversation = {
      conversationId: 'conversation-1',
      title: 'Original title',
      url: 'https://chatgpt.com/c/conversation-1',
      addedAt: 1,
      customTitle: false,
    };
    typedManager.data = {
      folders: [{ ...folder, isExpanded: true }],
      folderContents: { 'folder-1': [conversation] },
    };
    const save = vi.spyOn(typedManager, 'saveData').mockResolvedValue(true);
    const navigate = vi
      .spyOn(typedManager, 'navigateToConversationById')
      .mockImplementation(() => {});
    const confirmRemove = vi
      .spyOn(typedManager, 'confirmRemoveConversation')
      .mockImplementation(() => {});
    const row = typedManager.createConversationElement(conversation, 'folder-1', 0);
    document.body.appendChild(row);

    const renameButton = row.querySelector<HTMLButtonElement>('.gv-conversation-rename-btn');
    expect(renameButton).not.toBeNull();
    expect(renameButton!.querySelector('svg')).not.toBeNull();
    expect(renameButton!.getAttribute('aria-label')).toBe('conversation_rename');
    expect(renameButton!.getAttribute('aria-describedby')).toBe(
      row.querySelector('.gv-conversation-title')?.id,
    );

    renameButton!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    vi.advanceTimersByTime(501);
    renameButton!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    renameButton!.click();
    expect(typedManager.isMultiSelectMode).toBe(false);
    const input = row.querySelector<HTMLInputElement>('.gv-conversation-rename-input');
    expect(input).not.toBeNull();
    expect(input!.getAttribute('aria-label')).toContain('Original title');
    expect(row.draggable).toBe(false);
    input!.click();
    expect(navigate).not.toHaveBeenCalled();
    renameButton!.click();
    expect(row.querySelectorAll('.gv-conversation-rename-input')).toHaveLength(1);
    input!.value = 'Folder alias';
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(conversation.title).toBe('Folder alias');
    expect(conversation.customTitle).toBe(true);
    expect(row.querySelector('.gv-conversation-title')?.textContent).toBe('Folder alias');
    expect(row.draggable).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    row.querySelector<HTMLButtonElement>('.gv-conversation-remove-btn')!.click();
    expect(confirmRemove).toHaveBeenCalledWith(
      'folder-1',
      'conversation-1',
      'Folder alias',
      expect.any(MouseEvent),
    );

    row.querySelector<HTMLElement>('.gv-conversation-title')!.click();
    expect(navigate).toHaveBeenCalledWith('folder-1', 'conversation-1');
    expect(row.querySelector('.gv-conversation-rename-input')).toBeNull();
    manager.destroy();
  });
});
