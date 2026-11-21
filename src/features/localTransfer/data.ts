import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';
import { isSafari } from '@/core/utils/browser';
import { HIGHLIGHTS_PREFIX } from '@/pages/content/textHighlights/anchors';
import {
  TIMELINE_STARS_PREFIX,
  TIMELINE_TEXT_PINS_PREFIX,
  applyTimelinePrivateStorageChange,
} from '@/pages/content/timeline/timelinePrivateStorage';

import { mergeLocalSections } from './merge';
import {
  type ImportCounts,
  LOCAL_BACKUP_FORMAT,
  LOCAL_SECTIONS,
  type LocalBackup,
  type LocalSection,
  type LocalSections,
  LocalTransferError,
  canonicalJson,
  parseJson,
  parseLocalBackup,
  validateSection,
} from './model';

export {
  LOCAL_BACKUP_FORMAT,
  LOCAL_SECTIONS,
  LocalTransferError,
  parseLocalBackup,
  type ImportCounts,
  type LocalBackup,
  type LocalSection,
  type LocalSections,
} from './model';

const EXT_KEYS: Partial<Record<LocalSection, string>> = {
  folders: StorageKeys.FOLDER_DATA,
  favorites: StorageKeys.TIMELINE_STARRED_MESSAGES,
  prompts: StorageKeys.PROMPT_ITEMS,
};
const HOST_PREFIXES: Partial<Record<LocalSection, string>> = {
  favorites: TIMELINE_STARS_PREFIX,
  textPins: TIMELINE_TEXT_PINS_PREFIX,
  highlights: HIGHLIGHTS_PREFIX,
};

interface StorageSnapshot {
  ext: Record<string, unknown>;
  host: Record<string, string>;
  safari: boolean;
}

export interface LocalImportPreview {
  sections: Partial<Record<LocalSection, ImportCounts>>;
}

const prepared = new WeakMap<
  LocalImportPreview,
  { backup: LocalBackup; snapshot: StorageSnapshot }
>();
let applying = false;

async function readStorage(
  sections: LocalSection[] = [...LOCAL_SECTIONS],
): Promise<StorageSnapshot> {
  const safari = isSafari();
  const keys = sections.flatMap((section) => EXT_KEYS[section] ?? []);
  const prefixes = sections.flatMap((section) => HOST_PREFIXES[section] ?? []);
  try {
    const ext = keys.length ? await browser.storage.local.get(keys) : {};
    const host: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (
        prefixes.some((prefix) => key.startsWith(prefix)) ||
        (key === StorageKeys.FOLDER_DATA && sections.includes('folders') && !safari) ||
        (key === StorageKeys.PROMPT_ITEMS && sections.includes('prompts') && ext[key] === undefined)
      ) {
        const value = localStorage.getItem(key);
        if (value !== null) host[key] = value;
      }
    }
    return { ext, host, safari };
  } catch (error) {
    throw new LocalTransferError('read', error);
  }
}

