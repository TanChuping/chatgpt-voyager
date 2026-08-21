import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  options: { keepButtonEnabledWhenEmpty?: boolean; useVisualDisabledState?: boolean } = {},
): string[] {
  const pasted: string[] = [];
  editor.addEventListener('paste', (event) => {
    const clipboardEvent = event as ClipboardEvent;
    if ((clipboardEvent.clipboardData?.files.length ?? 0) > 0) return;
    const text = clipboardEvent.clipboardData?.getData('text/plain') ?? '';
    pasted.push(text);
    event.preventDefault();
    editor.textContent = text;
    const disabled = !options.keepButtonEnabledWhenEmpty && text.trim().length === 0;
    if (options.useVisualDisabledState) {
      button.disabled = false;
      if (disabled) {
        button.setAttribute('aria-disabled', 'true');
        button.setAttribute('data-visually-disabled', 'true');
      } else {
        button.removeAttribute('aria-disabled');
        button.removeAttribute('data-visually-disabled');
      }
    } else {
      button.disabled = disabled;
    }
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return pasted;
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.resolve();
}

function setChatGptSendBinding(binding: string[]): void {
  const key = 'oai/apps/keyboardShortcuts/test-user/test-account';
  window.localStorage.setItem(key, JSON.stringify({ composerSubmit: { binding } }));
  Object.defineProperty(window.localStorage, 'key', {
    configurable: true,
    value: (index: number) => (index === 0 ? key : null),
  });
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
    window.localStorage.clear();
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
      value: vi.fn((command: string) => {
        const active = document.activeElement;
        if (command !== 'delete' || !(active instanceof HTMLElement)) return false;
        active.textContent = '';
        active.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }),
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

  it('reattaches the plain textarea when ChatGPT rebuilds the composer host', async () => {
    const { editor } = mountComposer('existing draft');
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    const host = editor.parentElement!;

    host.replaceChildren(editor);
    await Promise.resolve();
    await Promise.resolve();

    expect(textarea.isConnected).toBe(true);
    expect(textarea.parentElement).toBe(host);
    expect(textarea.value).toBe('existing draft');
    expect(document.querySelectorAll('textarea[data-gv-plain-text-input="true"]')).toHaveLength(1);
  });

  it('maps native ProseMirror paragraphs to single newlines', async () => {
    const { editor } = mountComposer();
    editor.innerHTML = '<p>first line</p><p>second line</p>';
    const { startPlainTextInput } = await import('../index');

    cleanup = await startPlainTextInput();

    expect(
      document.querySelector<HTMLTextAreaElement>('textarea[data-gv-plain-text-input="true"]')
        ?.value,
    ).toBe('first line\nsecond line');
  });

  it('keeps the native editor vertical metrics on the plain textarea', async () => {
    const { editor } = mountComposer('first line');
    editor.style.marginTop = '16px';
    editor.style.paddingBottom = '16px';
    editor.style.lineHeight = '26px';
    const { startPlainTextInput } = await import('../index');

    cleanup = await startPlainTextInput();

    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    expect(textarea.style.marginTop).toBe('16px');
    expect(textarea.style.paddingBottom).toBe('16px');
    expect(textarea.style.lineHeight).toBe('26px');
    expect(textarea.rows).toBe(1);
    expect(document.getElementById('gv-plain-text-input-style')?.textContent).toContain(
      'box-shadow: none !important',
    );
  });

  it('follows editor hydration until the user starts editing the plain layer', async () => {
    const { editor, button } = mountComposer('pre-hydration draft');
    const pasted = installPasteTransaction(editor, button);
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

  it('syncs the exact Markdown source at the native Enter boundary', async () => {
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
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await advance(120);

    expect(pasted.at(-1)).toBe(source);
    expect(editor.textContent).toBe(source);
    expect(textarea.value).toBe(source);
  });

  it('ignores delayed native sync echoes while the user continues typing', async () => {
    const { editor } = mountComposer();
    editor.addEventListener('paste', (event) => {
      const text = (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
      event.preventDefault();
      editor.textContent = text;
      window.setTimeout(() => {
        editor.focus();
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      }, 0);
    });
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();

    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    textarea.focus();
    textarea.value = 'first line';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    textarea.value = 'first line\nsecond line';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    await advance(100);

    expect(textarea.value).toBe('first line\nsecond line');
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(textarea.value.length);
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

  it('supports attachment-only native Enter after verifying an empty editor', async () => {
    const { editor, button } = mountComposer();
    installPasteTransaction(editor, button, { keepButtonEnabledWhenEmpty: true });
    const sent = vi.fn();
    button.addEventListener('click', sent);
    editor.closest('form')?.addEventListener(
      'keydown',
      (event) => {
        if ((event as KeyboardEvent).key === 'Enter') button.click();
      },
      { capture: true },
    );
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

  it('clears the plain draft when an attachment disappearing proves the mixed send started', async () => {
    const { editor, button } = mountComposer();
    installPasteTransaction(editor, button, { useVisualDisabledState: true });
    const attachment = document.createElement('div');
    attachment.setAttribute('data-testid', 'attachment-preview');
    editor.closest('[data-testid="composer"]')?.appendChild(attachment);
    const sent = vi.fn(() => attachment.remove());
    button.addEventListener('click', sent);
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('data-visually-disabled', 'true');
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();

    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    textarea.value = 'caption for image';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await advance(250);

    expect(sent).toHaveBeenCalledTimes(1);
    expect(attachment.isConnected).toBe(false);
    expect(textarea.value).toBe('');
  });

  it('keeps a text draft when the send button only becomes disabled', async () => {
    const { editor, button } = mountComposer();
    installPasteTransaction(editor, button, { useVisualDisabledState: true });
    button.addEventListener('click', () => {
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('data-visually-disabled', 'true');
    });
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();

    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    textarea.value = 'draft that was not sent';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await advance(1400);

    expect(textarea.value).toBe('draft that was not sent');
    expect(editor.textContent).toBe('draft that was not sent');
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
    expect(editor.textContent).toBe('');

    // Restore a synchronizable state so lifecycle cleanup can complete.
    textarea.value = '';
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

  it('sends through the verified pipeline without replaying Enter to competing editors', async () => {
    const { editor, button } = mountComposer('question');
    const pasted = installPasteTransaction(editor, button);
    const nativePolicy = vi.fn();
    editor.closest('form')?.addEventListener('keydown', nativePolicy, { capture: true });
    const competingHandler = vi.fn();
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();

    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    textarea.value = 'raw **Markdown**\nsecond line';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.addEventListener('keydown', competingHandler, { capture: true });
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await advance(100);

    expect(pasted.at(-1)).toBe('raw **Markdown**\nsecond line');
    expect(editor.textContent).toBe('raw **Markdown**\nsecond line');
    expect(nativePolicy).not.toHaveBeenCalled();
    expect(competingHandler).not.toHaveBeenCalled();
  });

  it('does not focus or rewrite the native editor when textarea selection loses focus', async () => {
    const { editor, button } = mountComposer('question');
    const pasted = installPasteTransaction(editor, button);
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;

    textarea.value = 'select this text';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.setSelectionRange(2, 9);
    textarea.dispatchEvent(new FocusEvent('blur'));
    await advance(100);

    expect(pasted).toEqual([]);
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(9);
  });

  it('does not let composer click handlers steal focus from the plain textarea', async () => {
    const { editor } = mountComposer('question');
    const composerClick = vi.fn();
    editor.parentElement?.parentElement?.addEventListener('click', composerClick);
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();

    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    textarea.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(composerClick).not.toHaveBeenCalled();
  });

  it('isolates textarea beforeinput from ChatGPT rich-editor capture handlers', async () => {
    const { editor } = mountComposer();
    const nativeBeforeInput = vi.fn();
    editor.closest('form')?.addEventListener('beforeinput', nativeBeforeInput, { capture: true });
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();

    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: '*',
      inputType: 'insertText',
    });
    textarea.dispatchEvent(event);

    expect(nativeBeforeInput).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('stops text paste before ChatGPT document capture can take over the native editor', async () => {
    mountComposer();
    const pagePaste = vi.fn();
    document.addEventListener('paste', pagePaste, { capture: true });
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    const transfer = new FakeDataTransfer();
    transfer.setData('text/plain', 'copied fragment');
    const event = new FakeClipboardEvent('paste', {
      clipboardData: transfer as unknown as DataTransfer,
      bubbles: true,
      cancelable: true,
    });

    textarea.dispatchEvent(event);
    document.removeEventListener('paste', pagePaste, { capture: true });

    expect(pagePaste).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('lets ChatGPT enable its visually-disabled send button from the hidden native editor', async () => {
    const { editor, button } = mountComposer();
    installPasteTransaction(editor, button, { useVisualDisabledState: true });
    editor.closest('form')?.addEventListener('input', () => queueMicrotask(() => editor.focus()));
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('data-visually-disabled', 'true');
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;

    textarea.value = 'plain draft';
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await advance(100);
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(button.hasAttribute('data-visually-disabled')).toBe(false);
    expect(editor.textContent).toBe('plain draft');
    expect(document.activeElement).toBe(textarea);

    textarea.value = 'plain draft updated';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await advance(100);
    expect(editor.textContent).toBe('plain draft');

    textarea.value = '';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await advance(100);
    expect(editor.textContent).toBe('');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('data-visually-disabled')).toBe(true);
  });

  it('follows ChatGPT composerSubmit policy for Enter versus Ctrl+Enter', async () => {
    const { editor, button } = mountComposer('question');
    installPasteTransaction(editor, button);
    const sent = vi.fn();
    button.addEventListener('click', sent);
    setChatGptSendBinding(['mod', 'Enter']);
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;

    const plainEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(plainEnter);
    const imeEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      isComposing: true,
    });
    textarea.dispatchEvent(imeEnter);
    const ctrlEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    textarea.dispatchEvent(ctrlEnter);
    await advance(100);

    expect(plainEnter.defaultPrevented).toBe(true);
    expect(imeEnter.defaultPrevented).toBe(false);
    expect(ctrlEnter.defaultPrevented).toBe(true);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('does not append the textarea default newline when native Ctrl+Enter sends', async () => {
    const { editor, button } = mountComposer();
    const pasted = installPasteTransaction(editor, button, { useVisualDisabledState: true });
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('data-visually-disabled', 'true');
    const sentTexts: string[] = [];
    const sent = vi.fn(() => sentTexts.push(editor.textContent ?? ''));
    button.addEventListener('click', sent);
    setChatGptSendBinding(['mod', 'Enter']);
    const { plainTextInputTestApi, startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[data-gv-plain-text-input="true"]',
    )!;
    textarea.value = 'question';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    const sendEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    expect(window.localStorage.getItem('oai/apps/keyboardShortcuts/test-user/test-account')).toBe(
      JSON.stringify({ composerSubmit: { binding: ['mod', 'Enter'] } }),
    );
    expect(plainTextInputTestApi.readChatGptSendBinding()).toEqual(['mod', 'Enter']);
    expect(plainTextInputTestApi.matchesChatGptSendBinding(sendEvent, ['mod', 'Enter'])).toBe(true);
    textarea.dispatchEvent(sendEvent);
    await Promise.resolve();
    await advance(100);

    expect(sent).toHaveBeenCalledTimes(1);
    expect(sentTexts).toEqual(['question']);
    expect(pasted.at(-1)).toBe('question');
  });

  it('mounts without consulting Voyager send-shortcut settings', async () => {
    mountComposer('question');
    const { startPlainTextInput } = await import('../index');
    cleanup = await startPlainTextInput();

    expect(chrome.storage.sync.get).not.toHaveBeenCalled();
    expect(document.querySelector('textarea[data-gv-plain-text-input="true"]')).not.toBeNull();
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
    button.click();
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
