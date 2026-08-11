import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { findChatGptSidebar } from '../../chatgptDom';
import { FolderManager } from '../manager';
import type { FolderData } from '../types';

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

async function flushMicrotasks(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

type TestableManager = {
  data: FolderData;
  containerElement: HTMLElement | null;
  sidebarContainer: HTMLElement | null;
  folderEnabled: boolean;
  floatingModeEnabled: boolean;
  floatingModeActive: boolean;
  floatingPanelHandle: { element: HTMLElement; destroy: () => void } | null;
  mountRecoveryTimer: number | null;
  mountRecoveryObserver: MutationObserver | null;
  mountRecoveryInterval: number | null;
  setupPersistentMountRecovery: () => void;
  initializeFolderUI: () => Promise<void>;
  teardownEmbeddedFolderUI: () => void;
  reconcileFolderMountMode: () => void;
  isEmbeddedFolderMountHealthy: () => boolean;
  installRouteChangeListener: () => void;
  startFloatingMode: () => Promise<void>;
  makeConversationDraggable: (element: HTMLElement) => void;
  setupMutationObserver: () => void;
  reinitializeFolderUI: () => void;
};

describe('persistent folder mount recovery', () => {
  let manager: FolderManager;
  let typedManager: TestableManager;

  beforeEach(() => {
    vi.useFakeTimers();
    window.history.pushState({}, '', '/');
    document.body.innerHTML = '<div id="app-root" class="side-nav-open"></div>';
    manager = new FolderManager();
    typedManager = manager as unknown as TestableManager;
    typedManager.folderEnabled = true;
    typedManager.floatingModeEnabled = false;
  });

  afterEach(() => {
    manager.destroy();
    document.body.innerHTML = '';
    window.history.pushState({}, '', '/');
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps retrying after an initial mount is absent', () => {
    const reinitialize = vi
      .spyOn(typedManager, 'reinitializeFolderUI')
      .mockImplementation(() => {});

    typedManager.setupPersistentMountRecovery();
    vi.advanceTimersByTime(2001);

    expect(reinitialize).toHaveBeenCalledTimes(1);
  });

  it('mounts inside an empty hydrating sidebar instead of beside it', async () => {
    const sidebar = document.createElement('aside');
    sidebar.dataset.testid = 'sidebar';
    vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 280,
      height: 600,
      top: 0,
      right: 280,
      bottom: 600,
      left: 0,
      toJSON: () => ({}),
    });
    document.body.appendChild(sidebar);

    await typedManager.initializeFolderUI();

    expect(typedManager.containerElement).not.toBeNull();
    expect(sidebar.contains(typedManager.containerElement)).toBe(true);
    expect(typedManager.isEmbeddedFolderMountHealthy()).toBe(true);
  });

  it('recovers promptly when ChatGPT detaches the mounted sidebar subtree', async () => {
    const sidebar = document.createElement('aside');
    const container = document.createElement('div');
    sidebar.appendChild(container);
    document.body.appendChild(sidebar);
    typedManager.sidebarContainer = sidebar;
    typedManager.containerElement = container;
    const reinitialize = vi
      .spyOn(typedManager, 'reinitializeFolderUI')
      .mockImplementation(() => {});

    typedManager.setupPersistentMountRecovery();
    sidebar.remove();
    for (let index = 0; index < 20; index++) {
      document.body.appendChild(document.createElement('span'));
    }
    await Promise.resolve();
    vi.advanceTimersByTime(151);

    expect(reinitialize).toHaveBeenCalledTimes(1);
  });

  it('does not churn while the container is healthy', async () => {
    const sidebar = document.createElement('aside');
    sidebar.id = 'sidebar';
    const container = document.createElement('div');
    sidebar.appendChild(container);
    document.body.appendChild(sidebar);
    const visibleRect = {
      x: 0,
      y: 0,
      width: 280,
      height: 600,
      top: 0,
      right: 280,
      bottom: 600,
      left: 0,
      toJSON: () => ({}),
    };
    vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue(visibleRect);
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(visibleRect);
    typedManager.sidebarContainer = sidebar;
    typedManager.containerElement = container;
    const reinitialize = vi
      .spyOn(typedManager, 'reinitializeFolderUI')
      .mockImplementation(() => {});

    typedManager.setupPersistentMountRecovery();
    document.body.appendChild(document.createElement('span'));
    await Promise.resolve();
    vi.advanceTimersByTime(6000);

    expect(reinitialize).not.toHaveBeenCalled();
    expect(typedManager.mountRecoveryTimer).toBeNull();
  });

  it('does not inject folders on Codex routes', () => {
    window.history.pushState({}, '', '/codex/tasks');
    const reinitialize = vi
      .spyOn(typedManager, 'reinitializeFolderUI')
      .mockImplementation(() => {});

    typedManager.setupPersistentMountRecovery();
    vi.advanceTimersByTime(6000);

    expect(reinitialize).not.toHaveBeenCalled();
  });

  it('rejects a connected panel hosted by a hidden stale sidebar', () => {
    const staleSidebar = document.createElement('aside');
    staleSidebar.style.display = 'none';
    staleSidebar.innerHTML = '<a href="/c/old">Old</a>';
    const staleContainer = document.createElement('div');
    staleSidebar.appendChild(staleContainer);
    const activeSidebar = document.createElement('aside');
    activeSidebar.innerHTML = '<a href="/c/current">Current</a>';
    vi.spyOn(activeSidebar, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 280,
      height: 600,
      top: 0,
      right: 280,
      bottom: 600,
      left: 0,
      toJSON: () => ({}),
    });
    document.body.append(staleSidebar, activeSidebar);
    typedManager.sidebarContainer = staleSidebar;
    typedManager.containerElement = staleContainer;

    expect(findChatGptSidebar()).toBe(activeSidebar);
    expect(typedManager.isEmbeddedFolderMountHealthy()).toBe(false);
  });

  it('retries when the app says open but no visible sidebar can be resolved', () => {
    const hiddenSidebar = document.createElement('aside');
    hiddenSidebar.id = 'sidebar';
    hiddenSidebar.style.display = 'none';
    const container = document.createElement('div');
    hiddenSidebar.appendChild(container);
    document.body.appendChild(hiddenSidebar);
    typedManager.sidebarContainer = hiddenSidebar;
    typedManager.containerElement = container;

    expect(findChatGptSidebar()).toBeNull();
    expect(typedManager.isEmbeddedFolderMountHealthy()).toBe(false);
  });

  it('rejects a hidden old host when ChatGPT omits the side-nav state class', () => {
    document.querySelector('#app-root')!.className = '';
    const staleSidebar = document.createElement('aside');
    staleSidebar.style.display = 'none';
    const staleContainer = document.createElement('div');
    staleSidebar.appendChild(staleContainer);
    const activeSidebar = document.createElement('aside');
    activeSidebar.innerHTML = '<a href="/c/current">Current</a>';
    vi.spyOn(activeSidebar, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 280,
      height: 600,
      top: 0,
      right: 280,
      bottom: 600,
      left: 0,
      toJSON: () => ({}),
    });
    document.body.append(staleSidebar, activeSidebar);
    typedManager.sidebarContainer = staleSidebar;
    typedManager.containerElement = staleContainer;

    expect(typedManager.isEmbeddedFolderMountHealthy()).toBe(false);
  });

  it('rejects a stale hidden state on the folder container after its host recovers', () => {
    const sidebar = document.createElement('aside');
    sidebar.innerHTML = '<a href="/c/current">Current</a>';
    const container = document.createElement('div');
    container.style.display = 'none';
    sidebar.appendChild(container);
    const visibleRect = {
      x: 0,
      y: 0,
      width: 280,
      height: 600,
      top: 0,
      right: 280,
      bottom: 600,
      left: 0,
      toJSON: () => ({}),
    };
    vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue(visibleRect);
    document.body.appendChild(sidebar);
    typedManager.sidebarContainer = sidebar;
    typedManager.containerElement = container;

    expect(findChatGptSidebar()).toBe(sidebar);
    expect(typedManager.isEmbeddedFolderMountHealthy()).toBe(false);
  });

  it('prefers a visible hydrating sidebar over an offscreen old history host', () => {
    const staleSidebar = document.createElement('aside');
    staleSidebar.innerHTML = '<a href="/c/old">Old</a>';
    vi.spyOn(staleSidebar, 'getBoundingClientRect').mockReturnValue({
      x: -500,
      y: 0,
      width: 280,
      height: 600,
      top: 0,
      right: -220,
      bottom: 600,
      left: -500,
      toJSON: () => ({}),
    });
    const activeSidebar = document.createElement('aside');
    activeSidebar.dataset.testid = 'sidebar';
    vi.spyOn(activeSidebar, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 280,
      height: 600,
      top: 0,
      right: 280,
      bottom: 600,
      left: 0,
      toJSON: () => ({}),
    });
    document.body.append(staleSidebar, activeSidebar);

    expect(findChatGptSidebar()).toBe(activeSidebar);
  });

  it('never mistakes a visible sidebar toggle control for the sidebar host', () => {
    const toggle = document.createElement('button');
    toggle.dataset.testid = 'sidebar-toggle';
    document.body.appendChild(toggle);

    expect(findChatGptSidebar()).toBeNull();
  });

  it('keeps an exact sidebar host even when it contains a Canvas shortcut', () => {
    const sidebar = document.createElement('aside');
    sidebar.id = 'sidebar';
    sidebar.innerHTML = '<button data-testid="canvas-link">Canvas</button>';
    document.body.appendChild(sidebar);

    expect(findChatGptSidebar()).toBe(sidebar);
  });

  it('prefers semantic history navigation over an unrelated visible aside', () => {
    const unrelatedAside = document.createElement('aside');
    const historyNav = document.createElement('nav');
    historyNav.setAttribute('aria-label', 'History');
    historyNav.innerHTML = '<a href="/c/current">Current</a>';
    const visibleRect = {
      x: 0,
      y: 0,
      width: 280,
      height: 600,
      top: 0,
      right: 280,
      bottom: 600,
      left: 0,
      toJSON: () => ({}),
    };
    vi.spyOn(unrelatedAside, 'getBoundingClientRect').mockReturnValue(visibleRect);
    vi.spyOn(historyNav, 'getBoundingClientRect').mockReturnValue(visibleRect);
    document.body.append(unrelatedAside, historyNav);

    expect(findChatGptSidebar()).toBe(historyNav);
  });

  it('ignores a visible plain utility aside while the real sidebar is folded away', () => {
    const foldedSidebar = document.createElement('aside');
    foldedSidebar.id = 'sidebar';
    foldedSidebar.style.transform = 'translateX(-100%)';
    const utilityAside = document.createElement('aside');
    vi.spyOn(foldedSidebar, 'getBoundingClientRect').mockReturnValue({
      x: -500,
      y: 0,
      width: 280,
      height: 600,
      top: 0,
      right: -220,
      bottom: 600,
      left: -500,
      toJSON: () => ({}),
    });
    vi.spyOn(utilityAside, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 320,
      height: 600,
      top: 0,
      right: 320,
      bottom: 600,
      left: 0,
      toJSON: () => ({}),
    });
    document.body.append(foldedSidebar, utilityAside);

    expect(findChatGptSidebar()).toBe(foldedSidebar);
  });

  it('ignores main chat and unrelated wildcard tool sidebars', () => {
    const foldedSidebar = document.createElement('aside');
    foldedSidebar.id = 'sidebar';
    const main = document.createElement('main');
    main.setAttribute('aria-label', 'Chat');
    main.innerHTML = '<p>User pasted <a href="/c/shared">a shared chat</a></p>';
    const tools = document.createElement('aside');
    tools.setAttribute('aria-label', 'Chat tools');
    tools.innerHTML = '<immersive-editor><a href="/c/shared">Shared chat</a></immersive-editor>';
    const offscreenRect = {
      x: -500,
      y: 0,
      width: 280,
      height: 600,
      top: 0,
      right: -220,
      bottom: 600,
      left: -500,
      toJSON: () => ({}),
    };
    const visibleRect = {
      x: 0,
      y: 0,
      width: 320,
      height: 600,
      top: 0,
      right: 320,
      bottom: 600,
      left: 0,
      toJSON: () => ({}),
    };
    vi.spyOn(foldedSidebar, 'getBoundingClientRect').mockReturnValue(offscreenRect);
    vi.spyOn(main, 'getBoundingClientRect').mockReturnValue(visibleRect);
    vi.spyOn(tools, 'getBoundingClientRect').mockReturnValue(visibleRect);
    document.body.append(foldedSidebar, main, tools);

    expect(findChatGptSidebar()).toBe(foldedSidebar);
  });

  it('treats the same offscreen host as collapsed when no side-nav state exists', () => {
    document.querySelector('#app-root')!.className = '';
    const sidebar = document.createElement('aside');
    sidebar.id = 'sidebar';
    const container = document.createElement('div');
    sidebar.appendChild(container);
    vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue({
      x: -500,
      y: 0,
      width: 280,
      height: 600,
      top: 0,
      right: -220,
      bottom: 600,
      left: -500,
      toJSON: () => ({}),
    });
    document.body.appendChild(sidebar);
    typedManager.sidebarContainer = sidebar;
    typedManager.containerElement = container;

    expect(findChatGptSidebar()).toBe(sidebar);
    expect(typedManager.isEmbeddedFolderMountHealthy()).toBe(true);
  });

  it('removes a panel from an offline sidebar subtree before it can be reattached', () => {
    const sidebar = document.createElement('aside');
    const container = document.createElement('div');
    container.className = 'gv-folder-container';
    sidebar.appendChild(container);
    document.body.appendChild(sidebar);
    typedManager.sidebarContainer = sidebar;
    typedManager.containerElement = container;
    sidebar.remove();

    typedManager.teardownEmbeddedFolderUI();
    document.body.appendChild(sidebar);

    expect(document.querySelectorAll('.gv-folder-container')).toHaveLength(0);
  });

  it('reconciles disabled and floating modes without leaving embedded recovery alive', () => {
    const startFloating = vi.spyOn(typedManager, 'startFloatingMode').mockResolvedValue();
    typedManager.floatingModeEnabled = true;
    typedManager.reconcileFolderMountMode();
    expect(startFloating).toHaveBeenCalledTimes(1);
    expect(typedManager.mountRecoveryObserver).toBeNull();
    expect(typedManager.mountRecoveryInterval).toBeNull();

    typedManager.folderEnabled = false;
    typedManager.reconcileFolderMountMode();
    expect(typedManager.mountRecoveryObserver).toBeNull();
    expect(typedManager.mountRecoveryInterval).toBeNull();
  });

  it('does not wrap or replace another feature’s history hooks', () => {
    const nativePushState = history.pushState;
    const priorWrapper = function (this: History, ...args: Parameters<History['pushState']>) {
      return nativePushState.apply(this, args);
    };
    history.pushState = priorWrapper;
    typedManager.installRouteChangeListener();
    expect(history.pushState).toBe(priorWrapper);
    manager.destroy();

    expect(history.pushState).toBe(priorWrapper);
    history.pushState = nativePushState;
  });

  it('does not resurrect a deferred floating panel after the feature is disabled', async () => {
    let resolveStorage!: (value: Record<string, unknown>) => void;
    vi.mocked(browser.storage.sync.get).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStorage = resolve;
      }) as ReturnType<typeof browser.storage.sync.get>,
    );
    typedManager.floatingModeEnabled = true;

    const start = typedManager.startFloatingMode();
    await Promise.resolve();
    typedManager.folderEnabled = false;
    typedManager.reconcileFolderMountMode();
    resolveStorage({});
    await start;

    expect(document.querySelector('.gv-floating-folder-panel')).toBeNull();
    expect(document.querySelector('.gv-floating-fab')).toBeNull();
  });

  it('recovers a floating panel removed by an SPA body replacement', async () => {
    vi.mocked(browser.storage.sync.get).mockResolvedValue({});
    typedManager.floatingModeEnabled = true;

    await typedManager.startFloatingMode();
    const firstPanel = document.querySelector<HTMLElement>('.gv-floating-folder-panel')!;
    expect(firstPanel).not.toBeNull();
    firstPanel.remove();

    vi.advanceTimersByTime(2001);
    await flushMicrotasks();

    const recoveredPanel = document.querySelector<HTMLElement>('.gv-floating-folder-panel');
    expect(recoveredPanel).not.toBeNull();
    expect(recoveredPanel).not.toBe(firstPanel);
    expect(typedManager.floatingPanelHandle?.element).toBe(recoveredPanel);
  });

  it('single-flights a stalled floating FAB storage read across watchdog ticks', async () => {
    vi.mocked(browser.storage.sync.get).mockClear();
    vi.mocked(browser.storage.sync.get).mockReturnValue(
      new Promise(() => {}) as ReturnType<typeof browser.storage.sync.get>,
    );
    typedManager.floatingModeEnabled = true;

    void typedManager.startFloatingMode();
    await Promise.resolve();
    vi.advanceTimersByTime(6001);
    await flushMicrotasks();

    // One stalled read for the panel and one for the FAB. Later watchdog
    // ticks must join the same FAB mount promise instead of growing linearly.
    expect(browser.storage.sync.get).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.gv-floating-folder-panel, .gv-floating-fab')).not.toBeNull();
  });

  it('does not delete folder data when a virtualized native row leaves the DOM', async () => {
    const sidebar = document.createElement('aside');
    sidebar.id = 'sidebar';
    const row = document.createElement('li');
    row.innerHTML = '<a href="/c/conversation-1">Conversation</a>';
    sidebar.appendChild(row);
    document.body.appendChild(sidebar);
    typedManager.sidebarContainer = sidebar;
    typedManager.data = {
      folders: [],
      folderContents: {
        'folder-1': [
          {
            conversationId: 'conversation-1',
            title: 'Conversation',
            url: 'https://chatgpt.com/c/conversation-1',
            addedAt: 1,
          },
        ],
      },
    };
    typedManager.makeConversationDraggable(row);
    typedManager.setupMutationObserver();

    row.remove();
    await Promise.resolve();
    vi.advanceTimersByTime(5000);

    expect(typedManager.data.folderContents['folder-1']).toHaveLength(1);
  });

  it('removes native row handlers and idempotency markers during embedded teardown', () => {
    const sidebar = document.createElement('aside');
    const row = document.createElement('li');
    const link = document.createElement('a');
    link.href = '/c/conversation-1';
    link.textContent = 'Conversation';
    row.appendChild(link);
    sidebar.appendChild(row);
    document.body.appendChild(sidebar);
    typedManager.sidebarContainer = sidebar;

    typedManager.makeConversationDraggable(row);
    expect(row.dataset.gvConvDragAttached).toBe('true');
    expect(row.draggable).toBe(true);

    typedManager.teardownEmbeddedFolderUI();

    expect(row.dataset.gvConvDragAttached).toBeUndefined();
    expect(row.draggable).toBe(false);
    expect(row.style.cursor).toBe('');
  });

  it('keeps a conversation instrumented when ChatGPT reparents it in one mutation batch', async () => {
    const sidebar = document.createElement('aside');
    const firstList = document.createElement('ul');
    const secondList = document.createElement('ul');
    const row = document.createElement('li');
    const link = document.createElement('a');
    link.href = '/c/conversation-1';
    link.textContent = 'Conversation';
    row.appendChild(link);
    firstList.appendChild(row);
    sidebar.append(firstList, secondList);
    document.body.appendChild(sidebar);
    typedManager.sidebarContainer = sidebar;
    typedManager.makeConversationDraggable(row);
    typedManager.setupMutationObserver();

    secondList.appendChild(row);
    await Promise.resolve();

    expect(row.dataset.gvConvDragAttached).toBe('true');
    expect(row.draggable).toBe(true);
  });
});