function readSectionData(
  { ext, host, safari }: StorageSnapshot,
  allowDivergence = false,
): LocalSections {
  function readHostPrefix(prefix: string, decode: (raw: unknown) => unknown = (raw) => raw) {
    return Object.fromEntries(
      Object.entries(host)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length), decode(parseJson(value))]),
    );
  }

  const folderKey = StorageKeys.FOLDER_DATA;
  const promptKey = StorageKeys.PROMPT_ITEMS;
  const folderExt = ext[folderKey];
  const foldersFromExtension =
    folderExt === undefined
      ? undefined
      : validateSection(
          'folders',
          typeof folderExt === 'string' && safari ? parseJson(folderExt) : folderExt,
        );
  const foldersFromHost =
    host[folderKey] === undefined
      ? undefined
      : validateSection('folders', parseJson(host[folderKey]));
  let folders = foldersFromExtension ?? foldersFromHost ?? { folders: [], folderContents: {} };
  if (
    foldersFromExtension &&
    foldersFromHost &&
    canonicalJson(foldersFromExtension) !== canonicalJson(foldersFromHost)
  ) {
    if (!allowDivergence) throw new LocalTransferError('folder-diverged');
    // Export can rescue data from both live copies without modifying either.
    folders = mergeLocalSections(
      {
        folders: foldersFromExtension,
        favorites: { shared: { messages: {} }, legacy: {} },
        textPins: {},
        highlights: {},
        prompts: [],
      },
      { folders: foldersFromHost },
    ).merged.folders;
  }

  const shared = ext[StorageKeys.TIMELINE_STARRED_MESSAGES];
  const legacy = readHostPrefix(TIMELINE_STARS_PREFIX);
  const prompts =
    ext[promptKey] === undefined
      ? host[promptKey] === undefined
        ? []
        : parseJson(host[promptKey])
      : ext[promptKey];
  return {
    folders,
    favorites: validateSection('favorites', {
      shared: shared === undefined ? { messages: {} } : shared,
      legacy,
    }),
    textPins: validateSection(
      'textPins',
      readHostPrefix(TIMELINE_TEXT_PINS_PREFIX, (raw) => {
        if (Array.isArray(raw)) return raw;
        if (
          raw &&
          typeof raw === 'object' &&
          'pins' in raw &&
          (!('version' in raw) || raw.version === 1)
        )
          return raw.pins;
        throw new LocalTransferError('invalid');
      }),
    ),
    highlights: validateSection('highlights', readHostPrefix(HIGHLIGHTS_PREFIX)),
    prompts: validateSection('prompts', prompts),
  };
}

function decodeSnapshot(snapshot: StorageSnapshot, allowDivergence = false): LocalSections {
  try {
    return readSectionData(snapshot, allowDivergence);
  } catch (error) {
    if (error instanceof LocalTransferError && error.code === 'folder-diverged') throw error;
    throw new LocalTransferError('read', error);
  }
}

function makeBackup(sections: Partial<LocalSections>): LocalBackup {
  return { format: LOCAL_BACKUP_FORMAT, exportedAt: new Date().toISOString(), sections };
}

export async function exportLocalBackup(): Promise<LocalBackup> {
  return makeBackup(decodeSnapshot(await readStorage(), true));
}

export async function previewLocalImport(input: unknown): Promise<LocalImportPreview> {
  const backup = parseLocalBackup(input);
  const included = LOCAL_SECTIONS.filter((key) => key in backup.sections);
  const snapshot = await readStorage(included);
  const local = decodeSnapshot(snapshot);
  const preview = { sections: mergeLocalSections(local, backup.sections).sections };
  prepared.set(preview, { backup, snapshot });
  return preview;
}

function filterStorage(snapshot: StorageSnapshot, sections: LocalSection[]): StorageSnapshot {
  const extKeys = sections.flatMap((section) => EXT_KEYS[section] ?? []);
  const prefixes = sections.flatMap((section) => HOST_PREFIXES[section] ?? []);
  return {
    safari: snapshot.safari,
    ext: Object.fromEntries(Object.entries(snapshot.ext).filter(([key]) => extKeys.includes(key))),
    host: Object.fromEntries(
      Object.entries(snapshot.host).filter(
        ([key]) => prefixes.some((prefix) => key.startsWith(prefix)) || extKeys.includes(key),
      ),
    ),
  };
}

