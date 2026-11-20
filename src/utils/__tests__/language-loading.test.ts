import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  sync: {} as Record<string, unknown>,
  local: {} as Record<string, unknown>,
  listeners: [] as Array<(changes: Record<string, { newValue?: unknown }>, area: string) => void>,
  writes: [] as Array<{ area: string; data: Record<string, unknown> }>,
  ui: 'en-US',
  syncFails: false,
}));
vi.mock('webextension-polyfill', () => {
  const area = (name: 'sync' | 'local') => ({
    get: vi.fn(async (key: string) => ({ [key]: state[name][key] })),
    set: vi.fn(async (data: Record<string, unknown>) => {
      if (name === 'sync' && state.syncFails) throw new Error('quota fixture');
      state.writes.push({ area: name, data: structuredClone(data) });
      Object.assign(state[name], data);
      for (const [key, value] of Object.entries(data)) {
        state.listeners.forEach((listener) => listener({ [key]: { newValue: value } }, name));
      }
    }),
  });
  return { default: {
    storage: { sync: area('sync'), local: area('local'), onChanged: {
      addListener: (f: typeof state.listeners[number]) => state.listeners.push(f),
      removeListener: (f: typeof state.listeners[number]) => { state.listeners = state.listeners.filter((x) => x !== f); },
    } },
    i18n: { getUILanguage: () => state.ui },
    runtime: { getURL: (path: string) => `chrome-extension://fixture/${path}` },
  } };
});
const dictionary = (lang: string) => Object.fromEntries(Object.entries(
  JSON.parse(readFileSync(resolve('src/locales', lang, 'messages.json'), 'utf8')) as Record<string, {message: string}>,
).map(([key, value]) => [key, value.message]));
const response = (lang: string) => ({ ok: true, json: async () => dictionary(lang) });
const langOf = (url: unknown) => String(url).match(/\/locales\/(\w+)\.json$/)?.[1] ?? '';
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  state.sync = {}; state.local = {}; state.listeners = []; state.writes = [];
  state.ui = 'en-US'; state.syncFails = false;
  document.body.replaceChildren();
  fetchMock = vi.fn(async (url: unknown) => response(langOf(url)));
  vi.stubGlobal('fetch', fetchMock);
});

