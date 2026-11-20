import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_LANGUAGES, type AppLanguage } from '@/utils/language';

import { localizeAnnouncement } from '../localization';
import { type ModalHandle, openAnnouncementModal } from '../modal';
import multilingual from './fixtures/current-v2.json';

const preference = vi.hoisted(() => ({
  language: 'en' as AppLanguage,
  dictionary: {} as Record<string, { message: string }>,
}));
vi.mock('@/utils/i18n', () => ({
  getCachedLanguage: () => preference.language,
  getTranslationSyncUnsafe: (key: string) => preference.dictionary[key]?.message ?? key,
}));

const source = multilingual.current;
const css = readFileSync(path.resolve('public/contentStyle.css'), 'utf8');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let handle: ModalHandle | undefined;
let media: MediaQueryList;
const card = () => document.querySelector<HTMLElement>('.gv-announcement-modal')!;
const backdrop = () => document.querySelector<HTMLElement>('.gv-announcement-modal__backdrop')!;

function open(language: AppLanguage = 'en') {
  preference.language = language;
  preference.dictionary = JSON.parse(
    readFileSync(path.resolve(`src/locales/${language}/messages.json`), 'utf8'),
  );
  const onClose = vi.fn();
  handle = openAnnouncementModal({
    announcement: localizeAnnouncement(source, language)!,
    closeLabel: preference.dictionary.announcementClose.message,
    onClose,
  });
  return onClose;
}

function panel(theme: 'light' | 'dark') {
  const element = document.createElement('div');
  element.id = 'gv-pm-panel';
  element.dataset.gvTheme = theme;
  document.body.append(element);
  return element;
}

