import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import { PLAIN_TEXT_BEFORE_SEND_EVENT } from '../../shared/plainTextInputBridge';

vi.mock('@/utils/i18n', () => ({
  getTranslationSyncUnsafe: (key: string) => key,
}));

vi.mock('../../folder/folderColors', () => ({
  getFolderColor: () => '#4285f4',
  isDarkMode: () => false,
}));

describe('folderProject plain-text send bridge', () => {
  let cleanup: (() => void) | null;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    cleanup = null;
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/');
    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_defaults: Record<string, unknown>, callback: (result: Record<string, unknown>) => void) => {
        callback({
          [StorageKeys.FOLDER_PROJECT_ENABLED]: true,
          [StorageKeys.CTRL_ENTER_SEND]: false,
        });
      },
    );
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (chrome.storage.local.remove as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );
  });

  afterEach(() => {
    cleanup?.();
    document.body.innerHTML = '';
  });

  it('prepends selected-folder instructions before a plain-text native send', async () => {
    const addListenerSpy = vi.spyOn(document, 'addEventListener');
    document.body.innerHTML = `
      <form data-type="unified-composer">
        <div data-testid="composer">
          <textarea id="decoy-input" data-gv-plain-text-input="true">do not modify</textarea>
          <button type="button" data-testid="send-button"></button>
        </div>
      </form>
      <form data-type="unified-composer">
        <div data-testid="composer">
          <textarea id="target-input" data-gv-plain-text-input="true">question</textarea>
          <button type="button" data-testid="send-button"></button>
        </div>
      </form>
      <div class="trailing-actions-wrapper"><button class="model-picker-container"></button></div>
    `;
    const modelPicker = document.querySelector('.model-picker-container');
    if (!(modelPicker instanceof HTMLElement)) throw new Error('Expected model picker fixture.');
    vi.spyOn(modelPicker, 'getBoundingClientRect').mockReturnValue({ height: 20 } as DOMRect);

    const manager = {
      ensureDataLoaded: vi.fn().mockResolvedValue(undefined),
      getFolders: vi
        .fn()
        .mockReturnValue([
          { id: 'folder-1', name: 'Research', instructions: 'Use primary sources.' },
        ]),
      addConversationToFolderFromNative: vi.fn(),
    };
    const { startFolderProject } = await import('../index');
    cleanup = startFolderProject(manager as unknown as Parameters<typeof startFolderProject>[0]);
    await Promise.resolve();
    await Promise.resolve();
    expect(addListenerSpy).toHaveBeenCalledWith(PLAIN_TEXT_BEFORE_SEND_EVENT, expect.any(Function));

    const chip = document.querySelector<HTMLButtonElement>('.gv-fp-chip');
    if (!chip) throw new Error('Expected folder picker chip.');
    chip.click();
    await Promise.resolve();
    await Promise.resolve();
    const folderItem = Array.from(document.querySelectorAll<HTMLButtonElement>('.gv-fp-item')).find(
      (item) => item.textContent?.includes('Research'),
    );
    if (!folderItem) throw new Error('Expected folder option.');
    folderItem.click();
    expect(chip.dataset.selected).toBe('folder-1');

    const textarea = document.querySelector<HTMLTextAreaElement>('#target-input');
    const sendButton = textarea
      ?.closest('[data-testid="composer"]')
      ?.querySelector<HTMLButtonElement>('[data-testid="send-button"]');
    if (!sendButton || !textarea) throw new Error('Expected composer controls.');
    vi.spyOn(textarea, 'getBoundingClientRect').mockReturnValue({ height: 24 } as DOMRect);

    // The legacy Voyager Enter setting must not prepend instructions directly
    // to the visible plain textarea. ChatGPT decides whether the key sends;
    // the plain-text bridge injects instructions only after a real send starts.
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(textarea.value).toBe('question');

    sendButton.dispatchEvent(
      new CustomEvent(PLAIN_TEXT_BEFORE_SEND_EVENT, {
        bubbles: true,
        detail: { input: textarea },
      }),
    );

    expect(textarea.value).toContain('Use primary sources.');
    expect(textarea.value).toContain('question');
    expect((document.querySelector('#decoy-input') as HTMLTextAreaElement).value).toBe(
      'do not modify',
    );
  });
});