describe('selected-language loading and legacy data integrity', () => {
  it('normalizes regional variants while preserving a saved old-language choice', async () => {
    const { normalizeLanguage } = await import('../language');
    for (const [input, expected] of [['en-GB','en'], ['ZH_hans_CN','zh'], ['ja-JP','ja'], ['fr-CA','fr'], ['de_AT','de'], ['es-419','es'], ['ru-RU','ru'], ['pt-BR','en']]) {
      expect(normalizeLanguage(input)).toBe(expected);
    }
    state.sync.language = 'zh'; state.ui = 'fr-CA';
    const i18n = await import('../i18n');
    expect(await i18n.getCurrentLanguage()).toBe('zh');
    await i18n.initI18n();
    expect(fetchMock.mock.calls.map(([url]) => langOf(url))).toEqual(['zh']);
    expect(state.writes).toEqual([]);
  });

  it('loads just the selected locale on cold start, with one listener for repeated init', async () => {
    state.ui = 'de-AT';
    const i18n = await import('../i18n');
    await Promise.all([i18n.initI18n(), i18n.initI18n(), i18n.initI18n()]);
    expect(fetchMock.mock.calls.map(([url]) => langOf(url))).toEqual(['de']);
    expect(state.listeners).toHaveLength(1);
    expect(i18n.getTranslationSync('language')).toBe(dictionary('de').language);
    expect(state.writes).toEqual([]);
  });

  it('re-fetches a revisited dictionary without accumulating a module/dictionary cache', async () => {
    const i18n = await import('../i18n');
    await i18n.initI18n();
    for (const lang of ['ja', 'fr', 'de', 'es', 'ru', 'zh', 'ja'] as const) await i18n.setLanguagePreference(lang);
    expect(fetchMock.mock.calls.map(([url]) => langOf(url))).toEqual(['en','ja','fr','de','es','ru','zh','ja']);
    expect(i18n.getTranslationSync('language')).toBe(dictionary('ja').language);
    expect(state.sync.language).toBe('ja');
    expect(state.writes.every((w) => Object.keys(w.data).join() === 'language')).toBe(true);
  });

  it('ignores a late old request even if the fetch adapter ignores abort', async () => {
    const i18n = await import('../i18n');
    await i18n.initI18n();
    let finishJapanese!: (value: ReturnType<typeof response>) => void;
    fetchMock.mockImplementation(async (url: unknown) => langOf(url) === 'ja'
      ? await new Promise((resolve) => { finishJapanese = resolve; }) : response(langOf(url)));
    const old = i18n.setLanguagePreference('ja');
    const latest = i18n.setLanguagePreference('ru');
    await latest;
    finishJapanese(response('ja'));
    await old;
    expect(i18n.getCachedLanguage()).toBe('ru');
    expect(i18n.getTranslationSync('language')).toBe(dictionary('ru').language);
    expect(state.sync.language).toBe('ru');
  });

  it('accepts a later choice from another open surface while its own dictionary is loading', async () => {
    const i18n = await import('../i18n');
    await i18n.initI18n();
    let finishJapanese!: (value: ReturnType<typeof response>) => void;
    fetchMock.mockImplementation(async (url: unknown) => langOf(url) === 'ja'
      ? await new Promise((resolve) => { finishJapanese = resolve; }) : response(langOf(url)));
    const fromThisSurface = i18n.setLanguagePreference('ja');
    await vi.waitFor(() => expect(state.sync.language).toBe('ja'));
    // The shared write completed, but this context's ja.json has not arrived.
    state.sync.language = 'ru';
    state.listeners.forEach((listener) => listener({language:{newValue:'ru'}}, 'sync'));
    await vi.waitFor(() => expect(i18n.getTranslationSync('language')).toBe(dictionary('ru').language));
    finishJapanese(response('ja'));
    await fromThisSurface;
    expect(i18n.getCachedLanguage()).toBe('ru');
    expect(state.sync.language).toBe('ru');
  });

  it('reconciles a concurrent shared write before this surface finishes saving', async () => {
    const i18n = await import('../i18n');
    await i18n.initI18n();
    const browser = (await import('webextension-polyfill')).default;
    const originalSet = vi.mocked(browser.storage.sync.set).getMockImplementation()!;
    let finishSave!: () => void;
    vi.mocked(browser.storage.sync.set).mockImplementationOnce(async (value) => {
      await originalSet(value);
      await new Promise<void>((resolve) => { finishSave = resolve; });
    });
    const saving = i18n.setLanguagePreference('ja');
    await vi.waitFor(() => expect(state.sync.language).toBe('ja'));
    state.sync.language = 'ru';
    state.listeners.forEach((listener) => listener({language:{newValue:'ru'}}, 'sync'));
    finishSave();
    await saving;
    expect(i18n.getCachedLanguage()).toBe('ru');
    expect(i18n.getTranslationSync('language')).toBe(dictionary('ru').language);
  });

  it('falls back once to packaged English for a missing locale and preserves the preference', async () => {
    state.sync.language = 'fr';
    fetchMock.mockImplementation(async (url: unknown) => langOf(url) === 'fr'
      ? {ok: false, status: 404} : response(langOf(url)));
    const i18n = await import('../i18n');
    await i18n.initI18n();
    expect(fetchMock.mock.calls.map(([url]) => langOf(url))).toEqual(['fr','en']);
    expect(i18n.getCachedLanguage()).toBe('fr');
    expect(i18n.getTranslationSync('language')).toBe(dictionary('en').language);
    expect(state.sync.language).toBe('fr');
    expect(state.writes).toEqual([]);
  });

  it('has a small usable fallback if both packaged resources are unavailable', async () => {
    state.sync.language = 'es'; fetchMock.mockRejectedValue(new Error('packaging fixture'));
    const i18n = await import('../i18n');
    await i18n.initI18n();
    expect(i18n.getTranslationSync('pm_settings')).toBe('Settings');
    expect(i18n.getCachedLanguage()).toBe('es');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('notifies existing surfaces only after the new dictionary can serve synchronous text', async () => {
    const i18n = await import('../i18n'); await i18n.initI18n();
    const seen: string[] = [];
    const remove = i18n.subscribeLanguageChange((lang) => seen.push(`${lang}:${i18n.getTranslationSync('language')}`));
    state.listeners.forEach((listener) => listener({language:{newValue:'es-MX'}}, 'sync'));
    await vi.waitFor(() => expect(seen).toEqual([`es:${dictionary('es').language}`]));
    remove(); await i18n.setCachedLanguage('ru');
    expect(seen).toHaveLength(1);
  });

  it('refreshes marked extension labels without replacing controls or user text', async () => {
    const i18n = await import('../i18n'); await i18n.initI18n();
    const { mountFloatingModeNudge } = await import('@/pages/content/folder/floatingModeNudge');
    const enabled = vi.fn();
    const card = mountFloatingModeNudge({onEnable: enabled, onDismiss: vi.fn()})!;
    const button = card.querySelector<HTMLButtonElement>('.gv-floating-mode-nudge__btn--primary')!;
    const input = document.createElement('input'); input.value = '用户草稿 unchanged'; card.appendChild(input);
    await i18n.setLanguagePreference('ru');
    expect(button.textContent).toBe(dictionary('ru').floatingModeNudgeEnable);
    expect(card.querySelector('.gv-floating-mode-nudge__btn--primary')).toBe(button);
    expect(input.value).toBe('用户草稿 unchanged');
    button.click();
    expect(enabled).toHaveBeenCalledOnce();
    expect(card.isConnected).toBe(false);
  });

  it('preserves synthetic old private data and only writes the original language key', async () => {
    state.sync = { language:'zh', folders:[{id:'f1',name:'My folder 原名'}], prompts:[{name:'私有',content:'${do_not_translate}'}], backup:{path:'original'} };
    state.local = { gvAnnouncementCache:{v:1,current:{id:'old',title:'Legacy'}}, favorites:[{text:'A user message'}], accountMap:{owner:'synthetic'}, unknownPrivate:{bytes:[0,1,255]} };
    const beforeSync=structuredClone(state.sync), beforeLocal=structuredClone(state.local);
    const i18n = await import('../i18n'); await i18n.initI18n();
    for (const lang of ['ja','ru','en','zh'] as const) await i18n.setLanguagePreference(lang);
    expect(state.sync).toEqual(beforeSync); expect(state.local).toEqual(beforeLocal);
    expect(state.writes.map((w) => Object.keys(w.data))).toEqual([['language'],['language'],['language'],['language']]);
    expect(state.writes.every((w) => w.area === 'sync')).toBe(true);
  });

  it('uses the original local fallback on sync failure without copying any user records', async () => {
    state.syncFails=true; state.local.private={unchanged:true};
    const i18n=await import('../i18n'); await i18n.initI18n(); await i18n.setLanguagePreference('ja');
    expect(state.local).toEqual({private:{unchanged:true},language:'ja'});
    expect(state.writes).toEqual([{area:'local',data:{language:'ja'}}]);
  });
});
