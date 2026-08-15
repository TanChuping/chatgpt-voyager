import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  },
}));

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: () => 'Message ChatGPT',
}));

function mountCurrentComposer(): {
  container: HTMLElement;
  nativeEditor: HTMLElement;
  textarea: HTMLTextAreaElement;
} {
  const container = document.createElement('div');
  container.style.backgroundColor = 'rgb(240, 240, 240)';
  container.style.display = 'flex';
  container.innerHTML = `
    <div data-testid="composer">
      <div class="composer-host">
        <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
        <textarea data-gv-plain-text-input="true">visible draft</textarea>
      </div>
    </div>
  `;
  document.body.append(container);
  const nativeEditor = container.querySelector('#prompt-textarea');
  const textarea = container.querySelector('textarea[data-gv-plain-text-input="true"]');
  if (!(nativeEditor instanceof HTMLElement) || !(textarea instanceof HTMLTextAreaElement)) {
    throw new Error('Expected current composer fixture.');
  }
  textarea.value = 'visible draft';
  return { container, nativeEditor, textarea };
}

describe('inputCollapse plain-text compatibility', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/c/plain-text-test');
    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_defaults: Record<string, unknown>, callback: (result: Record<string, unknown>) => void) => {
        callback({
          [StorageKeys.INPUT_COLLAPSE_ENABLED]: true,
          [StorageKeys.INPUT_COLLAPSE_WHEN_NOT_EMPTY]: false,
        });
      },
    );
  });

  afterEach(async () => {
    const { cleanup } = await import('../index');
    cleanup();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  it('uses the visible textarea for content checks, focus, and caret placement', async () => {
    const { container, nativeEditor, textarea } = mountCurrentComposer();
    const { collapseInput, expandInputWithCursorAtEnd, startInputCollapse } =
      await import('../index');
    startInputCollapse();
    await vi.runAllTimersAsync();

    collapseInput();
    expect(container.classList.contains('gv-input-collapsed')).toBe(false);

    container.classList.add('gv-input-collapsed');
    expandInputWithCursorAtEnd();
    await vi.runAllTimersAsync();

    expect(document.activeElement).toBe(textarea);
    expect(document.activeElement).not.toBe(nativeEditor);
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(textarea.selectionEnd).toBe(textarea.value.length);
  });
});
