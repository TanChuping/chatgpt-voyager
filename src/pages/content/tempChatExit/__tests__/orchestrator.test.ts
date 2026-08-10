import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectMountedTempChatTurns, deliverHandoff } from '../orchestrator';

class FakeDataTransfer {
  private readonly data = new Map<string, string>();
  readonly files: File[] = [];
  readonly items = {
    add: (file: File) => {
      this.files.push(file);
      return null;
    },
  };

  setData(type: string, value: string): void {
    this.data.set(type, value);
  }

  getData(type: string): string {
    return this.data.get(type) || '';
  }
}

class FakeClipboardEvent extends Event {
  readonly clipboardData: FakeDataTransfer | null;

  constructor(type: string, init: ClipboardEventInit = {}) {
    super(type, init);
    this.clipboardData = (init.clipboardData as unknown as FakeDataTransfer | undefined) || null;
  }
}

function installClipboardFakes(): void {
  vi.stubGlobal('DataTransfer', FakeDataTransfer);
  vi.stubGlobal('ClipboardEvent', FakeClipboardEvent);
}

function createComposer(): { form: HTMLFormElement; input: HTMLDivElement } {
  const form = document.createElement('form');
  const input = document.createElement('div');
  input.id = 'prompt-textarea';
  input.contentEditable = 'true';
  input.setAttribute('role', 'textbox');
  form.appendChild(input);
  document.body.appendChild(form);
  return { form, input };
}

describe('temporary-chat handoff orchestration', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    installClipboardFakes();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('keeps distinct same-text turns when ChatGPT supplies stable message ids', () => {
    document.body.innerHTML = `
      <article data-testid="conversation-turn-1">
        <div data-message-author-role="user" data-message-id="message-a">same question</div>
      </article>
      <article data-testid="conversation-turn-3">
        <div data-message-author-role="user" data-message-id="message-b">same question</div>
      </article>
    `;

    const turns = collectMountedTempChatTurns();

    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.id)).toEqual(['message-a', 'message-b']);
    expect(turns.map((turn) => turn.text)).toEqual(['same question', 'same question']);
  });

  it('preserves semantic LaTeX instead of rendered KaTeX glyph text', () => {
    document.body.innerHTML = `
      <article data-testid="conversation-turn-2">
        <div data-message-author-role="assistant" data-message-id="message-math">
          Result:
          <span role="math" data-math-source="x^2 + y^2">
            <span class="katex"><span class="katex-html" aria-hidden="true">visual glyphs</span></span>
          </span>
        </div>
      </article>
    `;

    expect(collectMountedTempChatTurns()[0]?.text).toContain('$x^2 + y^2$');
    expect(collectMountedTempChatTurns()[0]?.text).not.toContain('visual glyphs');
  });

  it('does not claim attachment success when ChatGPT ignores the file paste', async () => {
    vi.useFakeTimers();
    const { input } = createComposer();
    const delivery = {
      mode: 'attachment' as const,
      directive: 'Continue from the attached transcript.',
      attachment: 'long transcript',
      filename: 'temp-chat-handoff.txt',
    };

    const result = deliverHandoff(input, delivery);
    await vi.advanceTimersByTimeAsync(1_300);

    await expect(result).resolves.toBe(false);
    expect(input.textContent).toBe('');
  });

  it('verifies the attachment before inserting the directive', async () => {
    vi.useFakeTimers();
    const { form, input } = createComposer();
    const delivery = {
      mode: 'attachment' as const,
      directive: 'Continue from the attached transcript.',
      attachment: 'long transcript',
      filename: 'temp-chat-handoff.txt',
    };
    input.addEventListener('paste', (event) => {
      const data = (event as unknown as FakeClipboardEvent).clipboardData;
      const file = data?.files[0];
      if (file) {
        const preview = document.createElement('div');
        preview.dataset.testid = 'file-attachment';
        preview.textContent = file.name;
        form.appendChild(preview);
      }
      const text = data?.getData('text/plain');
      if (text) input.textContent = text;
    });

    const result = deliverHandoff(input, delivery);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe(true);
    expect(form.querySelector('[data-testid="file-attachment"]')?.textContent).toBe(
      delivery.filename,
    );
    expect(input.textContent).toContain(delivery.directive);
  });

  it('retries only the missing directive when the file preview already exists', async () => {
    vi.useFakeTimers();
    const { form, input } = createComposer();
    const delivery = {
      mode: 'attachment' as const,
      directive: 'Continue from the attached transcript.',
      attachment: 'long transcript',
      filename: 'temp-chat-handoff.txt',
    };
    const preview = document.createElement('div');
    preview.dataset.testid = 'file-attachment';
    preview.textContent = delivery.filename;
    form.appendChild(preview);
    let filePasteCount = 0;
    input.addEventListener('paste', (event) => {
      const data = (event as unknown as FakeClipboardEvent).clipboardData;
      if (data?.files.length) filePasteCount += 1;
      const text = data?.getData('text/plain');
      if (text) input.textContent = text;
    });

    const result = deliverHandoff(input, delivery);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe(true);
    expect(filePasteCount).toBe(0);
    expect(input.textContent).toContain(delivery.directive);
  });
});
