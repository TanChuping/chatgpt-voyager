import React, { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LanguageProvider } from '@/contexts/LanguageContext';
import { StorageKeys } from '@/core/types/common';
import { setCachedLanguage } from '@/utils/i18n';
import { APP_LANGUAGES, type AppLanguage } from '@/utils/language';

import Popup from '../Popup';

const transport = vi.hoisted(() => ({
  sync: {} as Record<string, unknown>,
  local: {} as Record<string, unknown>,
  held: new Set<string>(),
  writes: [] as Array<{
    area: 'sync' | 'local';
    values: Record<string, unknown>;
    accept: () => void;
    reject: () => void;
    settled: boolean;
  }>,
  listeners: new Set<(changes: Record<string, unknown>, area: string) => void>(),
  permission: true,
}));

vi.mock('webextension-polyfill', () => {
  const area = (name: 'sync' | 'local') => ({
    async get(keys: string | string[] | Record<string, unknown>) {
      const defaults = typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
      const list =
        typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(list.map((key) => [key, transport[name][key] ?? defaults[key]]));
    },
    set(values: Record<string, unknown>) {
      return new Promise<void>((resolve, reject) => {
        const entry = {
          area: name,
          values: structuredClone(values),
          settled: false,
          accept() {
            entry.settled = true;
            const changes = Object.fromEntries(
              Object.entries(values).map(([key, value]) => [
                key,
                {
                  oldValue: transport[name][key],
                  newValue: value,
                },
              ]),
            );
            Object.assign(transport[name], values);
            transport.listeners.forEach((listener) => listener(changes, name));
            resolve();
          },
          reject() {
            entry.settled = true;
            reject(new Error('Synthetic storage rejection'));
          },
        };
        transport.writes.push(entry);
        if (!Object.keys(values).some((key) => transport.held.has(key))) entry.accept();
      });
    },
    async remove(key: string) {
      delete transport[name][key];
    },
  });
  return {
    default: {
      storage: {
        sync: area('sync'),
        local: area('local'),
        onChanged: {
          addListener: (listener: (changes: Record<string, unknown>, area: string) => void) =>
            transport.listeners.add(listener),
          removeListener: (listener: (changes: Record<string, unknown>, area: string) => void) =>
            transport.listeners.delete(listener),
        },
      },
      runtime: { getURL: (resource: string) => `https://extension.test/${resource}` },
      i18n: { getUILanguage: () => 'en' },
      permissions: { request: async () => transport.permission, remove: async () => true },
    },
  };
});

let root: Root | undefined;
let container: HTMLDivElement;
const dictionary = (language: AppLanguage) =>
  JSON.parse(readFileSync(path.resolve(`src/locales/${language}/messages.json`), 'utf8'));
const message = (
  language: AppLanguage,
  key: string,
  values: Record<string, string | number> = {},
) =>
  dictionary(language)[key].message.replace(/\{(\w+)\}/g, (placeholder: string, name: string) =>
    values[name] === undefined ? placeholder : String(values[name]),
  );
const input = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!;
const click = async (id: string) => {
  await act(async () => {
    input(id).click();
  });
};
const settle = async (index: number, success: boolean) => {
  await act(async () => {
    const item = transport.writes[index];
    expect(item.settled).toBe(false);
    if (success) item.accept();
    else item.reject();
    await Promise.resolve();
  });
};
async function mount(language: AppLanguage = 'en') {
  await setCachedLanguage(language);
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Popup />
      </LanguageProvider>,
    );
  });
  await vi.waitFor(() => expect(input('drive-auto-allow')).toBeTruthy());
}
async function unmount() {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  container?.remove();
}
async function fillWebsite(value: string) {
  const field = container.querySelector<HTMLInputElement>('input[placeholder="example.com"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    field.nextElementSibling!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}
async function pickFont(file: File) {
  const field = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => {
    Object.defineProperty(field, 'files', { configurable: true, value: [file] });
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  transport.sync = {
    language: 'en',
    [StorageKeys.DRIVE_AUTO_ALLOW_ENABLED]: false,
    [StorageKeys.SINGLE_CONV_EXPORT_FORMAT]: 'markdown',
    [StorageKeys.PROMPT_CUSTOM_WEBSITES]: ['existing.example'],
    [StorageKeys.CHAT_FONT_FAMILY_ENABLED]: true,
    privateFutureSetting: { keep: ['untouched', 7] },
  };
  transport.local = { gvAnnouncementCache: { v: 1, current: null }, privateAccount: ['raw', 42] };
  transport.writes = [];
  transport.held.clear();
  transport.permission = true;
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const language = /locales\/(\w+)\.json$/.exec(String(url))?.[1] as AppLanguage;
      if (!language) throw new Error(`Unexpected fixture request: ${url}`);
      return {
        ok: true,
        json: async () =>
          Object.fromEntries(
            Object.entries(dictionary(language)).map(([key, value]) => [
              key,
              (value as { message: string }).message,
            ]),
          ),
      };
    }),
  );
});

