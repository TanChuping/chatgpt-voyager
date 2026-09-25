import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STYLE_ID = 'gpt-voyager-chat-width';
const STORAGE_KEY = 'gptChatWidth';

type StorageChangeListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
) => void;

function getInjectedStyle(): HTMLStyleElement {
  const style = document.getElementById(STYLE_ID);
  expect(style).not.toBeNull();
  return style as HTMLStyleElement;
}

const TRANSCRIPT_RULE = /\[class\*="transcriptContent-"\]\s*\{([^}]+)\}/;
const HOST_RULE =
  /^\s*\[class\*="\[--thread-content-max-width:var\(--thread-content-responsive-max-width"\]\s*\{([^}]+)\}/m;

describe('chatWidth', () => {
  let storageChangeListeners: StorageChangeListener[];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    document.head.innerHTML = '';
    document.body.innerHTML = '<main></main>';
    storageChangeListeners = [];

    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_defaults: Record<string, unknown>, callback: (value: Record<string, unknown>) => void) => {
        callback({ [STORAGE_KEY]: 85, gvChatWidthEnabled: true });
      },
    );

    (
      chrome.storage.onChanged.addListener as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((listener: StorageChangeListener) => {
      storageChangeListeners.push(listener);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    const event = new Event('pagehide') as PageTransitionEvent;
    Object.defineProperty(event, 'persisted', { value: false });
    window.dispatchEvent(event);
  });

  it('sizes the transcript and composer hosts relative to the thread pane', async () => {
    const { startChatWidthAdjuster } = await import('../index');
    startChatWidthAdjuster();

    const css = getInjectedStyle().textContent ?? '';
    expect(css.match(TRANSCRIPT_RULE)?.[1]).toContain(
      '--thread-content-responsive-max-width: calc(100cqi * 0.85)',
    );
    expect(css.match(HOST_RULE)?.[1]).toContain(
      '--thread-content-responsive-max-width: calc((100cqi - 0px) * 0.85)',
    );
  });

  it('follows the slider', async () => {
    const { startChatWidthAdjuster } = await import('../index');
    startChatWidthAdjuster();

    const transcript = () => (getInjectedStyle().textContent ?? '').match(TRANSCRIPT_RULE)?.[1];
    storageChangeListeners[0]({ [STORAGE_KEY]: { oldValue: 85, newValue: 69 } }, 'sync');
    expect(transcript()).toContain('calc(100cqi * 0.69)');
    storageChangeListeners[0]({ [STORAGE_KEY]: { oldValue: 69, newValue: 100 } }, 'sync');
    expect(transcript()).toContain('calc(100cqi * 1)');
  });

  it('keeps the 2026-07 rule and drops the pixel caps on message blocks', async () => {
    const { startChatWidthAdjuster } = await import('../index');
    startChatWidthAdjuster();

    const css = getInjectedStyle().textContent ?? '';
    expect(css).toContain('[class*="group/turn-messages"]');
    expect(css).toContain('--thread-content-max-width: 85% !important');
    expect(css).not.toContain('[data-message-author-role');
    expect(css).not.toMatch(/max-width: \d+px/);
  });

  it("aligns the composer with the transcript once the thread scroller's gutter is known", async () => {
    vi.useFakeTimers();
    const { startChatWidthAdjuster } = await import('../index');
    startChatWidthAdjuster();

    const scroller = document.createElement('div');
    scroller.className = 'thread-scroll-container';
    Object.defineProperty(scroller, 'offsetWidth', { value: 1225 });
    Object.defineProperty(scroller, 'clientWidth', { value: 1212 });
    document.querySelector('main')!.appendChild(scroller);
    await vi.advanceTimersByTimeAsync(400);

    expect((getInjectedStyle().textContent ?? '').match(HOST_RULE)?.[1]).toContain(
      'calc((100cqi - 13px) * 0.85)',
    );
  });

  it('removes its style when disabled', async () => {
    const { startChatWidthAdjuster } = await import('../index');
    startChatWidthAdjuster();
    storageChangeListeners[0]({ gvChatWidthEnabled: { oldValue: true, newValue: false } }, 'sync');
    expect(document.getElementById(STYLE_ID)).toBeNull();
  });
});
