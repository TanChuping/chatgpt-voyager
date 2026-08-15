import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

interface ClipboardPayload {
  clipboardData?: DataTransfer;
  bubbles?: boolean;
  cancelable?: boolean;
}

class FakeDataTransfer {
  private readonly values = new Map<string, string>();
  private readonly fileValues: File[] = [];

  readonly items = {
    add: (file: File) => {
      this.fileValues.push(file);
      return file as unknown as DataTransferItem;
    },
    [Symbol.iterator]: () =>
      this.fileValues
        .map((file) => ({
          kind: 'file',
          type: file.type,
          getAsFile: () => file,
        }))
        [Symbol.iterator](),
  };

  get files(): FileList {
    return this.fileValues as unknown as FileList;
  }

  get types(): readonly string[] {
    return [...this.values.keys(), ...(this.fileValues.length > 0 ? ['Files'] : [])];
  }

  setData(type: string, value: string): void {
    this.values.set(type, value);
  }

  getData(type: string): string {
    return this.values.get(type) ?? '';
  }
}

class FakeClipboardEvent extends Event {
  readonly clipboardData: DataTransfer | null;

  constructor(type: string, init: ClipboardPayload = {}) {
    super(type, init);
    this.clipboardData = init.clipboardData ?? null;
  }
}