function buildWrites(
  snapshot: StorageSnapshot,
  original: LocalSections,
  next: LocalSections,
  selected: LocalSection[],
): { host: Map<string, string | null>; ext: Record<string, unknown> } {
  const host = new Map<string, string | null>();
  const ext: Record<string, unknown> = {};
  for (const section of selected) {
    if (canonicalJson(original[section]) === canonicalJson(next[section])) continue;
    switch (section) {
      case 'folders': {
        const key = StorageKeys.FOLDER_DATA;
        const text = JSON.stringify(next.folders);
        ext[key] = snapshot.safari ? text : next.folders;
        if (!snapshot.safari) host.set(key, text);
        break;
      }
      case 'favorites': {
        if (canonicalJson(original.favorites.shared) !== canonicalJson(next.favorites.shared)) {
          ext[StorageKeys.TIMELINE_STARRED_MESSAGES] = next.favorites.shared;
        }
        changeHostBuckets(TIMELINE_STARS_PREFIX, original.favorites.legacy, next.favorites.legacy);
        break;
      }
      case 'textPins':
        changeHostBuckets(TIMELINE_TEXT_PINS_PREFIX, original.textPins, next.textPins, (pins) =>
          JSON.stringify({ version: 1, pins }),
        );
        break;
      case 'highlights':
        changeHostBuckets(HIGHLIGHTS_PREFIX, original.highlights, next.highlights);
        break;
      case 'prompts':
        ext[StorageKeys.PROMPT_ITEMS] = next.prompts;
        break;
    }
  }
  return { host, ext };

  function changeHostBuckets<T>(
    prefix: string,
    before: Record<string, T[]>,
    after: Record<string, T[]>,
    encode: (rows: T[]) => string = JSON.stringify,
  ): void {
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) host.set(prefix + key, null);
    }
    for (const [key, rows] of Object.entries(after)) {
      if (canonicalJson(before[key]) !== canonicalJson(rows)) host.set(prefix + key, encode(rows));
    }
  }
}