beforeEach(() => {
  media = {
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList;
  vi.spyOn(window, 'matchMedia').mockReturnValue(media);
});

afterEach(() => {
  handle?.destroy();
  handle = undefined;
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.className = '';
  document.body.removeAttribute('data-theme');
  document.body.className = '';
  vi.restoreAllMocks();
});

describe('announcement visual integration and unchanged reader behavior', () => {
  it.each(['light', 'dark'] as const)(
    'uses the actual %s prompt panel theme ahead of page and OS preferences',
    (theme) => {
      panel(theme);
      document.documentElement.dataset.theme = theme === 'light' ? 'dark' : 'light';
      Object.defineProperty(media, 'matches', { value: theme === 'light' });
      open();
      expect(card().dataset.gvTheme).toBe(theme);
      expect(backdrop().dataset.gvTheme).toBe(theme);
    },
  );

  it('uses the same page markers as the panel, then the OS when no marker exists', () => {
    document.documentElement.dataset.theme = 'dark';
    open();
    expect(card().dataset.gvTheme).toBe('dark');
    document.documentElement.dataset.theme = 'light';
    open();
    expect(card().dataset.gvTheme).toBe('light');
    document.documentElement.removeAttribute('data-theme');
    Object.defineProperty(media, 'matches', { value: true });
    open();
    expect(card().dataset.gvTheme).toBe('dark');
  });

  it('updates theme in place without replacing the reader, focus, or scroll and cleans up', async () => {
    const themeSource = panel('light');
    open('ru');
    const reader = card();
    const body = reader.querySelector<HTMLElement>('.gv-announcement-modal__body')!;
    const close = reader.querySelector<HTMLButtonElement>('.gv-announcement-modal__close')!;
    body.scrollTop = 120;
    themeSource.dataset.gvTheme = 'dark';
    await vi.waitFor(() => expect(reader.dataset.gvTheme).toBe('dark'));
    expect(card()).toBe(reader);
    expect(body.scrollTop).toBe(120);
    expect(document.activeElement).toBe(close);
    handle!.destroy();
    themeSource.dataset.gvTheme = 'light';
    await Promise.resolve();
    expect(reader.dataset.gvTheme).toBe('dark');
    expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('keeps initial focus, Tab wrapping, Escape and focus restoration', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const onClose = open('de');
    const close = card().querySelector<HTMLButtonElement>('.gv-announcement-modal__close')!;
    expect(document.activeElement).toBe(close);
    const buttons = card().querySelectorAll<HTMLButtonElement>('button');
    const last = buttons[buttons.length - 1];
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(last);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
    expect(document.activeElement).toBe(close);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each(['hidden-panel', 'removed-opener', 'body'] as const)(
    'returns Escape focus to the visible floating entry when the opener is %s',
    (state) => {
      const trigger = document.createElement('button');
      trigger.id = 'gv-pm-trigger';
      const host = panel('light');
      const opener = document.createElement('span');
      opener.tabIndex = 0;
      host.append(opener);
      document.body.append(trigger);
      if (state !== 'body') opener.focus();
      open('fr');
      if (state === 'hidden-panel') host.style.display = 'none';
      if (state === 'removed-opener') opener.remove();
      const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      document.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(trigger);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    },
  );

  it.each(['close-button', 'backdrop', 'escape'] as const)(
    'keeps focus on the floating entry after the prompt exit transition: %s',
    async (method) => {
      const trigger = document.createElement('button');
      trigger.id = 'gv-pm-trigger';
      trigger.setAttribute('aria-expanded', 'true');
      const host = panel('light');
      const opener = document.createElement('span');
      opener.tabIndex = 0;
      host.append(opener);
      document.body.append(trigger);
      opener.focus();
      open('fr');
      const startExit = () => {
        trigger.setAttribute('aria-expanded', 'false');
        host.classList.add('gv-pm-closing');
      };
      // The real pointer capture listener closes the panel before the click;
      // the real Escape window listener runs after the modal document listener.
      if (method === 'escape') {
        window.addEventListener('keydown', startExit, { once: true });
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } else {
        startExit();
        if (method === 'close-button')
          card().querySelector<HTMLButtonElement>('.gv-announcement-modal__close')!.click();
        else backdrop().click();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.activeElement).toBe(trigger);
      host.style.display = 'none';
      host.classList.remove('gv-pm-closing');
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(document.activeElement).toBe(trigger);
    },
  );

  it('keeps backdrop and close-button dismissal while card clicks remain open', () => {
    let onClose = open();
    card().click();
    expect(onClose).not.toHaveBeenCalled();
    backdrop().click();
    expect(onClose).toHaveBeenCalledOnce();
    onClose = open();
    card().querySelector<HTMLButtonElement>('.gv-announcement-modal__close')!.click();
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('moves decoration to scoped CSS and keeps one complete translation and zero storage writes', async () => {
    const syncSet = vi.mocked(chrome.storage.sync.set);
    const localSet = vi.mocked(chrome.storage.local.set);
    syncSet.mockClear();
    localSet.mockClear();
    open('fr');
    const body = card().querySelector<HTMLElement>('.gv-announcement-modal__body')!;
    body.scrollTop = 95;
    for (const language of APP_LANGUAGES) {
      card()
        .querySelector<HTMLButtonElement>(
          `.gv-announcement-modal__language[data-language="${language}"]`,
        )!
        .click();
      expect(card().querySelector('.gv-announcement-modal__title')!.textContent).toBe(
        source.locales[language]!.title,
      );
      expect(card().querySelectorAll('.gv-announcement-modal__summary')).toHaveLength(1);
      expect(card().querySelectorAll('.gv-announcement-modal__markdown')).toHaveLength(1);
      expect(card().querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
      expect(card().querySelector('[style]')).toBeNull();
    }
    expect(body.scrollTop).toBe(95);
    expect(syncSet).not.toHaveBeenCalled();
    expect(localSet).not.toHaveBeenCalled();
    expect(card().querySelector('.gv-announcement-modal__version')!.textContent).toBe(
      `v${source.version}`,
    );
    expect(card().querySelector('time')!.dateTime).toBe(source.publishedAt);
  });

  it.each(
    (['light', 'dark'] as const).flatMap((theme) =>
      (['ru', 'de', 'fr'] as const).map((language) => ({ theme, language })),
    ),
  )(
    'serializes production modal/CSS with actual long $language copy in $theme mode',
    async ({ theme, language }) => {
      panel(theme);
      open(language);
      const markdown = card().querySelector('.gv-announcement-modal__markdown')!;
      await vi.waitFor(() => expect(markdown.querySelector('p, ul, h1, h2, h3')).not.toBeNull());
      expect(card().lang).toBe(language);
      expect(card().querySelector('.gv-announcement-modal__title')!.textContent).toBe(
        source.locales[language]!.title,
      );
      expect(card().querySelector('.gv-announcement-modal__summary')!.textContent).toBe(
        source.locales[language]!.summary,
      );
      expect(markdown.textContent!.length).toBeGreaterThan(1000);
      const directory = process.env.VOYAGER_ANNOUNCEMENT_VISUAL_DIR;
      if (!directory) return;
      mkdirSync(directory, { recursive: true });
      const filename = `announcement-${theme}-${language}.html`;
      const metadata = {
        type: 'static DOM/CSS fixture; controls are not wired after serialization',
        generatedAt: new Date().toISOString(),
        language,
        theme,
        announcementId: source.id,
        css: {
          source: 'extension/public/contentStyle.css',
          sha256: hash(css),
          bytes: Buffer.byteLength(css),
        },
        renderer: {
          source: 'extension/src/pages/content/announcement/modal.ts',
          sha256: hash(
            readFileSync(path.resolve('src/pages/content/announcement/modal.ts'), 'utf8'),
          ),
        },
        bodyTextCharacters: markdown.textContent!.length,
        htmlFile: filename,
      };
      const html = `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Announcement visual fixture — ${theme} / ${language}</title>
<style>${css}</style>
<style>body{margin:0;background:${theme === 'dark' ? '#1c1c1c' : '#f4f4f5'};min-height:100vh}.fixture-label{position:fixed;z-index:2147483647;inset:10px 12px auto;text-align:center;color:${theme === 'dark' ? '#ececec' : '#18181b'};font:11px/1.4 system-ui,sans-serif;pointer-events:none}</style>
</head><body><aside class="fixture-label">STATIC FIXTURE · production modal DOM / CSS · ${theme} / ${language} · scrollable; buttons not wired</aside>
${backdrop().outerHTML}
<script type="application/json" id="fixture-metadata">${JSON.stringify(metadata, null, 2)}</script>
</body></html>`;
      writeFileSync(path.join(directory, filename), html);
      writeFileSync(
        path.join(directory, filename.replace('.html', '.json')),
        `${JSON.stringify(metadata, null, 2)}\n`,
      );
    },
  );
});
