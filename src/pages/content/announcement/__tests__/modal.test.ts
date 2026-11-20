import { marked } from 'marked';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_LANGUAGES, APP_LANGUAGE_LABELS, type AppLanguage } from '@/utils/language';

import { localizeAnnouncement } from '../localization';
import {
  type ModalHandle,
  openAnnouncementModal,
  refreshOpenAnnouncementModalLanguage,
} from '../modal';
import type { MultilingualAnnouncement } from '../types';

const preference = vi.hoisted(() => ({ language: 'en' as AppLanguage }));
vi.mock('@/utils/i18n', () => ({
  getCachedLanguage: () => preference.language,
  getTranslationSyncUnsafe: (key: string) =>
    (
      ({
        language: 'Language',
        announcementClose: 'Close',
        announcementTranslationFallback: 'This translation is unavailable. Showing {language}.',
      }) as Record<string, string>
    )[key] ?? key,
}));

const source = (): MultilingualAnnouncement => ({
  id: 'same-ID',
  version: '1.8.18',
  publishedAt: '2026-10-03T13:51:43.019Z',
  primaryImageUrl: 'https://example.test/hero.png',
  locales: Object.fromEntries(
    APP_LANGUAGES.map((language) => [
      language,
      {
        title: `Title ${language}`,
        summary: `Summary ${language}`,
        bodyMarkdown: `## Body ${language}\n\n[**Link**](https://example.test/detail)\n\n![Image](https://example.test/body.png)`,
      },
    ]),
  ),
});
let handle: ModalHandle | undefined;
const open = (language: AppLanguage = 'en', announcement = source()) => {
  const onClose = vi.fn();
  handle = openAnnouncementModal({
    announcement: localizeAnnouncement(announcement, language)!,
    closeLabel: 'Close',
    onClose,
  });
  return onClose;
};
const clickLanguage = (language: AppLanguage) => {
  document.querySelector<HTMLButtonElement>(`[data-language="${language}"]`)!.click();
};
const title = () => document.querySelector('.gv-announcement-modal__title')!.textContent;
const markdown = () => document.querySelector('.gv-announcement-modal__markdown')!;

afterEach(() => {
  handle?.destroy();
  handle = undefined;
  document.body.replaceChildren();
  preference.language = 'en';
  vi.restoreAllMocks();
});