function mountComposer(initialText = ''): {
  editor: HTMLElement;
  button: HTMLButtonElement;
} {
  document.body.innerHTML = `
    <form data-type="unified-composer">
      <div data-testid="composer">
        <div class="composer-editor-host">
          <div id="prompt-textarea" contenteditable="true" role="textbox" aria-label="Message ChatGPT">${initialText}</div>
        </div>
        <button type="button" data-testid="send-button"></button>
      </div>
    </form>
  `;
  const editor = document.getElementById('prompt-textarea');
  const button = document.querySelector('button[data-testid="send-button"]');
  if (!(editor instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
    throw new Error('Expected composer fixture.');
  }
  return { editor, button };
}

function installPasteTransaction(
  editor: HTMLElement,
  button: HTMLButtonElement,
  options: { keepButtonEnabledWhenEmpty?: boolean } = {},
): string[] {
  const pasted: string[] = [];
  editor.addEventListener('paste', (event) => {
    const clipboardEvent = event as ClipboardEvent;
    if ((clipboardEvent.clipboardData?.files.length ?? 0) > 0) return;
    const text = clipboardEvent.clipboardData?.getData('text/plain') ?? '';
    pasted.push(text);
    event.preventDefault();
    editor.textContent = text;
    button.disabled = options.keepButtonEnabledWhenEmpty ? false : text.trim().length === 0;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return pasted;
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.resolve();
}

describe('plain text input mode', () => {
  let cleanup: (() => void | Promise<void>) | null;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    cleanup = null;
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/');

    Object.defineProperty(globalThis, 'DataTransfer', {
      configurable: true,
      value: FakeDataTransfer,
    });
    Object.defineProperty(globalThis, 'ClipboardEvent', {
      configurable: true,
      value: FakeClipboardEvent,
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_defaults: unknown, callback: (result: Record<string, unknown>) => void) => callback({}),
    );
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (cleanup) {
      const result = cleanup();
      await vi.runAllTimersAsync();
      await result;
    }
    cleanup = null;
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  it('replaces the visible rich editor with a plain textarea without losing its text', async () => {
    const { editor } = mountComposer('existing draft');
    const { startPlainTextInput } = await import('../index');

    cleanup = await startPlainTextInput();

    const textarea = document.querySelector('textarea[data-gv-plain-text-input="true"]');
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    expect((textarea as HTMLTextAreaElement).value).toBe('existing draft');
    expect(editor.classList.contains('gv-plain-text-input-native')).toBe(true);
    expect(editor.getAttribute('aria-hidden')).toBe('true');
    expect(editor.getAttribute('tabindex')).toBe('-1');
  });

  it('follows editor hydration until the user starts editing the plain layer', async () => {
    const { editor, button } = mountComposer('pre-hydration draft');
    installPasteTransaction(editor, button);
    const { startPlainTextInput } = await import('../index');

    cleanup = await startPlainTextInput();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;

    editor.textContent = 'hydrated draft';
    await advance(0);
    expect(textarea.value).toBe('hydrated draft');

    textarea.value = 'user-owned `*` source';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    editor.textContent = 'late hydration must not win';
    await advance(0);

    expect(textarea.value).toBe('user-owned `*` source');
  });

  it('syncs the exact Markdown source through a verified native paste transaction', async () => {
    const { editor, button } = mountComposer();
    const pasted = installPasteTransaction(editor, button);
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();

    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    const source = '`*` \n```text\na_b * c\n```';
    textarea.value = source;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new FocusEvent('blur'));
    await advance(120);

    expect(pasted.at(-1)).toBe(source);
    expect(editor.textContent).toBe(source);
    expect(textarea.value).toBe(source);
  });

  it('clears stale native text before allowing an immediate mouse send', async () => {
    const { editor, button } = mountComposer('must not send');
    const pasted = installPasteTransaction(editor, button);
    const sent = vi.fn();
    button.addEventListener('click', sent);
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();

    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    textarea.value = '';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await advance(650);

    expect(pasted.at(-1)).toBe('');
    expect(editor.textContent).toBe('');
    expect(sent).not.toHaveBeenCalled();
  });

  it('supports attachment-only Enter after verifying an empty native editor', async () => {
    const { editor, button } = mountComposer();
    installPasteTransaction(editor, button, { keepButtonEnabledWhenEmpty: true });
    const sent = vi.fn();
    button.addEventListener('click', sent);
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();

    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await advance(100);

    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('sends an attachment without a deleted stale description', async () => {
    const { editor, button } = mountComposer('deleted description');
    const pasted = installPasteTransaction(editor, button, { keepButtonEnabledWhenEmpty: true });
    const sent = vi.fn();
    button.addEventListener('click', sent);
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();

    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    textarea.value = '';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await advance(100);

    expect(pasted.at(-1)).toBe('');
    expect(editor.textContent).toBe('');
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('refuses to send when the native editor ignores the paste transaction', async () => {
    const { editor, button } = mountComposer('old native text');
    const sent = vi.fn();
    button.addEventListener('click', sent);
    editor.addEventListener('paste', (event) => event.preventDefault());
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();

    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    textarea.value = 'latest `*` source';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await advance(300);

    expect(sent).not.toHaveBeenCalled();
    expect(textarea.value).toBe('latest `*` source');
    expect(editor.textContent).toBe('old native text');

    // Restore a synchronizable state so lifecycle cleanup can complete.
    textarea.value = 'old native text';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });

  it('waits for later capture listeners to inject folder instructions before mouse send', async () => {
    const { editor, button } = mountComposer('question');
    const pasted = installPasteTransaction(editor, button);
    const sent = vi.fn();
    button.addEventListener('click', sent);
    const { plainTextInputTestApi, startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();

    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    const injectLater = () => {
      textarea.value = '[folder instructions]\nquestion';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    };
    document.addEventListener(plainTextInputTestApi.beforeSendEvent, injectLater);

    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await advance(120);
    document.removeEventListener(plainTextInputTestApi.beforeSendEvent, injectLater);

    expect(pasted.at(-1)).toBe('[folder instructions]\nquestion');
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('keeps Enter under one owner when another keydown handler is attached', async () => {
    const { editor, button } = mountComposer('question');
    installPasteTransaction(editor, button);
    const competingHandler = vi.fn();
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();

    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    textarea.addEventListener('keydown', competingHandler, { capture: true });
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await advance(100);

    expect(competingHandler).not.toHaveBeenCalled();
  });

  it('locks repeated Enter presses to a single send attempt', async () => {
    const { editor, button } = mountComposer('question');
    installPasteTransaction(editor, button);
    const sent = vi.fn();
    button.addEventListener('click', sent);
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, repeat: true }),
    );
    await advance(100);

    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('owns Ctrl+Enter mode without swallowing plain newline or IME events', async () => {
    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_defaults: unknown, callback: (result: Record<string, unknown>) => void) =>
        callback({ [StorageKeys.CTRL_ENTER_SEND]: true }),
    );
    const { editor, button } = mountComposer('question');
    installPasteTransaction(editor, button);
    const sent = vi.fn();
    button.addEventListener('click', sent);
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;

    const plainEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    textarea.dispatchEvent(plainEnter);
    const imeEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      isComposing: true,
    });
    textarea.dispatchEvent(imeEnter);
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ctrlKey: true }),
    );
    await advance(100);

    expect(plainEnter.defaultPrevented).toBe(false);
    expect(imeEnter.defaultPrevented).toBe(false);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('does not mount an Enter handler before the Ctrl+Enter policy is loaded', async () => {
    let finishSettingsLoad: ((result: Record<string, unknown>) => void) | null = null;
    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_defaults: unknown, callback: (result: Record<string, unknown>) => void) => {
        finishSettingsLoad = callback;
      },
    );
    const { editor, button } = mountComposer('question');
    installPasteTransaction(editor, button);
    const sent = vi.fn();
    button.addEventListener('click', sent);
    const { startPlainTextInput } = await import('../index');

    const starting = startPlainTextInput();
    await Promise.resolve();
    expect(document.querySelector('textarea[data-gv-plain-text-input="true"]')).toBeNull();

    const settingListener = (
      chrome.storage.onChanged.addListener as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.at(-1)?.[0] as
      | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
      | undefined;
    settingListener?.(
      { [StorageKeys.CTRL_ENTER_SEND]: { oldValue: false, newValue: true } },
      'sync',
    );
    if (!finishSettingsLoad) throw new Error('Expected delayed settings callback.');
    finishSettingsLoad({ [StorageKeys.CTRL_ENTER_SEND]: false });
    cleanup = await starting;
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ctrlKey: true }),
    );
    await advance(100);

    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('forwards pasted files to the hidden native editor', async () => {
    const { editor } = mountComposer();
    const receivedFiles: File[] = [];
    const receivedText: string[] = [];
    editor.addEventListener('paste', (event) => {
      receivedFiles.push(...Array.from((event as ClipboardEvent).clipboardData?.files || []));
      receivedText.push((event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '');
    });
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();

    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    const transfer = new FakeDataTransfer();
    const file = new File(['image'], 'capture.png', { type: 'image/png' });
    transfer.items.add(file);
    transfer.setData('text/plain', 'caption kept with file');
    textarea.dispatchEvent(
      new FakeClipboardEvent('paste', {
        clipboardData: transfer as unknown as DataTransfer,
        bubbles: true,
        cancelable: true,
      }),
    );
    await Promise.resolve();

    expect(receivedFiles).toEqual([file]);
    expect(receivedText).toEqual(['caption kept with file']);
  });

  it('does not carry an unsent draft across conversation routes', async () => {
    mountComposer('old conversation draft');
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();
    const oldTextarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    oldTextarea.value = 'private old-conversation text';
    oldTextarea.dispatchEvent(new Event('input', { bubbles: true }));

    window.history.pushState({}, '', '/c/new-conversation');
    mountComposer();
    await advance(0);

    const newTextarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    expect(newTextarea.value).toBe('');
  });

  it('does not carry a draft when ChatGPT reuses the same editor across routes', async () => {
    const { editor, button } = mountComposer('old conversation draft');
    installPasteTransaction(editor, button);
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    textarea.value = 'private old-conversation text';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    window.history.pushState({}, '', '/c/new-conversation');
    await advance(100);

    expect(textarea.value).toBe('');
    textarea.value = 'new conversation text';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await advance(100);
    expect(editor.textContent).toBe('new conversation text');
  });

  it('keeps the newest textarea text when the whole composer is replaced on the same route', async () => {
    mountComposer('older native text');
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    textarea.value = 'latest unsynced characters';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    mountComposer('older native text');
    await advance(0);

    expect(
      document.querySelector<HTMLTextAreaElement>('textarea[data-gv-plain-text-input="true"]')
        ?.value,
    ).toBe('latest unsynced characters');
  });

  it('prefers the newer textarea draft when only the native editor is hydrated again', async () => {
    const { editor } = mountComposer('older native text');
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    textarea.value = 'newest textarea version';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    const host = editor.parentElement!;
    host.innerHTML =
      '<div id="prompt-textarea" contenteditable="true" role="textbox">older native text</div>';
    await advance(0);

    expect(
      document.querySelector<HTMLTextAreaElement>('textarea[data-gv-plain-text-input="true"]')
        ?.value,
    ).toBe('newest textarea version');
  });

  it('does not resurrect deleted text through consecutive editor replacements', async () => {
    mountComposer('delete me');
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    textarea.value = '';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    mountComposer('delete me');
    await advance(0);
    expect(
      document.querySelector<HTMLTextAreaElement>('textarea[data-gv-plain-text-input="true"]')
        ?.value,
    ).toBe('');

    mountComposer();
    await advance(0);
    expect(
      document.querySelector<HTMLTextAreaElement>('textarea[data-gv-plain-text-input="true"]')
        ?.value,
    ).toBe('');
  });

  it('restores the native editor only after flushing verified unsent text', async () => {
    const { editor, button } = mountComposer();
    const pasted = installPasteTransaction(editor, button);
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();

    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    textarea.value = 'unsent_raw_*_text';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    const result = cleanup();
    await vi.runAllTimersAsync();
    await result;
    cleanup = null;

    expect(pasted.at(-1)).toBe('unsent_raw_*_text');
    expect(document.querySelector('textarea[data-gv-plain-text-input="true"]')).toBeNull();
    expect(editor.classList.contains('gv-plain-text-input-native')).toBe(false);
    expect(editor.hasAttribute('aria-hidden')).toBe(false);
    expect(editor.hasAttribute('tabindex')).toBe(false);
  });

  it('persists an unsynced draft before detaching, including on a hidden page', async () => {
    const { editor } = mountComposer('native text that refuses replacement');
    editor.addEventListener('paste', (event) => event.preventDefault());
    const setLocal = chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>;
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    textarea.value = 'recover this raw_*_draft';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    const result = cleanup();
    await vi.runAllTimersAsync();
    await result;
    cleanup = null;

    const snapshots = setLocal.mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(JSON.stringify(snapshots)).toContain('recover this raw_*_draft');
    expect(document.querySelector('textarea[data-gv-plain-text-input="true"]')).toBeNull();
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
    else delete (document as unknown as { visibilityState?: string }).visibilityState;

    const storedSnapshot = snapshots.at(-1) ?? {};
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      storedSnapshot,
    );
    const restoredComposer = mountComposer();
    installPasteTransaction(restoredComposer.editor, restoredComposer.button);
    cleanup = await startPlainTextInput();
    expect(
      document.querySelector<HTMLTextAreaElement>('textarea[data-gv-plain-text-input="true"]')
        ?.value,
    ).toBe('recover this raw_*_draft');
  });

  it('keeps the overlay running when neither native sync nor recovery storage succeeds', async () => {
    const { editor, button } = mountComposer('old native text');
    editor.addEventListener('paste', (event) => event.preventDefault());
    const setLocal = chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>;
    setLocal.mockRejectedValue(new Error('storage unavailable'));
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    textarea.value = 'must remain visible';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    const result = cleanup();
    const rejection = expect(result).rejects.toThrow('could not safely restore');
    await advance(1000);
    await rejection;
    expect(document.querySelector('textarea[data-gv-plain-text-input="true"]')).toBe(textarea);

    setLocal.mockResolvedValue(undefined);
    installPasteTransaction(editor, button);
    cleanup = null;
    const retry = (await import('../index')).stopPlainTextInput();
    await vi.runAllTimersAsync();
    await retry;
  });
});
