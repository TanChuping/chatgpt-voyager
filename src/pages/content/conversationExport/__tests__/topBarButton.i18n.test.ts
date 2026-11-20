import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { exportPreparedConversation } from '@/features/singleConvExport';
import enMessages from '@/locales/en/messages.json';
import frMessages from '@/locales/fr/messages.json';
import { installEnglishLocale } from '@/tests/localeFixture';
import { extractMessageDictionary } from '@/utils/localeMessages';
import { installTranslations } from '@/utils/translations';

import { prepareWholeConversationExport } from '../prepareExport';
import { enterSelectionMode } from '../selectionMode';
import { startTopBarExportButton, stopTopBarExportButton } from '../topBarButton';

vi.mock('@/features/singleConvExport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/singleConvExport')>()),
  exportPreparedConversation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../prepareExport', () => ({ prepareWholeConversationExport: vi.fn() }));
vi.mock('../selectionMode', () => ({ enterSelectionMode: vi.fn(), exitSelectionMode: vi.fn() }));

const CONV_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function frenchReady(): void {
  installTranslations(extractMessageDictionary(frMessages));
  window.dispatchEvent(new CustomEvent('voyager:language-changed', { detail: { language: 'fr' } }));
}

describe('mounted export entry language changes', () => {
  beforeEach(() => {
    installEnglishLocale();
    vi.clearAllMocks();
    window.history.pushState({}, '', `/c/${CONV_ID}`);
    document.body.innerHTML = `<header id="page-header">
      <div id="conversation-header-actions"><div class="flex items-center">
        <button data-testid="conversation-options-button"><svg></svg><span>Options</span></button>
      </div></div></header>`;
  });

  afterEach(() => {
    stopTopBarExportButton();
    document.body.innerHTML = '';
    window.history.pushState({}, '', '/');
    vi.restoreAllMocks();
  });

  it('refreshes an open menu in place while keeping focus, icons and actions', () => {
    startTopBarExportButton();
    const button = document.querySelector<HTMLButtonElement>('[data-gv-export-btn]')!;
    expect(button.textContent).toBe(enMessages.singleConvExportButton.message);
    button.click();
    const menu = document.querySelector<HTMLElement>('.gv-export-menu')!;
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const icons = items.map((item) => item.querySelector('svg'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);

    frenchReady();

    expect(document.querySelector('[data-gv-export-btn]')).toBe(button);
    expect(document.querySelector('.gv-export-menu')).toBe(menu);
    expect(button.textContent).toBe(frMessages.singleConvExportButton.message);
    expect(button.getAttribute('aria-label')).toBe(frMessages.singleConvExportButton.message);
    expect(button.title).toBe(frMessages.singleConvExportButtonTooltip.message);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(menu.getAttribute('aria-label')).toBe(frMessages.singleConvExportButton.message);
    expect(items.map((item) => item.textContent)).toEqual([
      frMessages.singleConvExportMenuWhole.message,
      frMessages.singleConvExportSelectButton.message,
    ]);
    expect(items.map((item) => item.querySelector('svg'))).toEqual(icons);
    expect(document.activeElement).toBe(items[1]);
    expect(items[1].tabIndex).toBe(0);
    items[1].click();
    expect(enterSelectionMode).toHaveBeenCalledExactlyOnceWith(CONV_ID);
    expect(document.querySelector('.gv-export-menu')).toBeNull();
  });

  it('refreshes disabled menu explanations without enabling export during generation', () => {
    document.body.insertAdjacentHTML('beforeend', '<button data-testid="stop-button">Stop</button>');
    startTopBarExportButton();
    document.querySelector<HTMLButtonElement>('[data-gv-export-btn]')!.click();
    const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.gv-export-menu__item'));
    expect(items.every((item) => item.disabled)).toBe(true);

    frenchReady();

    for (const item of items) {
      expect(item.disabled).toBe(true);
      expect(item.getAttribute('aria-disabled')).toBe('true');
      expect(item.title).toBe(frMessages.singleConvExportGenerating.message);
    }
  });

  it('keeps a pending preparation and its progress count while relabeling the busy button', async () => {
    let finish!: (value: Awaited<ReturnType<typeof prepareWholeConversationExport>>) => void;
    vi.mocked(prepareWholeConversationExport).mockImplementation((_id, options) => {
      options?.onStage?.('rebuilding', 23);
      return new Promise((resolve) => { finish = resolve; });
    });
    startTopBarExportButton();
    const button = document.querySelector<HTMLButtonElement>('[data-gv-export-btn]')!;
    button.click();
    document.querySelector<HTMLButtonElement>('.gv-export-menu__item')!.click();
    await vi.waitFor(() => expect(prepareWholeConversationExport).toHaveBeenCalledTimes(1));
    expect(button.title).toBe(enMessages.exportLoadingHistory.message.replace('{count}', '23'));

    frenchReady();

    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.title).toBe(frMessages.exportLoadingHistory.message.replace('{count}', '23'));
    expect(prepareWholeConversationExport).toHaveBeenCalledTimes(1);
    finish({} as Awaited<ReturnType<typeof prepareWholeConversationExport>>);
    await vi.waitFor(() => expect(button.hasAttribute('aria-busy')).toBe(false));
    expect(exportPreparedConversation).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(false);
    expect(button.title).toBe(frMessages.singleConvExportButtonTooltip.message);
  });

  it('registers once and removes the language listener when stopped', () => {
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    startTopBarExportButton();
    startTopBarExportButton();
    const languageCalls = added.mock.calls.filter(([event]) => event === 'voyager:language-changed');
    expect(languageCalls).toHaveLength(1);
    const button = document.querySelector<HTMLButtonElement>('[data-gv-export-btn]')!;
    stopTopBarExportButton();
    expect(removed).toHaveBeenCalledWith('voyager:language-changed', languageCalls[0][1]);
    frenchReady();
    expect(button.textContent).toBe(enMessages.singleConvExportButton.message);
    expect(document.querySelector('[data-gv-export-btn]')).toBeNull();
  });
});
