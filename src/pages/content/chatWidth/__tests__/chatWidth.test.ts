import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STYLE_ID = 'gpt-voyager-chat-width';
const STORAGE_KEY = 'gptChatWidth';
const MOCK_SCREEN_WIDTH = 1920;

type StorageChangeListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
) => void;

function getInjectedStyle(): HTMLStyleElement {
  const style = document.getElementById(STYLE_ID);
  expect(style).not.toBeNull();
  return style as HTMLStyleElement;
}

function percentToPixels(percent: number): number {
  return Math.round((percent / 100) * MOCK_SCREEN_WIDTH);
}

function expectTableRuleWidth(styleText: string, percent: number): void {
  const px = percentToPixels(percent);
  const escapedWidth = px.toString();
  const tableRulePattern = new RegExp(
    String.raw`\/\* Table containers \*\/[\s\S]*table-block,[\s\S]*\.table-block,[\s\S]*\.table-block \.table-content[\s\S]*\{[\s\S]*max-width: ${escapedWidth}px !important;[\s\S]*width: min\(100%, ${escapedWidth}px\) !important;`,
  );
  expect(styleText).toMatch(tableRulePattern);
}

function expectSingleTableScrollbarRules(styleText: string): void {
  expect(styleText).toContain('.table-block.has-scrollbar');
  expect(styleText).toContain('.table-block.new-table-style');
  expect(styleText).toContain('overflow-x: hidden !important;');
  expect(styleText).toContain('.table-block .table-content');
  expect(styleText).toContain('overflow-x: auto !important;');
}

describe('chatWidth', () => {
  let storageChangeListeners: StorageChangeListener[];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    document.head.innerHTML = '';
    document.body.innerHTML = '<main></main>';

    // Mock screen dimensions for deterministic tests
    Object.defineProperty(window, 'screen', {
      value: { availWidth: MOCK_SCREEN_WIDTH, width: MOCK_SCREEN_WIDTH },
      writable: true,
      configurable: true,
    });

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
    const event = new Event('pagehide') as PageTransitionEvent;
    Object.defineProperty(event, 'persisted', { value: false });
    window.dispatchEvent(event);
  });

  it('applies widescreen rules to Gemini table blocks', async () => {
    const { startChatWidthAdjuster } = await import('../index');
    startChatWidthAdjuster();

    const styleText = getInjectedStyle().textContent ?? '';

    expectTableRuleWidth(styleText, 85);
    expect(styleText).toContain('table-block .table-block');
    expect(styleText).toContain('.table-block.has-scrollbar');
    expect(styleText).toContain('.table-block.new-table-style');
    expect(styleText).toContain('.table-block .table-content');
    expect(styleText).toContain('.table-block-component');
    expect(styleText).toContain('.horizontal-scroll-wrapper');
    expectSingleTableScrollbarRules(styleText);
  });

  it('updates table widescreen rules when width setting changes', async () => {
    const { startChatWidthAdjuster } = await import('../index');
    startChatWidthAdjuster();

    expect(storageChangeListeners.length).toBeGreaterThan(0);

    storageChangeListeners[0]({ [STORAGE_KEY]: { oldValue: 85, newValue: 92 } }, 'sync');

    const styleText = getInjectedStyle().textContent ?? '';
    expectTableRuleWidth(styleText, 92);
    expect(styleText).toContain('table-block .table-content');
    expectSingleTableScrollbarRules(styleText);
  });

  it('uses the available ChatGPT pane for the slider instead of a screen-sized cap', async () => {
    const { startChatWidthAdjuster } = await import('../index');
    startChatWidthAdjuster();

    const nativeRule = () =>
      (getInjectedStyle().textContent ?? '').match(
        /\[class\*="group\/turn-messages"\][\s\S]*?\{([^}]+)\}/,
      )?.[1];
    expect(nativeRule()).toContain('--thread-content-max-width: 85% !important');
    storageChangeListeners[0]({ [STORAGE_KEY]: { oldValue: 85, newValue: 69 } }, 'sync');
    expect(nativeRule()).toContain('--thread-content-max-width: 69% !important');
    storageChangeListeners[0]({ [STORAGE_KEY]: { oldValue: 69, newValue: 100 } }, 'sync');
    expect(nativeRule()).toContain('--thread-content-max-width: 100% !important');
  });

  it('retains legacy inner caps inside the percentage-based native host', async () => {
    // Legacy inner elements fill their parent, while the native ChatGPT host
    // remains 70% of the available pane even in split-screen windows.
    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_defaults: Record<string, unknown>, callback: (value: Record<string, unknown>) => void) => {
        callback({ [STORAGE_KEY]: 70, gvChatWidthEnabled: true });
      },
    );

    const { startChatWidthAdjuster } = await import('../index');
    startChatWidthAdjuster();

    const styleText = getInjectedStyle().textContent ?? '';
    expect(styleText).toContain('--thread-content-max-width: 70% !important');
    const expectedPx = percentToPixels(70);
    expect(styleText).toContain(`max-width: ${expectedPx}px !important`);
    expect(styleText).toContain(`width: min(100%, ${expectedPx}px) !important`);
  });
});
