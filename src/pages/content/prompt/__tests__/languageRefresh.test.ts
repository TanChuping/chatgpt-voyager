import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import fr from '@/locales/fr/messages.json';
import ru from '@/locales/ru/messages.json';
import { extractMessageDictionary } from '@/utils/localeMessages';

const fixture = vi.hoisted(() => {
  const stores = { sync: {} as Record<string, unknown>, local: {} as Record<string, unknown> };
  const writes: Array<{ area: string; values: Record<string, unknown> }> = [];
  const listeners = new Set<(changes: Record<string, unknown>, area: string) => void>();
  const area = (name: 'sync' | 'local') => ({
    get: vi.fn(async (keys?: unknown, callback?: (value: Record<string, unknown>) => void) => {
      let result: Record<string, unknown> = {};
      if (!keys) result = { ...stores[name] };
      else if (typeof keys === 'string') result = { [keys]: stores[name][keys] };
      else if (Array.isArray(keys)) for (const key of keys) result[key] = stores[name][key];
      else for (const [key, fallback] of Object.entries(keys as Record<string, unknown>)) result[key] = stores[name][key] ?? fallback;
      result = structuredClone(result);
      callback?.(result);
      return result;
    }),
    set: vi.fn(async (values: Record<string, unknown>, callback?: () => void) => {
      const changes: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(values)) changes[key] = { oldValue: stores[name][key], newValue: value };
      Object.assign(stores[name], structuredClone(values));
      writes.push({ area: name, values: structuredClone(values) });
      callback?.();
      for (const listener of listeners) listener(changes, name);
    }),
  });
  const api = {
    storage: {
      sync: area('sync'), local: area('local'),
      onChanged: {
        addListener: vi.fn((listener) => listeners.add(listener)),
        removeListener: vi.fn((listener) => listeners.delete(listener)),
      },
    },
    runtime: {
      id: 'fixture-extension', lastError: null,
      getURL: (file: string) => `chrome-extension://fixture-extension/${file}`,
      getManifest: () => ({ version: '1.9.4' }),
      sendMessage: vi.fn(async () => ({ ok: true })),
    },
    i18n: { getUILanguage: () => 'ru' },
  };
  return { stores, writes, listeners, api };
});

vi.mock('webextension-polyfill', () => ({ default: fixture.api }));
vi.mock('../../favorites/sidebar', () => ({
  mountFavoritesSidebar: () => ({ element: document.createElement('div'), refresh: async () => {}, refreshLabels: vi.fn(), destroy: vi.fn() }),
}));
vi.mock('../../announcement/service', () => ({
  refreshSnapshot: async () => ({ hasUnread: false }),
  getLastSnapshot: () => ({ hasUnread: false }), subscribe: () => () => {},
}));