describe('announcement DOM fixture — one translation per reading', () => {
  it.each(APP_LANGUAGES)(
    'initial modal follows %s with native names for all seven choices',
    async (language) => {
      open(language);
      expect(title()).toContain(`Title ${language}`);
      expect(document.querySelector('.gv-announcement-modal__summary')!.textContent).toBe(
        `Summary ${language}`,
      );
      expect(document.querySelectorAll('.gv-announcement-modal__language')).toHaveLength(7);
      expect(
        Array.from(document.querySelectorAll('.gv-announcement-modal__language')).map(
          (element) => element.textContent,
        ),
      ).toEqual(APP_LANGUAGES.map((item) => APP_LANGUAGE_LABELS[item]));
      expect(document.querySelectorAll('.gv-announcement-modal__title')).toHaveLength(1);
      expect(document.querySelectorAll('.gv-announcement-modal__summary')).toHaveLength(1);
      expect(document.querySelectorAll('.gv-announcement-modal__markdown')).toHaveLength(1);
      await vi.waitFor(() =>
        expect(markdown().querySelector('h2')?.textContent).toBe(`Body ${language}`),
      );
    },
  );

  it('each direct choice replaces content without storage writes or close callbacks', async () => {
    const onClose = open('en');
    const syncSet = vi.mocked(chrome.storage.sync.set);
    const localSet = vi.mocked(chrome.storage.local.set);
    syncSet.mockClear();
    localSet.mockClear();
    for (const language of APP_LANGUAGES) {
      clickLanguage(language);
      expect(title()).toContain(`Title ${language}`);
      expect(
        document.querySelector('.gv-announcement-modal')!.getAttribute('data-announcement-id'),
      ).toBe('same-ID');
      expect(document.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
      await vi.waitFor(() =>
        expect(markdown().querySelector('h2')?.textContent).toBe(`Body ${language}`),
      );
    }
    expect(onClose).not.toHaveBeenCalled();
    expect(syncSet).not.toHaveBeenCalled();
    expect(localSet).not.toHaveBeenCalled();
  });

  it('reopening resets to the extension preference instead of retaining the last reading choice', () => {
    open('en');
    clickLanguage('ru');
    expect(title()).toContain('Title ru');
    handle!.destroy();
    open('en');
    expect(title()).toContain('Title en');
  });

  it('global preference updates an open reading until the user makes an explicit local choice', () => {
    open('en');
    preference.language = 'fr';
    refreshOpenAnnouncementModalLanguage();
    expect(title()).toContain('Title fr');
    clickLanguage('ja');
    preference.language = 'de';
    refreshOpenAnnouncementModalLanguage();
    expect(title()).toContain('Title ja');
  });

  it('missing translation uses one full fallback and tells the reader which language is shown', () => {
    const announcement = source();
    delete announcement.locales.fr;
    open('fr', announcement);
    expect(title()).toContain('Title en');
    expect(markdown().textContent).toContain('Body en');
    const notice = document.querySelector<HTMLElement>('.gv-announcement-modal__fallback')!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('English');
    expect(document.querySelectorAll('.gv-announcement-modal__markdown')).toHaveLength(1);
  });

  it('preserves Markdown, image and link URLs; nested link labels open the intended URL', async () => {
    open();
    await vi.waitFor(() => expect(markdown().querySelector('a strong')).not.toBeNull());
    expect(document.querySelector<HTMLImageElement>('.gv-announcement-modal__hero')!.src).toBe(
      'https://example.test/hero.png',
    );
    expect(markdown().querySelector('img')!.getAttribute('src')).toBe(
      'https://example.test/body.png',
    );
    const openWindow = vi.spyOn(window, 'open').mockReturnValue(null);
    markdown()
      .querySelector('a strong')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openWindow).toHaveBeenCalledWith(
      'https://example.test/detail',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('sanitizes announcement HTML before replacing the raw text fallback', async () => {
    const announcement = source();
    announcement.locales.en!.bodyMarkdown =
      '# Safe\n\n<script>window.evil = true</script>\n\n<img src="x" onerror="alert(1)">';
    open('en', announcement);
    await vi.waitFor(() => expect(markdown().querySelector('h1')?.textContent).toBe('Safe'));
    expect(markdown().querySelector('script')).toBeNull();
    expect(markdown().querySelector('[onerror]')).toBeNull();
  });

  it('a missing hero image removes only the broken image and keeps readable text', async () => {
    open();
    document.querySelector('.gv-announcement-modal__hero')!.dispatchEvent(new Event('error'));
    expect(document.querySelector('.gv-announcement-modal__hero')).toBeNull();
    expect(title()).toContain('Title en');
  });

  it('Markdown failure leaves the selected language readable as text', async () => {
    vi.spyOn(marked, 'parse').mockRejectedValueOnce(new Error('optional Markdown resource failed'));
    open('es');
    await vi.waitFor(() => expect(marked.parse).toHaveBeenCalled());
    expect(markdown().textContent).toContain('## Body es');
    expect(title()).toContain('Title es');
  });

  it('a slow earlier Markdown render cannot replace a rapid later language choice', async () => {
    let finishEnglish!: (html: string) => void;
    vi.spyOn(marked, 'parse').mockImplementation((input: string) => {
      if (input.includes('Body en'))
        return new Promise<string>((resolve) => {
          finishEnglish = resolve;
        });
      return Promise.resolve('<h2>Body ru</h2>');
    });
    open('en');
    await vi.waitFor(() => expect(finishEnglish).toBeTypeOf('function'));
    clickLanguage('ru');
    await vi.waitFor(() => expect(markdown().querySelector('h2')?.textContent).toBe('Body ru'));
    finishEnglish('<h2>Body en</h2>');
    await Promise.resolve();
    await Promise.resolve();
    expect(title()).toContain('Title ru');
    expect(markdown().textContent).toBe('Body ru');
  });
});