afterEach(async () => {
  await unmount();
  // A test must settle its own actual adapter operations; no ignored promises.
  expect(transport.writes.every((entry) => entry.settled)).toBe(true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('real Popup events -> real setting queue -> synthetic storage transport', () => {
  it('rolls the first rejected Drive toggle back without changing any persisted value', async () => {
    await mount();
    const before = structuredClone({ sync: transport.sync, local: transport.local });
    transport.held.add(StorageKeys.DRIVE_AUTO_ALLOW_ENABLED);
    await click('drive-auto-allow');
    expect(input('drive-auto-allow').checked).toBe(true);
    expect(transport.writes[0].values).toEqual({ [StorageKeys.DRIVE_AUTO_ALLOW_ENABLED]: true });
    await settle(0, false);
    expect(input('drive-auto-allow').checked).toBe(false);
    expect({ sync: transport.sync, local: transport.local }).toEqual(before);
    expect(window.alert).toHaveBeenCalledWith(message('en', 'settingsSaveFailed'));
    await unmount();
    await mount();
    expect(input('drive-auto-allow').checked).toBe(false);
  });

  it('serializes rapid radio choices and restores the last successful value when the final write fails', async () => {
    await mount();
    transport.held.add(StorageKeys.SINGLE_CONV_EXPORT_FORMAT);
    await click('single-conv-export-json');
    await click('single-conv-export-html');
    expect(input('single-conv-export-html').checked).toBe(true);
    expect(transport.writes).toHaveLength(1);
    await settle(0, true);
    expect(input('single-conv-export-html').checked).toBe(true);
    expect(transport.writes[1].values).toEqual({ [StorageKeys.SINGLE_CONV_EXPORT_FORMAT]: 'html' });
    await settle(1, false);
    expect(input('single-conv-export-json').checked).toBe(true);
    expect(transport.sync[StorageKeys.SINGLE_CONV_EXPORT_FORMAT]).toBe('json');
    expect(window.alert).toHaveBeenCalledTimes(1);
    await unmount();
    await mount();
    expect(input('single-conv-export-json').checked).toBe(true);
  });

  it('an earlier failed selection neither rolls back nor reports over a later successful intent', async () => {
    await mount();
    transport.held.add(StorageKeys.SINGLE_CONV_EXPORT_FORMAT);
    await click('single-conv-export-json');
    await click('single-conv-export-html');
    await settle(0, false);
    expect(input('single-conv-export-html').checked).toBe(true);
    expect(window.alert).not.toHaveBeenCalled();
    await settle(1, true);
    expect(input('single-conv-export-html').checked).toBe(true);
    expect(transport.sync[StorageKeys.SINGLE_CONV_EXPORT_FORMAT]).toBe('html');
    expect(window.alert).not.toHaveBeenCalled();
  });

  it('all rapid failures return to the original value, and a later retry can succeed', async () => {
    await mount();
    transport.held.add(StorageKeys.SINGLE_CONV_EXPORT_FORMAT);
    await click('single-conv-export-json');
    await click('single-conv-export-html');
    await settle(0, false);
    await settle(1, false);
    expect(input('single-conv-export-markdown').checked).toBe(true);
    expect(transport.sync[StorageKeys.SINGLE_CONV_EXPORT_FORMAT]).toBe('markdown');
    await click('single-conv-export-json-simple');
    await settle(2, true);
    expect(input('single-conv-export-json-simple').checked).toBe(true);
    expect(transport.sync[StorageKeys.SINGLE_CONV_EXPORT_FORMAT]).toBe('json-simple');
  });

  it('rapid toggles keep write order and a failed final toggle restores the prior successful toggle', async () => {
    await mount();
    transport.held.add(StorageKeys.DRIVE_AUTO_ALLOW_ENABLED);
    await click('drive-auto-allow');
    await click('drive-auto-allow');
    expect(input('drive-auto-allow').checked).toBe(false);
    expect(transport.writes).toHaveLength(1);
    await settle(0, true);
    await settle(1, false);
    expect(input('drive-auto-allow').checked).toBe(true);
    expect(transport.sync[StorageKeys.DRIVE_AUTO_ALLOW_ENABLED]).toBe(true);
    expect(transport.writes.map((entry) => entry.values)).toEqual([
      { [StorageKeys.DRIVE_AUTO_ALLOW_ENABLED]: true },
      { [StorageKeys.DRIVE_AUTO_ALLOW_ENABLED]: false },
    ]);
  });

  it('different keys can save independently and never write local or unrelated user data', async () => {
    await mount();
    transport.held.add(StorageKeys.DRIVE_AUTO_ALLOW_ENABLED);
    const privateSync = structuredClone(transport.sync.privateFutureSetting);
    const local = structuredClone(transport.local);
    await click('drive-auto-allow');
    await click('single-conv-export-html');
    expect(transport.sync[StorageKeys.SINGLE_CONV_EXPORT_FORMAT]).toBe('html');
    expect(transport.writes).toHaveLength(2);
    await settle(0, false);
    expect(input('single-conv-export-html').checked).toBe(true);
    expect(transport.writes.every((entry) => entry.area === 'sync')).toBe(true);
    expect(transport.sync.privateFutureSetting).toEqual(privateSync);
    expect(transport.local).toEqual(local);
  });

  it('does not show late failure feedback after the Popup has unmounted', async () => {
    await mount();
    transport.held.add(StorageKeys.DRIVE_AUTO_ALLOW_ENABLED);
    await click('drive-auto-allow');
    await unmount();
    await settle(0, false);
    expect(window.alert).not.toHaveBeenCalled();
  });

  it('a pending save uses the language selected before its failure is shown', async () => {
    await mount('en');
    transport.held.add(StorageKeys.DRIVE_AUTO_ALLOW_ENABLED);
    await click('drive-auto-allow');
    await act(async () => { await setCachedLanguage('ru'); });
    await settle(0, false);
    expect(window.alert).toHaveBeenCalledWith(message('ru', 'settingsSaveFailed'));
  });

  it('a later rejected font toggle restores metadata successfully saved by the existing font importer', async () => {
    await mount();
    await click('gv-font-family-enabled');
    expect(transport.sync[StorageKeys.CHAT_FONT_FAMILY_ENABLED]).toBe(false);
    const font = new File(['font'], 'User-font.woff2');
    Object.defineProperty(font, 'arrayBuffer', {
      value: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    await pickFont(font);
    expect(transport.sync[StorageKeys.CHAT_FONT_FAMILY_ENABLED]).toBe(true);
    expect(input('gv-font-family-enabled').checked).toBe(true);
    transport.held.add(StorageKeys.CHAT_FONT_FAMILY_ENABLED);
    await click('gv-font-family-enabled');
    await settle(transport.writes.length - 1, false);
    expect(input('gv-font-family-enabled').checked).toBe(true);
    expect(transport.sync[StorageKeys.CHAT_FONT_FAMILY_ENABLED]).toBe(true);
  });

  it.each(APP_LANGUAGES)(
    'uses the actual %s dictionary for save rejection feedback',
    async (language) => {
      await mount(language);
      transport.held.add(StorageKeys.DRIVE_AUTO_ALLOW_ENABLED);
      await click('drive-auto-allow');
      await settle(0, false);
      expect(window.alert).toHaveBeenCalledWith(message(language, 'settingsSaveFailed'));
      expect(input('drive-auto-allow').checked).toBe(false);
    },
  );
});

describe('Popup missed-string follow-up with actual seven dictionaries', () => {
  it.each(APP_LANGUAGES)(
    'localizes website/font notices in %s and preserves user data verbatim',
    async (language) => {
      await mount(language);
      await fillWebsite('existing.example');
      expect(container.textContent).toContain(message(language, 'customWebsiteAlreadyAdded'));
      const filename = 'User-$&-名字.exe';
      await pickFont(new File(['font'], filename));
      expect(container.textContent).toContain(
        message(language, 'customFontUnsupported', { fileName: filename }),
      );
      expect(transport.writes).toHaveLength(0);
    },
  );

  it('refreshes a visible notice after language change and preserves raw system diagnostics', async () => {
    await mount('en');
    const file = new File(['font'], 'My-font.woff2');
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => {
        throw new Error('RAW $& diagnostic');
      },
    });
    await pickFont(file);
    expect(container.textContent).toContain(
      message('en', 'customFontImportFailed', { error: 'RAW $& diagnostic' }),
    );
    await act(async () => {
      await setCachedLanguage('fr');
    });
    expect(container.textContent).toContain(
      message('fr', 'customFontImportFailed', { error: 'RAW $& diagnostic' }),
    );
    expect(container.textContent).not.toContain('Font import failed:');
  });

  it('localizes large-font, successful-font, website-permission and website-success notices', async () => {
    await mount('de');
    const large = new File(['font'], 'Large.ttf');
    Object.defineProperty(large, 'size', { value: 4 * 1024 * 1024 + 1024 });
    await pickFont(large);
    expect(container.textContent).toContain(
      message('de', 'customFontTooLarge', { fileName: 'Large.ttf', size: 4097 }),
    );
    const small = new File(['font'], 'User-$&-字体.woff2');
    Object.defineProperty(small, 'arrayBuffer', {
      value: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    await pickFont(small);
    expect(container.textContent).toContain(
      message('de', 'customFontImported', { fontName: 'User-$&-字体', size: 0 }),
    );
    expect(transport.sync[StorageKeys.CHAT_CUSTOM_FONT_NAME]).toBe('User-$&-字体');
    transport.permission = false;
    await fillWebsite('new.example');
    expect(container.textContent).toContain(message('de', 'permissionDenied'));
    transport.permission = true;
    await fillWebsite('new.example');
    expect(container.textContent).toContain(message('de', 'websiteAdded'));
    expect(transport.sync[StorageKeys.PROMPT_CUSTOM_WEBSITES]).toEqual([
      'existing.example',
      'new.example',
    ]);
  });
});
