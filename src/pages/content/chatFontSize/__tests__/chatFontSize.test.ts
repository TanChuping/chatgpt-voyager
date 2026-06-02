import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STYLE_ID = 'gpt-voyager-chat-font-size';
const CODE_STYLE_ID = 'gpt-voyager-code-font-size';
const VALUE_KEY = 'gvChatFontSize';
const ENABLED_KEY = 'gvChatFontSizeEnabled';
const CODE_VALUE_KEY = 'gvCodeFontSize';
const CODE_ENABLED_KEY = 'gvCodeFontSizeEnabled';

type StorageChangeListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
) => void;

function getInjectedStyle(): HTMLStyleElement | null {
  return document.getElementById(STYLE_ID) as HTMLStyleElement | null;
}

function getInjectedCodeStyle(): HTMLStyleElement | null {
  return document.getElementById(CODE_STYLE_ID) as HTMLStyleElement | null;
}

describe('chatFontSize', () => {
  let storageChangeListeners: StorageChangeListener[];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    document.head.innerHTML = '';
    document.body.innerHTML = '<main></main>';

    storageChangeListeners = [];

    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_keys: unknown, callback: (value: Record<string, unknown>) => void) => {
        callback({
          [VALUE_KEY]: 120,
          [ENABLED_KEY]: true,
          [CODE_VALUE_KEY]: 110,
          [CODE_ENABLED_KEY]: false,
        });
      },
    );

    (
      chrome.storage.onChanged.addListener as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation((listener: StorageChangeListener) => {
      storageChangeListeners.push(listener);
    });
  });

  afterEach(() => {
    window.dispatchEvent(new Event('beforeunload'));
  });

  it('applies font-size styles when enabled', async () => {
    const { startChatFontSizeAdjuster } = await import('../index');
    startChatFontSizeAdjuster();

    const style = getInjectedStyle();
    expect(style).not.toBeNull();
    const text = style!.textContent ?? '';
    expect(text).toContain('font-size: 120% !important');
    expect(text).not.toContain('pre.cm-content');
    expect(text).not.toContain('.formatted-code-block-internal-container code');
  });

  it('does not inject styles when disabled', async () => {
    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_keys: unknown, callback: (value: Record<string, unknown>) => void) => {
        callback({ [VALUE_KEY]: 120, [ENABLED_KEY]: false, [CODE_ENABLED_KEY]: false });
      },
    );

    const { startChatFontSizeAdjuster } = await import('../index');
    startChatFontSizeAdjuster();

    const style = getInjectedStyle();
    expect(style).toBeNull();
  });

  it('updates font size when storage value changes', async () => {
    const { startChatFontSizeAdjuster } = await import('../index');
    startChatFontSizeAdjuster();

    expect(storageChangeListeners.length).toBeGreaterThan(0);

    storageChangeListeners[0]({ [VALUE_KEY]: { oldValue: 120, newValue: 140 } }, 'sync');

    const style = getInjectedStyle();
    expect(style).not.toBeNull();
    const text = style!.textContent ?? '';
    expect(text).toContain('font-size: 140% !important');
  });

  it('removes styles when toggled off via storage change', async () => {
    const { startChatFontSizeAdjuster } = await import('../index');
    startChatFontSizeAdjuster();

    expect(getInjectedStyle()).not.toBeNull();

    storageChangeListeners[0]({ [ENABLED_KEY]: { oldValue: true, newValue: false } }, 'sync');

    expect(getInjectedStyle()).toBeNull();
  });

  it('applies code block font-size independently when enabled', async () => {
    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_keys: unknown, callback: (value: Record<string, unknown>) => void) => {
        callback({
          [VALUE_KEY]: 120,
          [ENABLED_KEY]: true,
          [CODE_VALUE_KEY]: 115,
          [CODE_ENABLED_KEY]: true,
        });
      },
    );

    const { startChatFontSizeAdjuster } = await import('../index');
    startChatFontSizeAdjuster();

    const style = getInjectedCodeStyle();
    expect(style).not.toBeNull();
    const text = style!.textContent ?? '';
    expect(text).toContain('pre.cm-content');
    expect(text).toContain('.cm-content code');
    expect(text).toContain('font-size: 115% !important');
  });

  it('updates and removes code block font-size from storage changes', async () => {
    const { startChatFontSizeAdjuster } = await import('../index');
    startChatFontSizeAdjuster();

    expect(getInjectedCodeStyle()).toBeNull();

    storageChangeListeners[0]({ [CODE_ENABLED_KEY]: { oldValue: false, newValue: true } }, 'sync');
    storageChangeListeners[0]({ [CODE_VALUE_KEY]: { oldValue: 110, newValue: 130 } }, 'sync');

    expect(getInjectedCodeStyle()?.textContent ?? '').toContain('font-size: 130% !important');

    storageChangeListeners[0]({ [CODE_ENABLED_KEY]: { oldValue: true, newValue: false } }, 'sync');

    expect(getInjectedCodeStyle()).toBeNull();
  });

  it('clamps values to min/max range', async () => {
    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_keys: unknown, callback: (value: Record<string, unknown>) => void) => {
        callback({ [VALUE_KEY]: 200, [ENABLED_KEY]: true });
      },
    );

    const { startChatFontSizeAdjuster } = await import('../index');
    startChatFontSizeAdjuster();

    const style = getInjectedStyle();
    expect(style).not.toBeNull();
    const text = style!.textContent ?? '';
    // 200 should be clamped to max 150
    expect(text).toContain('font-size: 150% !important');
  });

  it('targets inner text elements for user and model responses', async () => {
    const { startChatFontSizeAdjuster } = await import('../index');
    startChatFontSizeAdjuster();

    const text = getInjectedStyle()!.textContent ?? '';
    // User message inner selectors
    expect(text).toContain('.query-text');
    expect(text).toContain('.query-text-line');
    expect(text).toContain('.gds-body-l');
    // Model response inner selectors
    expect(text).toContain('message-content');
    expect(text).toContain('model-response .markdown');
    expect(text).toContain('.markdown-main-panel');
    // Block elements
    expect(text).toContain('model-response p');
    expect(text).toContain('message-content li');
    expect(text).not.toContain('pre code');
  });
});