function writeHost(key: string, value: string | null): void {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

async function compareAndSetFavorites(expected: unknown, next: unknown): Promise<boolean> {
  const response = await browser.runtime.sendMessage({
    type: 'gv.starred.transferCompareAndSet',
    payload: { expected: expected ?? null, next: next ?? null },
  });
  if (
    !response ||
    typeof response !== 'object' ||
    !('ok' in response) ||
    response.ok !== true ||
    !('applied' in response) ||
    typeof response.applied !== 'boolean'
  ) {
    throw new LocalTransferError('write');
  }
  return response.applied;
}

async function updateStorage(
  before: StorageSnapshot,
  writes: ReturnType<typeof buildWrites>,
  selected: LocalSection[],
): Promise<void> {
  const attemptedHost = new Map<string, string | null>();
  const starredKey = StorageKeys.TIMELINE_STARRED_MESSAGES;
  const { [starredKey]: nextFavorites, ...otherExtWrites } = writes.ext;
  const extKeys = Object.keys(otherExtWrites);
  let attemptedExt = false;
  let attemptedFavorites = false;
  const expected: StorageSnapshot = {
    host: { ...before.host },
    ext: { ...before.ext, ...writes.ext },
    safari: before.safari,
  };

  try {
    // The host API is synchronous. Check that each key is still the value
    // shown in preview before putting the new value into that key.
    for (const [key, value] of writes.host) {
      if (localStorage.getItem(key) !== (before.host[key] ?? null)) {
        throw new LocalTransferError('changed');
      }
      attemptedHost.set(key, value);
      writeHost(key, value);
      if (value === null) delete expected.host[key];
      else expected.host[key] = value;
    }
    if (extKeys.length) {
      const latest = await browser.storage.local.get(extKeys);
      for (const key of extKeys) {
        if (canonicalJson(latest[key]) !== canonicalJson(before.ext[key])) {
          throw new LocalTransferError('changed');
        }
      }
      attemptedExt = true;
      await browser.storage.local.set(otherExtWrites);
    }
    if (nextFavorites !== undefined) {
      attemptedFavorites = true;
      if (!(await compareAndSetFavorites(before.ext[starredKey], nextFavorites))) {
        attemptedFavorites = false;
        throw new LocalTransferError('changed');
      }
    }
    // A retained host prompt backup becomes inactive once prompts are in
    // extension storage. Re-read and verify every selected store.
    if (expected.ext[StorageKeys.PROMPT_ITEMS] !== undefined) {
      delete expected.host[StorageKeys.PROMPT_ITEMS];
    }
    if (canonicalJson(await readStorage(selected)) !== canonicalJson(expected)) {
      throw new LocalTransferError('changed');
    }
  } catch (error) {
    let rolledBack = true;
    for (const [key, value] of [...attemptedHost].reverse()) {
      try {
        const previous = before.host[key] ?? null;
        const current = localStorage.getItem(key);
        if (current === value) writeHost(key, previous);
        else if (current !== previous) rolledBack = false;
        if (localStorage.getItem(key) !== previous) rolledBack = false;
      } catch {
        rolledBack = false;
      }
    }
    if (attemptedExt) {
      try {
        const latest = await browser.storage.local.get(extKeys);
        const restore: Record<string, unknown> = {};
        const remove: string[] = [];
        for (const key of extKeys) {
          if (canonicalJson(latest[key]) === canonicalJson(writes.ext[key])) {
            if (before.ext[key] === undefined) remove.push(key);
            else restore[key] = before.ext[key];
          } else if (canonicalJson(latest[key]) !== canonicalJson(before.ext[key])) {
            rolledBack = false;
          }
        }
        if (Object.keys(restore).length) await browser.storage.local.set(restore);
        if (remove.length) await browser.storage.local.remove(remove);
        const verified = await browser.storage.local.get(extKeys);
        if (
          extKeys.some((key) => canonicalJson(verified[key]) !== canonicalJson(before.ext[key]))
        ) {
          rolledBack = false;
        }
      } catch {
        rolledBack = false;
      }
    }
    if (attemptedFavorites) {
      try {
        if (!(await compareAndSetFavorites(nextFavorites, before.ext[starredKey]))) {
          const current = (await browser.storage.local.get(starredKey))[starredKey];
          if (canonicalJson(current) !== canonicalJson(before.ext[starredKey])) rolledBack = false;
        }
      } catch {
        rolledBack = false;
      }
    }
    if (!rolledBack) throw new LocalTransferError('rollback', error);
    if (error instanceof LocalTransferError && error.code === 'changed') throw error;
    throw new LocalTransferError('write', error);
  }

  for (const [key, value] of attemptedHost) {
    if (key.startsWith(TIMELINE_STARS_PREFIX) || key.startsWith(TIMELINE_TEXT_PINS_PREFIX)) {
      applyTimelinePrivateStorageChange(key, value);
    }
    // Browsers only dispatch their native event in other documents.
    window.dispatchEvent(
      new StorageEvent('storage', {
        key,
        oldValue: before.host[key] ?? null,
        newValue: value,
        storageArea: localStorage,
      }),
    );
  }
}

export async function applyLocalImport(
  preview: LocalImportPreview,
  mode: 'merge' | 'replace',
  options: { sections?: LocalSection[]; saveBackup?: (backup: LocalBackup) => Promise<void> } = {},
): Promise<void> {
  const plan = prepared.get(preview);
  if (!plan || (mode !== 'merge' && mode !== 'replace')) throw new LocalTransferError('invalid');
  const { backup, snapshot } = plan;
  const requested = options.sections ?? LOCAL_SECTIONS.filter((key) => key in backup.sections);
  if (
    !requested.length ||
    requested.some((key) => !LOCAL_SECTIONS.includes(key) || !(key in backup.sections))
  ) {
    throw new LocalTransferError('invalid');
  }
  if (applying) throw new LocalTransferError('changed');
  applying = true;
  try {
    const selected = [...new Set(requested)];
    const before = await readStorage(selected);
    if (canonicalJson(before) !== canonicalJson(filterStorage(snapshot, selected))) {
      throw new LocalTransferError('changed');
    }
    const original = decodeSnapshot(before);
    const next =
      mode === 'merge'
        ? mergeLocalSections(original, backup.sections).merged
        : { ...original, ...backup.sections };
    const writes = buildWrites(before, original, next, selected);
    if (!writes.host.size && !Object.keys(writes.ext).length) {
      prepared.delete(preview);
      return;
    }

    if (mode === 'replace') {
      if (!options.saveBackup) throw new LocalTransferError('backup');
      try {
        await options.saveBackup(await exportLocalBackup());
      } catch (error) {
        if (error instanceof Error && error.message === 'changed') {
          throw new LocalTransferError('changed', error);
        }
        throw new LocalTransferError('backup', error);
      }
      if (canonicalJson(before) !== canonicalJson(await readStorage(selected))) {
        throw new LocalTransferError('changed');
      }
    }
    await updateStorage(before, writes, selected);
    prepared.delete(preview);
  } finally {
    applying = false;
  }
}
