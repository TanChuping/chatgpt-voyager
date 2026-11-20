import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enMessages from '@/locales/en/messages.json';
import { installEnglishLocale } from '@/tests/localeFixture';
import { initI18n } from '@/utils/i18n';

import { startExportButton, stopExportButton } from '../index';

// The app bootstrap normally loads the selected dictionary. This component
// fixture supplies that ready state while retaining the real sync translator.
vi.mock('@/utils/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/i18n')>();
  return {
    ...actual,
    initI18n: vi.fn(async () => undefined),
    getCurrentLanguage: vi.fn(async () => 'en' as const),
  };
});

beforeEach(() => {
  vi.useFakeTimers();
  installEnglishLocale();
  document.body.innerHTML = `
    <button data-testid="conversation-options-button" aria-haspopup="menu"
      aria-expanded="true" aria-controls="fixture-conversation-menu">Options</button>
    <div id="fixture-conversation-menu" role="menu" data-state="open">
      <button role="menuitem"><span><svg></svg></span><span>Archive</span></button>
    </div>`;
});

afterEach(() => {
  stopExportButton();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('conversation menu i18n', () => {
  it('uses exportChatJson text for conversation menu item label', async () => {
    await startExportButton();
    await vi.advanceTimersByTimeAsync(40);

    const button = document.querySelector<HTMLElement>('.gv-export-conversation-menu-btn');
    expect(initI18n).toHaveBeenCalled();
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain(enMessages.exportChatJson.message);
    expect(button?.getAttribute('aria-label')).toBe(enMessages.exportChatJson.message);
    expect(button?.title).toBe(enMessages.exportChatJson.message);
  });
});