describe('Prompt Manager mounted labels follow the ready dictionary', () => {
  let handle: { destroy: () => void } | undefined;
  let warning: typeof console.warn;
  const item = { id: 'old-id', name: 'Мой личный заголовок', text: 'User-authored prompt', tags: ['my-tag'], createdAt: 100 };
  const versionLabel = (messages: typeof fr) => `${messages.extensionVersion.message} 1.9.4 — ${messages.announcementVersionChipHint.message}`;

  beforeEach(() => {
    vi.resetModules();
    fixture.listeners.clear();
    fixture.writes.length = 0;
    fixture.stores.sync = { language: 'ru', gvPromptTheme: 'light', gvPromptViewMode: 'compact' };
    fixture.stores.local = { gvPromptItems: [structuredClone(item)], privateData: { unchanged: 'sentinel' } };
    vi.stubGlobal('chrome', fixture.api);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const language = String(input).match(/locales\/(ru|fr)\.json/)?.[1];
      return language
        ? new Response(JSON.stringify(extractMessageDictionary(language === 'ru' ? ru : fr)))
        : new Response('', { status: 404 });
    }));
    document.body.innerHTML = '<main><div id="prompt-textarea" contenteditable="true"></div></main>';
    localStorage.clear();
    warning = console.warn;
  });

  afterEach(() => {
    document.querySelector('.gv-pm-support-wrap')?.dispatchEvent(new Event('gv-pm-close'));
    handle?.destroy();
    handle = undefined;
    console.warn = warning;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mount() {
    handle = await (await import('../index')).startPromptManager();
    const trigger = document.querySelector<HTMLButtonElement>('#gv-pm-trigger')!;
    expect(trigger).not.toBeNull();
    trigger.click();
    return {
      trigger,
      panel: document.querySelector<HTMLElement>('#gv-pm-panel')!,
      version: document.querySelector<HTMLElement>('.gv-pm-version')!,
      language: document.querySelector<HTMLSelectElement>('.gv-pm-lang')!,
    };
  }

  it('asks for the scope before importing or exporting and keeps the settings archive under export', async () => {
    const { panel } = await mount();
    const menu = panel.querySelector<HTMLElement>('.gv-pm-transfer-menu')!;
    const archive = menu.querySelector<HTMLButtonElement>('.gv-pm-backup-btn')!;
    expect(menu.hidden).toBe(true);
    panel.querySelector<HTMLButtonElement>('.gv-pm-import-btn')!.click();
    expect(menu.hidden).toBe(false);
    expect(archive.hidden).toBe(true);
    panel.querySelector<HTMLButtonElement>('.gv-pm-export-btn')!.click();
    expect(archive.hidden).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(menu.hidden).toBe(true);
  });

  async function select(language: HTMLSelectElement, value: 'ru' | 'fr') {
    language.value = value;
    language.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(fixture.stores.sync.language).toBe(value));
    await (await import('@/utils/i18n')).setCachedLanguage(value);
  }

  it('refreshes version title and aria on ru→fr→ru→fr, including closing and reopening the same panel', async () => {
    const { trigger, panel, version, language } = await mount();
    expect(version.title).toBe(versionLabel(ru));
    const before = structuredClone(fixture.stores.local);
    const form = panel.querySelector<HTMLFormElement>('.gv-pm-add-form')!;
    panel.querySelector<HTMLButtonElement>('.gv-pm-edit')!.click();
    const name = form.querySelector<HTMLInputElement>('.gv-pm-input-name')!;
    const text = form.querySelector<HTMLTextAreaElement>('.gv-pm-input-text')!;
    name.value = 'Unsaved user name';
    text.value = 'Unsaved user draft';
    const focused = document.activeElement;

    await select(language, 'fr');

    expect(version.title).toBe(versionLabel(fr));
    expect(version.getAttribute('aria-label')).toBe(versionLabel(fr));
    expect(version.textContent).toBe('1.9.4');
    expect(document.querySelector('.gv-pm-version')).toBe(version);
    expect(document.activeElement).toBe(focused);
    expect(name.value).toBe('Unsaved user name');
    expect(text.value).toBe('Unsaved user draft');
    expect(panel.querySelector('.gv-pm-title')!.textContent).toBe('GPT-Voyager');
    expect(panel.querySelector('.gv-pm-compact-title')!.textContent).toBe(item.name);
    expect(panel.querySelector('.gv-pm-lock')!.getAttribute('aria-label')).toBe(fr.pm_lock.message);
    expect(panel.querySelector<HTMLButtonElement>('.gv-pm-theme-toggle')!.title).toBe(fr.pm_theme_dark.message);
    expect(panel.querySelector<HTMLButtonElement>('.gv-pm-view-mode')!.title).toBe(fr.pm_view_comfortable.message);
    expect(panel.querySelector<HTMLButtonElement>('.gv-pm-backup-btn')!.title).toBe(fr.pm_backup_tooltip.message);
    expect(panel.querySelector<HTMLButtonElement>('.gv-pm-settings')!.title).toBe(fr.pm_settings_tooltip.message);
    expect(panel.querySelector<HTMLButtonElement>('.gv-pm-favorites-btn')!.title).toBe(fr.favoritesSidebarTitle.message);
    expect(panel.querySelector<HTMLButtonElement>('.gv-pm-highlights-btn')!.title).toBe(fr.highlightHistoryTitle.message);
    expect(panel.querySelector<HTMLButtonElement>('.gv-pm-support-btn')!.title).toBe(fr.supportMysteryButton.message);

    trigger.click();
    await vi.waitFor(() => expect(panel.classList.contains('gv-hidden')).toBe(true));
    trigger.click();
    expect(version.title).toBe(versionLabel(fr));
    expect(name.value).toBe('Unsaved user name');
    await select(language, 'ru');
    expect(version.title).toBe(versionLabel(ru));
    trigger.click();
    await select(language, 'fr');
    trigger.click();
    expect(version.title).toBe(versionLabel(fr));
    expect(version.getAttribute('aria-label')).toBe(versionLabel(fr));
    expect(fixture.stores.local).toEqual(before);
    expect(fixture.writes.every((write) => write.area === 'sync' && Object.keys(write.values).join() === 'language')).toBe(true);

    // The existing edit action and storage key still work after relabeling.
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(fixture.writes.some((write) => StorageKeys.PROMPT_ITEMS in write.values)).toBe(true));
    const saved = fixture.stores.local.gvPromptItems as Array<typeof item>;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: item.id, createdAt: item.createdAt, name: 'Unsaved user name', text: 'Unsaved user draft' });
    expect(fixture.stores.local.privateData).toEqual(before.privateData);
  });

  it('refreshes an open delete confirmation without changing its action or stored prompts', async () => {
    const { language, panel } = await mount();
    panel.querySelector<HTMLButtonElement>('.gv-pm-del')!.click();
    const confirm = document.querySelector<HTMLElement>('.gv-pm-confirm')!;
    const buttons = confirm.querySelectorAll<HTMLButtonElement>('button');
    expect(confirm.querySelector('span')!.textContent).toBe(ru.pm_delete_confirm.message);
    await select(language, 'fr');
    expect(document.querySelector('.gv-pm-confirm')).toBe(confirm);
    expect(confirm.querySelector('span')!.textContent).toBe(fr.pm_delete_confirm.message);
    expect(buttons[0].textContent).toBe(fr.pm_delete.message);
    expect(buttons[1].textContent).toBe(fr.pm_cancel.message);
    buttons[1].click();
    expect(document.querySelector('.gv-pm-confirm')).toBeNull();
    expect(fixture.stores.local.gvPromptItems).toEqual([item]);
    expect(fixture.writes.every((write) => Object.keys(write.values).join() === 'language')).toBe(true);
  });

  it('refreshes a duplicate-draft validation message without clearing or saving the draft', async () => {
    const { language, panel } = await mount();
    panel.querySelector<HTMLButtonElement>('.gv-pm-add')!.click();
    const form = panel.querySelector<HTMLFormElement>('.gv-pm-add-form')!;
    const text = form.querySelector<HTMLTextAreaElement>('.gv-pm-input-text')!;
    text.value = item.text;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const hint = form.querySelector<HTMLElement>('.gv-pm-inline-hint')!;
    await vi.waitFor(() => expect(hint.textContent).toBe(ru.pm_duplicate.message));
    await select(language, 'fr');
    expect(hint.textContent).toBe(fr.pm_duplicate.message);
    expect(text.value).toBe(item.text);
    expect(form.classList.contains('gv-hidden')).toBe(false);
    expect(fixture.stores.local.gvPromptItems).toEqual([item]);
    expect(fixture.writes.every((write) => Object.keys(write.values).join() === 'language')).toBe(true);
    handle?.destroy();
    handle = undefined;
    await (await import('@/utils/i18n')).setCachedLanguage('ru');
    expect(hint.textContent).toBe(fr.pm_duplicate.message);
    expect(document.querySelector('#gv-pm-panel')).toBeNull();
  });

  it('uses the translated directory-backup completion with both counts and unchanged payloads', async () => {
    const { language, panel } = await mount();
    await select(language, 'fr');
    const written = new Map<string, string>();
    const directory = {
      getFileHandle: async (name: string) => ({
        createWritable: async () => ({
          write: async (text: string) => { written.set(name, text); }, close: async () => {},
        }),
      }),
    };
    const getDirectoryHandle = vi.fn(async () => directory);
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => ({ getDirectoryHandle })));
    const before = structuredClone(fixture.stores.local);
    panel.querySelector<HTMLButtonElement>('.gv-pm-backup-btn')!.click();
    const notice = panel.querySelector<HTMLElement>('.gv-pm-notice')!;
    await vi.waitFor(() => expect(notice.textContent).toBe(
      fr.pm_backup_complete.message.replace('{promptCount}', '1').replace('{folderCount}', '0'),
    ));
    expect(getDirectoryHandle).toHaveBeenCalledWith(expect.stringMatching(/^backup-\d{8}-\d{6}$/), { create: true });
    expect([...written.keys()].sort()).toEqual(['folders.json', 'metadata.json', 'prompts.json', 'settings.json', 'timeline-hierarchy.json']);
    expect(JSON.parse(written.get('prompts.json')!).items).toEqual([item]);
    expect(JSON.parse(written.get('metadata.json')!)).toMatchObject({ promptCount: 1, folderCount: 0 });
    expect(fixture.stores.local).toEqual(before);
    expect(fixture.writes.every((write) => Object.keys(write.values).join() === 'language')).toBe(true);
  });

  it('uses the translated ZIP-backup completion with the unchanged download filename and counts', async () => {
    const { language, panel } = await mount();
    await select(language, 'fr');
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:fixture-backup');
      static revokeObjectURL = vi.fn();
    });
    const before = structuredClone(fixture.stores.local);
    panel.querySelector<HTMLButtonElement>('.gv-pm-backup-btn')!.click();
    await vi.waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]).toMatch(/^backup-\d{8}-\d{6}\.zip$/);
    expect(panel.querySelector('.gv-pm-notice')!.textContent).toBe(
      fr.pm_backup_download_complete.message
        .replace('{fileName}', downloads[0])
        .replace('{promptCount}', '1')
        .replace('{folderCount}', '0'),
    );
    expect(fixture.stores.local).toEqual(before);
    expect(fixture.writes.every((write) => Object.keys(write.values).join() === 'language')).toBe(true);
  });
});
