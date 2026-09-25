import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STYLE_ID = 'gpt-voyager-edit-input-width';

type StorageChangeListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
) => void;

const css = () => document.getElementById(STYLE_ID)?.textContent ?? '';
const COMPOSER_RULE =
  /\[class\*="\[--thread-content-max-width:var\(--thread-content-responsive-max-width"\]:not\(\[class\*="transcriptContent-"\]\)\s*\{([^}]+)\}/;

describe('composer width (输入框宽度)', () => {
  let listeners: StorageChangeListener[];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    document.head.innerHTML = '';
    document.body.innerHTML = '<main></main>';
    listeners = [];
    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_keys: unknown, callback: (value: Record<string, unknown>) => void) =>
        callback({ gptEditInputWidth: 76, gvEditInputWidthEnabled: true }),
    );
    (
      chrome.storage.onChanged.addListener as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((listener: StorageChangeListener) => listeners.push(listener));
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { stopEditInputWidthAdjuster } = await import('../index');
    stopEditInputWidthAdjuster();
  });

  it('sizes the bottom composer, overriding the chat-width rule for it', async () => {
    const { startEditInputWidthAdjuster } = await import('../index');
    startEditInputWidthAdjuster();
    expect(css().match(COMPOSER_RULE)?.[1]).toContain(
      '--thread-content-responsive-max-width: calc((100cqi - 0px) * 0.76)',
    );
  });

  it('gives the inline message editor the same width, centred on the column', async () => {
    const { startEditInputWidthAdjuster } = await import('../index');
    startEditInputWidthAdjuster();
    expect(css()).toContain('[data-message-author-role="user"] form');
    expect(css()).toContain('min(calc(100cqi * 0.76), calc(100cqi - 32px))');
  });

  it('follows the slider and switches off cleanly', async () => {
    const { startEditInputWidthAdjuster } = await import('../index');
    startEditInputWidthAdjuster();
    listeners[0]({ gptEditInputWidth: { oldValue: 76, newValue: 50 } }, 'sync');
    expect(css().match(COMPOSER_RULE)?.[1]).toContain('* 0.5)');
    listeners[0]({ gvEditInputWidthEnabled: { oldValue: true, newValue: false } }, 'sync');
    expect(document.getElementById(STYLE_ID)).toBeNull();
  });

  it("lines up with the messages once the thread scroller's gutter is known", async () => {
    vi.useFakeTimers();
    const { startEditInputWidthAdjuster } = await import('../index');
    startEditInputWidthAdjuster();

    const scroller = document.createElement('div');
    scroller.className = 'thread-scroll-container';
    Object.defineProperty(scroller, 'offsetWidth', { value: 1225 });
    Object.defineProperty(scroller, 'clientWidth', { value: 1212 });
    document.querySelector('main')!.appendChild(scroller);
    await vi.advanceTimersByTimeAsync(400);

    expect(css().match(COMPOSER_RULE)?.[1]).toContain('calc((100cqi - 13px) * 0.76)');
  });
});
