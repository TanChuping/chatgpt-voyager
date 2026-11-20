/** Serialized Chrome quota accounting with actual language + announcement modules. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import { APP_LANGUAGES, type AppLanguage } from '@/utils/language';

import currentV1 from './fixtures/current-v1.json';
import currentV2 from './fixtures/current-v2.json';

type Area = 'local' | 'sync';
type ChangeListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  area: string,
) => void;
type Store = Record<string, unknown>;
const bridge = vi.hoisted(() => ({
  get: null as unknown as (area: Area, keys: string | string[] | null) => Store,
  set: null as unknown as (area: Area, items: Store) => Promise<void>,
  listeners: new Set<ChangeListener>(),
  browserLanguage: 'ja-JP',
}));
vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      local: {
        get: async (keys: string | string[] | null) => bridge.get('local', keys),
        set: (items: Store) => bridge.set('local', items),
      },
      sync: {
        get: async (keys: string | string[] | null) => bridge.get('sync', keys),
        set: (items: Store) => bridge.set('sync', items),
      },
      onChanged: {
        addListener: (listener: ChangeListener) => bridge.listeners.add(listener),
        removeListener: (listener: ChangeListener) => bridge.listeners.delete(listener),
      },
    },
    runtime: { getURL: (path: string) => `chrome-extension://storage-fixture/${path}` },
    i18n: { getUILanguage: () => bridge.browserLanguage },
  },
}));

const NOW = 1795186800000;
const QUOTA = { local: 10485760, sync: 102400, syncPerItem: 8192, syncMaxItems: 512 };
const byteSize = (value: string) => Buffer.byteLength(value, 'utf8');
const keyValueBytes = (key: string, value: unknown) =>
  byteSize(key) + byteSize(JSON.stringify(value));
const used = (store: Store) =>
  Object.entries(store).reduce((sum, [key, value]) => sum + keyValueBytes(key, value), 0);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let stores: Record<Area, Store>;
let reads: Array<{ area: Area; keys: string | string[] | null }>;
let writes: Array<{
  phase: string;
  area: Area;
  items: Store;
  accepted: boolean;
  beforeBytes: number;
  afterBytes: number;
  deltaBytes: number;
}>;
let fetches: string[];
let remoteFeed = clone(currentV2);
let phase = '';
let rejectArea: Area | null;
let rejectKeys: Set<string>;
let service: typeof import('../service') | null;
let bootstrap: typeof import('../index') | null;
let onLanguageReady: (() => void) | null;
const results: Record<string, unknown> = {};

function addPadding(store: Store, target: number, prefix: string, maxItem = Infinity): void {
  let number = 0;
  while (used(store) < target) {
    const key = `${prefix}${number++}`;
    const overhead = keyValueBytes(key, '');
    const available = target - used(store);
    if (available < overhead) throw new Error('padding target is too close');
    const valueBytes = Math.min(maxItem - overhead, available - overhead);
    store[key] = 'x'.repeat(valueBytes);
  }
}

function installSyntheticExisting(acknowledged = false): void {
  stores.local = {
    [StorageKeys.FOLDER_DATA]: {
      version: 1,
      folders: [{ id: 'f1', name: '自取目录 / Пользователь', children: ['f2'] }],
      conversations: { c1: { title: '未翻译正文 日本語', folderId: 'f1' } },
    },
    [StorageKeys.TIMELINE_STARRED_MESSAGES]: {
      c1: [{ messageId: 'm1', text: 'Keep my **content** and {{variables}} intact' }],
    },
    [StorageKeys.PROMPT_ITEMS]: [
      {
        id: 'p1',
        title: '我命名的提示词',
        content: '任意原文 café 日本語',
        category: 'Private category',
      },
    ],
    gvBackup_folders_primary: {
      timestamp: 1700000000000,
      data: { original: [null, false, 42, 'unchanged'] },
    },
    gvBackup_folders_emergency: { raw: 'do not rewrite backup' },
    gvBackupConfig: { enabled: false, destination: 'synthetic-only' },
    gvAccountIsolationEnabled: true,
    'account:synthetic-user:private': {
      id: 'synthetic-user',
      opaque: ['secret-free fixture', 0, true],
    },
    unrecognizedPrivateKey: { preserve: ['unknown', '未来版本键', { nested: 1 }] },
    [StorageKeys.ANNOUNCEMENT_CACHE_V1]: { fetchedAt: NOW - 60000, payload: clone(currentV1) },
  };
  stores.sync = {
    [StorageKeys.LANGUAGE]: 'zh',
    [StorageKeys.CHAT_WIDTH]: 88,
    [StorageKeys.PROMPT_THEME]: 'system',
    privateSyncUnknown: { userChosen: '不可重写', flags: [true, false] },
  };
  if (acknowledged)
    Object.assign(stores.local, {
      [StorageKeys.ANNOUNCEMENT_SEEN_ID]: currentV1.current.id,
      [StorageKeys.ANNOUNCEMENT_BUBBLE_SHOWN_FOR]: currentV1.current.id,
      [StorageKeys.ANNOUNCEMENT_LAST_BUBBLE_AT]: NOW - 60000,
      [StorageKeys.ANNOUNCEMENT_LAST_SEEN_AT]: NOW - 60000,
    });
  addPadding(stores.local, 2 * 1024 * 1024, 'syntheticLocalPadding');
  addPadding(stores.sync, 80 * 1024, 'syntheticSyncPadding', 8000);
  expect(used(stores.local)).toBe(2097152);
  expect(used(stores.sync)).toBe(81920);
  expect(
    Math.max(...Object.entries(stores.sync).map(([key, value]) => keyValueBytes(key, value))),
  ).toBeLessThanOrEqual(QUOTA.syncPerItem);
}

beforeEach(async () => {
  vi.resetModules();
  stores = { local: {}, sync: {} };
  reads = [];
  writes = [];
  fetches = [];
  remoteFeed = clone(currentV2);
  rejectArea = null;
  rejectKeys = new Set();
  phase = 'setup';
  service = null;
  bootstrap = null;
  onLanguageReady = null;
  bridge.listeners.clear();
  bridge.browserLanguage = 'ja-JP';
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  bridge.get = (area, keys) => {
    reads.push({ area, keys: clone(keys) });
    const selected =
      keys === null ? Object.keys(stores[area]) : typeof keys === 'string' ? [keys] : keys;
    return clone(
      Object.fromEntries(
        selected.filter((key) => key in stores[area]).map((key) => [key, stores[area][key]]),
      ),
    );
  };
  bridge.set = async (area, items) => {
    const beforeBytes = used(stores[area]);
    const accepted = rejectArea !== area && !Object.keys(items).some((key) => rejectKeys.has(key));
    const previous = clone(stores[area]);
    if (accepted) Object.assign(stores[area], clone(items));
    writes.push({
      phase,
      area,
      items: clone(items),
      accepted,
      beforeBytes,
      afterBytes: used(stores[area]),
      deltaBytes: used(stores[area]) - beforeBytes,
    });
    if (!accepted) throw new Error('QUOTA_BYTES quota exceeded (synthetic rejection)');
    const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    for (const [key, value] of Object.entries(items)) {
      if (JSON.stringify(previous[key]) !== JSON.stringify(value))
        changes[key] = { oldValue: previous[key], newValue: clone(value) };
    }
    if (Object.keys(changes).length)
      for (const listener of bridge.listeners) listener(changes, area);
  };
  const callbackArea = (area: Area) => ({
    get: (keys: string | string[] | null, callback: (result: Store) => void) =>
      queueMicrotask(() => callback(bridge.get(area, keys))),
    set: (items: Store, callback?: () => void) => {
      void bridge
        .set(area, items)
        .then(() => callback?.())
        .catch((error) => {
          (chrome.runtime as unknown as { lastError: unknown }).lastError = {
            message: error.message,
          };
          callback?.();
          (chrome.runtime as unknown as { lastError: unknown }).lastError = undefined;
        });
    },
  });
  globalThis.chrome = {
    storage: {
      local: callbackArea('local'),
      sync: callbackArea('sync'),
      onChanged: {
        addListener: (listener: ChangeListener) => bridge.listeners.add(listener),
        removeListener: (listener: ChangeListener) => bridge.listeners.delete(listener),
      },
    },
    runtime: { id: 'storage-fixture', lastError: undefined },
  } as unknown as typeof chrome;
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    fetches.push(url);
    if (url.startsWith('chrome-extension://storage-fixture/locales/')) {
      const language = url.match(/\/([a-z]{2})\.json$/)![1];
      const source = JSON.parse(
        readFileSync(resolve(process.cwd(), `src/locales/${language}/messages.json`), 'utf8'),
      );
      return new Response(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(source).map(([key, value]) => [
              key,
              (value as { message: string }).message,
            ]),
          ),
        ),
        { status: 200 },
      );
    }
    if (/\/i18n\/announcements\.json\?t=/.test(url))
      return new Response(JSON.stringify(remoteFeed), { status: 200 });
    throw new Error(`Unexpected fixture URL ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  onLanguageReady?.();
  bootstrap?.stopAnnouncement();
  service?.__resetAnnouncementServiceForTests();
  document.querySelector<HTMLButtonElement>('.gv-announcement-modal__close')?.click();
  document.body.replaceChildren();
  bridge.listeners.clear();
  vi.restoreAllMocks();
});

afterAll(() => {
  const target = process.env.VOYAGER_STORAGE_REPORT_PATH;
  if (!target) return;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    JSON.stringify(
      {
        measurement:
          'Actual production language/announcement API calls against a synthetic Chrome adapter; UTF-8 key + JSON.stringify(value) accounting. Not browser getBytesInUse.',
        quotaReference: 'https://developer.chrome.com/docs/extensions/reference/api/storage',
        quotas: QUOTA,
        currentV1CacheBytes: keyValueBytes(StorageKeys.ANNOUNCEMENT_CACHE_V1, {
          fetchedAt: NOW,
          payload: currentV1,
        }),
        currentV2CacheBytes: keyValueBytes(StorageKeys.ANNOUNCEMENT_CACHE_V2, {
          fetchedAt: NOW,
          payload: currentV2,
        }),
        newInstallCacheDeltaVsV1:
          keyValueBytes(StorageKeys.ANNOUNCEMENT_CACHE_V2, { fetchedAt: NOW, payload: currentV2 }) -
          keyValueBytes(StorageKeys.ANNOUNCEMENT_CACHE_V1, { fetchedAt: NOW, payload: currentV1 }),
        assumptionBoundary:
          'The 21,666-byte cache is the supplied current feed, not a maximum for arbitrary future publication sizes. No claim about any real existing user remaining space.',
        results,
      },
      null,
      2,
    ) + '\n',
  );
});

describe('actual language + announcement APIs, synthetic persistent store', () => {
  for (const scenario of ['empty', 'existing_2MiB_local_80KiB_sync'] as const) {
    it(`preserves user data and measures deltas: ${scenario}`, async () => {
      if (scenario !== 'empty') installSyntheticExisting();
      const original = clone(stores);
      const protectedSync = Object.fromEntries(
        Object.entries(original.sync).filter(([key]) => key !== StorageKeys.LANGUAGE),
      );
      const stages: Array<{
        name: string;
        localBytes: number;
        syncBytes: number;
        localAdded: number;
        syncAdded: number;
        localRemaining: number;
        syncRemaining: number;
        writeCount: number;
      }> = [];
      const takeStage = (name: string) =>
        stages.push({
          name,
          localBytes: used(stores.local),
          syncBytes: used(stores.sync),
          localAdded: used(stores.local) - used(original.local),
          syncAdded: used(stores.sync) - used(original.sync),
          localRemaining: QUOTA.local - used(stores.local),
          syncRemaining: QUOTA.sync - used(stores.sync),
          writeCount: writes.length,
        });
      takeStage('before_upgrade');
      const language = await import('@/utils/i18n');
      service = await import('../service');
      bootstrap = await import('../index');
      phase = 'initial_upgrade_read';
      await language.initI18n();
      expect(language.getCachedLanguage()).toBe(scenario === 'empty' ? 'ja' : 'zh');
      expect(writes).toEqual([]);
      expect(fetches).toEqual([
        `chrome-extension://storage-fixture/locales/${scenario === 'empty' ? 'ja' : 'zh'}.json`,
      ]);
      takeStage(phase);

      phase = 'first_v2_cache';
      const first = await service.refreshSnapshot();
      expect(first.current?.id).toBe(currentV2.current.id);
      expect(first.current?.language).toBe(scenario === 'empty' ? 'ja' : 'zh');
      expect(writes.map((entry) => Object.keys(entry.items))).toEqual([
        [StorageKeys.ANNOUNCEMENT_CACHE_V2],
      ]);
      expect(
        keyValueBytes(
          StorageKeys.ANNOUNCEMENT_CACHE_V2,
          stores.local[StorageKeys.ANNOUNCEMENT_CACHE_V2],
        ),
      ).toBe(21666);
      takeStage(phase);

      phase = 'seven_languages_out_and_back';
      const localWritesBefore = writes.filter((entry) => entry.area === 'local').length;
      for (const selected of [...APP_LANGUAGES, ...APP_LANGUAGES].reverse()) {
        await language.setLanguagePreference(selected);
        const snapshot = await service.refreshSnapshot();
        expect(language.getCachedLanguage()).toBe(selected);
        expect(snapshot.current?.language).toBe(selected);
        const dictionary = JSON.parse(
          readFileSync(resolve(process.cwd(), `src/locales/${selected}/messages.json`), 'utf8'),
        );
        expect(await language.getTranslation('announcementButton')).toBe(
          dictionary.announcementButton.message,
        );
      }
      expect(writes.filter((entry) => entry.area === 'local')).toHaveLength(localWritesBefore);
      takeStage(phase);

      phase = 'bubble_shown';
      await service.markBubbleShown(currentV2.current.id);
      expect(service.getLastSnapshot().shouldPopBubble).toBe(false);
      expect(service.getLastSnapshot().hasUnread).toBe(true);
      takeStage(phase);

      phase = 'open_details_marks_seen';
      await bootstrap.openCurrentAnnouncementModal();
      await vi.waitFor(() => expect(service!.getLastSnapshot().hasUnread).toBe(false));
      expect(stores.local[StorageKeys.ANNOUNCEMENT_SEEN_ID]).toBe(currentV2.current.id);
      expect(stores.local[StorageKeys.ANNOUNCEMENT_LAST_SEEN_AT]).toBe(NOW);
      takeStage(phase);

      phase = 'details_only_seven_language_switch';
      const beforeReadChoice = clone(stores);
      const writesBeforeReading = writes.length;
      for (const selected of APP_LANGUAGES) {
        document.querySelector<HTMLButtonElement>(`button[data-language="${selected}"]`)!.click();
        expect(
          document.querySelector<HTMLElement>('.gv-announcement-modal')!.dataset.language,
        ).toBe(selected);
      }
      document.querySelector<HTMLButtonElement>('.gv-announcement-modal__close')!.click();
      expect(stores).toEqual(beforeReadChoice);
      expect(writes).toHaveLength(writesBeforeReading);
      takeStage(phase);

      for (const [key, value] of Object.entries(original.local))
        expect(stores.local[key]).toEqual(value);
      for (const [key, value] of Object.entries(protectedSync))
        expect(stores.sync[key]).toEqual(value);
      expect(reads.every((read) => read.keys !== null)).toBe(true);
      const allowedLocal = new Set([
        StorageKeys.ANNOUNCEMENT_CACHE_V2,
        StorageKeys.ANNOUNCEMENT_SEEN_ID,
        StorageKeys.ANNOUNCEMENT_BUBBLE_SHOWN_FOR,
        StorageKeys.ANNOUNCEMENT_LAST_BUBBLE_AT,
        StorageKeys.ANNOUNCEMENT_LAST_SEEN_AT,
      ]);
      expect(
        writes.every((entry) =>
          Object.keys(entry.items).every((key) =>
            entry.area === 'sync' ? key === StorageKeys.LANGUAGE : allowedLocal.has(key as never),
          ),
        ),
      ).toBe(true);
      expect(Object.keys(stores.sync).length).toBeLessThanOrEqual(QUOTA.syncMaxItems);
      results[scenario] = {
        stages,
        protectedLocalKeys: Object.keys(original.local),
        protectedSyncKeys: Object.keys(protectedSync),
        originalLocalHash: hash(original.local),
        protectedLocalAfterHash: hash(
          Object.fromEntries(Object.keys(original.local).map((key) => [key, stores.local[key]])),
        ),
        originalProtectedSyncHash: hash(protectedSync),
        protectedSyncAfterHash: hash(
          Object.fromEntries(Object.keys(protectedSync).map((key) => [key, stores.sync[key]])),
        ),
        privateValuesUnchanged: true,
        fullStoreScans: reads.filter((read) => read.keys === null).length,
        dictionaryStorageWrites: 0,
        writes,
        reads,
        fetchedUrls: fetches,
      };
    }, 15000);
  }

  it('upgrade respects a same-ID V1 acknowledgment without resetting old cooldown timestamps', async () => {
    installSyntheticExisting(true);
    const original = clone(stores);
    const language = await import('@/utils/i18n');
    await language.initI18n();
    service = await import('../service');
    phase = 'already_acknowledged_v1_upgrade';
    const snapshot = await service.refreshSnapshot();
    expect(snapshot.current?.id).toBe(currentV1.current.id);
    expect(snapshot.hasUnread).toBe(false);
    expect(snapshot.shouldPopBubble).toBe(false);
    for (const [key, value] of Object.entries(original.local))
      expect(stores.local[key]).toEqual(value);
    expect(stores.sync).toEqual(original.sync);
    expect(writes.map((entry) => Object.keys(entry.items))).toEqual([
      [StorageKeys.ANNOUNCEMENT_CACHE_V2],
    ]);
    results.already_acknowledged_upgrade = {
      sameId: snapshot.current?.id,
      unread: snapshot.hasUnread,
      shouldPop: snapshot.shouldPopBubble,
      allOriginalValuesUnchanged: true,
      addedLocalBytes: used(stores.local) - used(original.local),
      addedSyncBytes: used(stores.sync) - used(original.sync),
      localRemaining: QUOTA.local - used(stores.local),
      syncRemaining: QUOTA.sync - used(stores.sync),
      writes,
    };
  });

  it('cache rejection alone does not falsely mark read; small acknowledgment keys can still persist', async () => {
    installSyntheticExisting();
    rejectKeys.add(StorageKeys.ANNOUNCEMENT_CACHE_V2);
    const language = await import('@/utils/i18n');
    await language.initI18n();
    service = await import('../service');
    phase = 'cache_only_rejected';
    const snapshot = await service.refreshSnapshot();
    expect(snapshot.current?.id).toBe(currentV2.current.id);
    expect(snapshot.hasUnread).toBe(true);
    expect(stores.local[StorageKeys.ANNOUNCEMENT_CACHE_V2]).toBeUndefined();
    expect(stores.local[StorageKeys.ANNOUNCEMENT_SEEN_ID]).toBeUndefined();
    const persisted = await service.markSeen(currentV2.current.id);
    expect(persisted).toBe(true);
    expect(service.getLastSnapshot().hasUnread).toBe(false);
    expect(service.getLastSnapshot().shouldPopBubble).toBe(false);
    results.cache_rejection = {
      cachePersisted: false,
      contentStillReadable: true,
      falseReadMarkOnFetch: false,
      explicitReadMarkPersisted: true,
      writes,
    };
  });

  it('rejects persistence success and suppresses repeats for this runtime when all local writes fail', async () => {
    const language = await import('@/utils/i18n');
    await language.initI18n();
    rejectArea = 'local';
    service = await import('../service');
    phase = 'all_local_writes_rejected';
    const observations = [];
    for (let reload = 0; reload < 3; reload++) {
      service.__resetAnnouncementServiceForTests();
      const before = await service.refreshSnapshot();
      const bubblePersisted = await service.markBubbleShown(currentV2.current.id);
      const readPersisted = await service.markSeen(currentV2.current.id);
      const after = service.getLastSnapshot();
      expect(bubblePersisted).toBe(false);
      expect(readPersisted).toBe(false);
      expect(before.shouldPopBubble).toBe(true);
      expect(after.hasUnread).toBe(false);
      expect(after.shouldPopBubble).toBe(false);
      const flagWrites = writes.filter(
        (write) => !Object.hasOwn(write.items, StorageKeys.ANNOUNCEMENT_CACHE_V2),
      ).length;
      await service.refreshSnapshot(true);
      const repeatedBubblePersisted = await service.markBubbleShown(currentV2.current.id);
      expect(repeatedBubblePersisted).toBe(false);
      expect(service.getLastSnapshot().hasUnread).toBe(false);
      expect(service.getLastSnapshot().shouldPopBubble).toBe(false);
      expect(
        writes.filter((write) => !Object.hasOwn(write.items, StorageKeys.ANNOUNCEMENT_CACHE_V2)),
      ).toHaveLength(flagWrites);
      observations.push({
        simulatedReload: reload,
        beforeShouldPop: before.shouldPopBubble,
        afterShouldPop: after.shouldPopBubble,
        afterUnread: after.hasUnread,
        bubblePersisted,
        readPersisted,
        repeatedBubblePersisted,
        automaticFlagWriteRetries: 0,
      });
    }
    expect(stores.local).toEqual({});
    expect(console.warn).toHaveBeenCalled();
    results.all_local_write_rejection = {
      observations,
      storageUnchanged: true,
      falselyReportedPersistenceSuccess: false,
      finding:
        'Callback lastError is detected. markSeen/markBubbleShown return false and keep bounded ID/timestamp fallback for this content runtime, preventing same-page repeats. A complete reload loses the session fallback; with all writes refused cross-reload cooldown cannot be guaranteed. No automatic flag-write retry loop.',
      writes,
    };
  }, 15000);

  it('actual bootstrap does not re-show a bubble beside an opened modal after rejected writes', async () => {
    document.body.innerHTML =
      '<header><div style="display:flex;align-items:center"><button data-testid="temporary-chat-toggle">Temporary</button></div></header>';
    rejectArea = 'local';
    phase = 'bootstrap_all_local_writes_rejected';
    service = await import('../service');
    bootstrap = await import('../index');
    bootstrap.startAnnouncement();
    await vi.waitFor(() =>
      expect(document.querySelector('.gv-announcement-bubble')).not.toBeNull(),
    );
    document.querySelector<HTMLButtonElement>('.gv-announcement-bubble__detail')!.click();
    await vi.waitFor(() => expect(service!.getLastSnapshot().hasUnread).toBe(false));
    expect(document.querySelector('.gv-announcement-modal')).not.toBeNull();
    expect(document.querySelector('.gv-announcement-bubble')).toBeNull();
    for (let count = 0; count < 3; count++) await service.refreshSnapshot(true);
    expect(document.querySelector('.gv-announcement-bubble')).toBeNull();
    expect(service.getLastSnapshot().shouldPopBubble).toBe(false);
    expect(stores.local).toEqual({});
    results.bootstrap_rejected_writes = {
      browserEvidence: 'jsdom fixture only',
      modalVisible: true,
      bubbleRepoppedBesideModal: false,
      persistentValuesCreated: 0,
      writes,
    };
  });

  it('session fallback keeps the original 24-hour dot and 14-day bubble cooldowns for new IDs', async () => {
    rejectArea = 'local';
    phase = 'session_only_hard_cooldowns';
    service = await import('../service');
    await service.refreshSnapshot();
    expect(await service.markSeen(currentV2.current.id)).toBe(false);
    remoteFeed.current.id = 'synthetic-next-id';
    const immediate = await service.refreshSnapshot(true);
    expect(immediate.hasUnread).toBe(false);
    expect(immediate.shouldPopBubble).toBe(false);
    vi.mocked(Date.now).mockReturnValue(NOW + 25 * 60 * 60 * 1000);
    const afterDay = await service.refreshSnapshot(true);
    expect(afterDay.hasUnread).toBe(true);
    expect(afterDay.shouldPopBubble).toBe(false);
    vi.mocked(Date.now).mockReturnValue(NOW + 15 * 24 * 60 * 60 * 1000);
    const afterFortnight = await service.refreshSnapshot(true);
    expect(afterFortnight.hasUnread).toBe(true);
    expect(afterFortnight.shouldPopBubble).toBe(true);
    expect(stores.local).toEqual({});
    results.session_only_hard_cooldowns = {
      immediate: { unread: immediate.hasUnread, bubble: immediate.shouldPopBubble },
      after25Hours: { unread: afterDay.hasUnread, bubble: afterDay.shouldPopBubble },
      after15Days: { unread: afterFortnight.hasUnread, bubble: afterFortnight.shouldPopBubble },
      persistentValuesCreated: 0,
    };
  });

  it('a partial acknowledgment write failure is not reported as persistent success', async () => {
    const language = await import('@/utils/i18n');
    await language.initI18n();
    service = await import('../service');
    phase = 'partial_read_marker_rejection';
    await service.refreshSnapshot();
    rejectKeys.add(StorageKeys.ANNOUNCEMENT_SEEN_ID);
    const persisted = await service.markSeen(currentV2.current.id);
    expect(persisted).toBe(false);
    expect(stores.local[StorageKeys.ANNOUNCEMENT_SEEN_ID]).toBeUndefined();
    expect(stores.local[StorageKeys.ANNOUNCEMENT_LAST_SEEN_AT]).toBe(NOW);
    expect(service.getLastSnapshot().hasUnread).toBe(false);
    expect(service.getLastSnapshot().shouldPopBubble).toBe(false);
    results.partial_read_marker_rejection = {
      persistenceReported: persisted,
      sameRuntimeUnread: service.getLastSnapshot().hasUnread,
      failedKey: StorageKeys.ANNOUNCEMENT_SEEN_ID,
      writes,
    };
  });

  it('records the inherited sync-first language fallback boundary on rejected sync writes', async () => {
    installSyntheticExisting();
    const language = await import('@/utils/i18n');
    await language.initI18n();
    rejectArea = 'sync';
    phase = 'language_sync_rejected_local_fallback';
    await language.setLanguagePreference('ja');
    expect(language.getCachedLanguage()).toBe('ja');
    expect(stores.local[StorageKeys.LANGUAGE]).toBe('ja');
    expect(stores.sync[StorageKeys.LANGUAGE]).toBe('zh');
    expect(await language.getCurrentLanguage()).toBe('zh');
    results.sync_rejection_language_boundary = {
      currentVisibleLanguage: language.getCachedLanguage(),
      persistedLocalFallback: stores.local[StorageKeys.LANGUAGE],
      oldSyncLanguage: stores.sync[StorageKeys.LANGUAGE],
      nextStorageReadLanguage: await language.getCurrentLanguage(),
      finding:
        'The preserved sync-first read precedence chooses the old sync value on a later fresh context even though the current context uses the new local fallback. This boundary also exists in the baseline read/write design.',
      writes,
    };
  });
});
