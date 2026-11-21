import { JSDOM } from 'jsdom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import {
  LOCAL_BACKUP_FORMAT,
  type LocalSections,
  applyLocalImport,
  exportLocalBackup,
  previewLocalImport,
} from '../data';

const extension = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), remove: vi.fn() }));
const sendMessage = vi.hoisted(() => vi.fn());
vi.mock('webextension-polyfill', () => ({
  default: { storage: { local: extension }, runtime: { sendMessage } },
}));

const folderKey = StorageKeys.FOLDER_DATA;
const promptsKey = StorageKeys.PROMPT_ITEMS;
const highlightKey = 'gptTextHighlights:chat';
const pinKey = 'gptTimelineTextPins:chat';
const starKey = 'gptTimelineStars:chat';
const sharedKey = StorageKeys.TIMELINE_STARRED_MESSAGES;
const sender = {
  id: chrome.runtime.id,
  frameId: 0,
  tab: { id: 1 },
  url: 'https://chatgpt.com/c/chat',
};
type Listener = (message: unknown, sender: unknown, respond: (response: unknown) => void) => void;
let backgroundListener: Listener;
let extensionData: Record<string, unknown>;
let dom: JSDOM;

const file = (sections: Partial<LocalSections>) => ({
  format: LOCAL_BACKUP_FORMAT,
  exportedAt: '2026-01-01T00:00:00.000Z',
  sections,
});
const titleFolder = (id: string, name: string, parentId: string | null = null) => ({
  id,
  name,
  parentId,
  isExpanded: true,
  createdAt: 1,
  updatedAt: 1,
});
const reference = (title: string) => ({
  title,
  conversationId: 'chat',
  url: '/c/chat',
  addedAt: 1,
});
const prompt = (text: string) => ({ id: 'id', text, tags: [], createdAt: 1 });
const mark = (note: string) => ({
  id: 'm',
  messageId: 'turn',
  start: 4,
  end: 9,
  quote: 'hello',
  color: 'yellow' as const,
  note,
  updatedAt: 1,
});
const star = (turnId: string) => ({
  turnId,
  conversationId: 'chat',
  conversationUrl: 'https://chatgpt.com/c/chat',
  content: 'message',
  starredAt: 1,
});
const favorites = {
  shared: { messages: { chat: [star('imported')] } },
  legacy: { chat: ['imported'] },
};

const sendToBackground = (message: unknown, from = sender) =>
  new Promise((resolve) => backgroundListener(message, from, resolve));

beforeAll(async () => {
  Object.assign(chrome.runtime, {
    getManifest: () => ({}),
    onMessage: {
      addListener: (listener: Listener) => {
        backgroundListener = listener;
      },
    },
  });
  Object.assign(chrome, {
    permissions: { onAdded: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
  });
  Object.assign(chrome.storage.local, extension);
  await import('@/pages/background/index');
});

beforeEach(() => {
  dom = new JSDOM('', { url: 'https://chatgpt.com' });
  vi.stubGlobal('localStorage', dom.window.localStorage);
  vi.stubGlobal('StorageEvent', dom.window.StorageEvent);
  // A StorageEvent from this JSDOM realm needs the matching window.
  vi.stubGlobal('window', dom.window);
  extensionData = {};
  extension.get.mockReset().mockImplementation(async (keys: string[] | string) =>
    structuredClone(
      Object.fromEntries(
        [keys]
          .flat()
          .filter((key) => key in extensionData)
          .map((key) => [key, extensionData[key]]),
      ),
    ),
  );
  extension.set.mockReset().mockImplementation(async (values: Record<string, unknown>) => {
    Object.assign(extensionData, structuredClone(values));
  });
  extension.remove.mockReset().mockImplementation(async (keys: string[] | string) => {
    for (const key of [keys].flat()) delete extensionData[key];
  });
  sendMessage.mockReset().mockImplementation(sendToBackground);
});

afterEach(() => {
  vi.unstubAllGlobals();
  dom.window.close();
});

describe('manual local transfer', () => {
  it('queues a shared favorites compare-and-set behind a pending interactive add', async () => {
    const preview = await previewLocalImport(file({ favorites }));
    const addEntered = Promise.withResolvers<void>();
    const releaseAdd = Promise.withResolvers<void>();
    const importQueued = Promise.withResolvers<void>();
    extension.set.mockImplementationOnce(async (values: Record<string, unknown>) => {
      addEntered.resolve();
      await releaseAdd.promise;
      Object.assign(extensionData, values);
    });
    sendMessage.mockImplementationOnce((request) => {
      importQueued.resolve();
      return sendToBackground(request);
    });
    const added = sendToBackground({ type: 'gv.starred.add', payload: star('interactive') });
    await addEntered.promise;
    const merge = applyLocalImport(preview, 'merge');
    const rejected = expect(merge).rejects.toMatchObject({ code: 'changed' });
    await importQueued.promise;
    releaseAdd.resolve();
    await expect(added).resolves.toMatchObject({ added: true });
    await rejected;
    expect(extensionData[sharedKey]).toEqual({ messages: { chat: [star('interactive')] } });
    expect(localStorage.getItem(starKey)).toBeNull();
  });

  it('rejects other senders and rolls back a verified write to a previously absent favorites key', async () => {
    const request = {
      type: 'gv.starred.transferCompareAndSet',
      payload: { expected: null, next: favorites.shared },
    };
    await expect(sendToBackground(request, { ...sender, frameId: 1 })).resolves.toMatchObject({
      ok: false,
    });
    await expect(sendToBackground(request, { ...sender, id: 'other' })).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      sendToBackground(request, { ...sender, url: 'https://example.com' }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      sendToBackground({
        ...request,
        payload: { expected: null, next: { messages: { chat: [{}] } } },
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(extension.set).not.toHaveBeenCalled();

    const preview = await previewLocalImport(file({ favorites }));
    sendMessage.mockImplementationOnce(async (query) => {
      const response = await sendToBackground(query);
      extension.get.mockRejectedValueOnce(new Error('Failed to read back imported storage'));
      return response;
    });
    await expect(applyLocalImport(preview, 'merge')).rejects.toMatchObject({ code: 'write' });
    expect(extension.remove).toHaveBeenCalledWith(sharedKey);
    expect(extensionData[sharedKey]).toBeUndefined();
    expect(localStorage.getItem(starKey)).toBeNull();
  });

  it('reads only user data in their live stores and understands legacy pin arrays', async () => {
    const folders = { folders: [titleFolder('f', 'Folder')], folderContents: {} };
    localStorage.setItem(folderKey, JSON.stringify(folders));
    localStorage.setItem(promptsKey, JSON.stringify([prompt('stale host mirror')]));
    localStorage.setItem(highlightKey, JSON.stringify([mark('note')]));
    localStorage.setItem(pinKey, JSON.stringify([{ id: 'p', turnId: 'turn' }]));
    localStorage.setItem(starKey, JSON.stringify(['turn']));
    localStorage.setItem('gptTimelineTurnTextCache:chat', JSON.stringify(['cached message']));
    extensionData[promptsKey] = [prompt('actual')];
    extensionData.unrelated = true;
    const backup = await exportLocalBackup();
    expect(backup.sections).toEqual({
      folders,
      prompts: [prompt('actual')],
      textPins: { chat: [{ id: 'p', turnId: 'turn' }] },
      highlights: { chat: [mark('note')] },
      favorites: { shared: { messages: {} }, legacy: { chat: ['turn'] } },
    });
    expect(extension.set).not.toHaveBeenCalled();
  });

  it('reports and preserves conflicting notes and folder memberships without duplicating repeats', async () => {
    const parent = titleFolder('f', 'Parent');
    const original = { folders: [parent], folderContents: { f: [reference('local')] } };
    localStorage.setItem(folderKey, JSON.stringify(original));
    extensionData[folderKey] = original;
    localStorage.setItem(highlightKey, JSON.stringify([mark('local')]));
    const input = file({
      folders: {
        folders: [titleFolder('child', 'Child', 'f'), parent],
        folderContents: { f: [reference('incoming')] },
      },
      highlights: { chat: [mark('incoming')] },
    });
    const preview = await previewLocalImport(input);
    expect(preview.sections.highlights).toEqual({
      local: 1,
      incoming: 1,
      duplicates: 0,
      conflicts: 1,
      added: 0,
    });
    expect(preview.sections.folders).toMatchObject({ conflicts: 2, added: 1 });
    await applyLocalImport(preview, 'merge');
    const merged = (await exportLocalBackup()).sections;
    const copy = merged.folders!.folders.find(({ name, id }) => name === 'Parent' && id !== 'f')!;
    expect(merged.folders?.folders.find(({ id }) => id === 'child')?.parentId).toBe(copy.id);
    expect(merged.folders?.folderContents).toEqual({
      f: [reference('local')],
      [copy.id]: [reference('incoming')],
    });
    expect(merged.highlights?.chat.map(({ note }) => note)).toEqual(['local', 'incoming']);
    expect(new Set(merged.highlights?.chat.map(({ id }) => id)).size).toBe(2);

    const repeated = await previewLocalImport(input);
    expect(repeated.sections.folders).toMatchObject({ duplicates: 3, conflicts: 0, added: 0 });
    expect(repeated.sections.highlights).toMatchObject({ duplicates: 1, conflicts: 0, added: 0 });
    await applyLocalImport(repeated, 'merge');
    expect((await exportLocalBackup()).sections).toEqual(merged);
  });

  it('rejects corrupt input and changes made after preview', async () => {
    expect(await previewLocalImport(file({ highlights: { chat: [mark('test')] } }))).toBeDefined();
    await expect(
      previewLocalImport(file({ highlights: { chat: [{ ...mark('bad'), end: 99 }] } })),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      previewLocalImport(
        file({
          folders: { folders: [titleFolder('f', 'Cycle', 'f')], folderContents: {} },
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
    const preview = await previewLocalImport(file({ prompts: [prompt('incoming')] }));
    extensionData[promptsKey] = [prompt('changed after preview')];
    await expect(applyLocalImport(preview, 'merge')).rejects.toMatchObject({ code: 'changed' });
    expect(extension.set).not.toHaveBeenCalled();
  });

  it('keeps the existing folder and link when only expansion and visit metadata differ', async () => {
    const parent = { ...titleFolder('f', 'Folder'), sortIndex: 1 };
    const link = { ...reference('Same link'), lastOpenedAt: 40, updatedAt: 30, sortIndex: 1 };
    const local = { folders: [parent], folderContents: { f: [link] } };
    extensionData[folderKey] = local;
    localStorage.setItem(folderKey, JSON.stringify(local));
    const preview = await previewLocalImport(
      file({
        folders: {
          folders: [{ ...titleFolder('f', 'Folder'), isExpanded: false, updatedAt: 50 }],
          folderContents: { f: [{ ...reference('Same link'), lastOpenedAt: 50 }] },
        },
      }),
    );
    expect(preview.sections.folders).toEqual({
      local: 2,
      incoming: 2,
      duplicates: 2,
      conflicts: 0,
      added: 0,
    });
    await applyLocalImport(preview, 'merge');
    expect(extension.set).not.toHaveBeenCalled();
    expect((await exportLocalBackup()).sections.folders).toEqual(local);
  });

  it('exports divergent folder mirrors without allowing overwrite', async () => {
    extensionData[folderKey] = { folders: [titleFolder('ext', 'Extension')], folderContents: {} };
    localStorage.setItem(
      folderKey,
      JSON.stringify({
        folders: [titleFolder('host', 'Host')],
        folderContents: {},
      }),
    );
    const backup = await exportLocalBackup();
    expect(backup.sections.folders?.folders.map(({ id }) => id)).toEqual(['ext', 'host']);
    await expect(previewLocalImport(backup)).rejects.toMatchObject({ code: 'folder-diverged' });
    expect(extension.set).not.toHaveBeenCalled();
  });

  it('requires a pre-write backup and replaces only the selected present sections', async () => {
    extensionData[promptsKey] = [prompt('original')];
    localStorage.setItem(highlightKey, JSON.stringify([mark('keep')]));
    const preview = await previewLocalImport(file({ prompts: [], highlights: {} }));
    await expect(applyLocalImport(preview, 'replace')).rejects.toMatchObject({ code: 'backup' });
    const saveBackup = vi.fn(async (backup) => {
      expect(extensionData[promptsKey]).toEqual([prompt('original')]);
      expect(backup.sections.prompts).toEqual([prompt('original')]);
      expect(backup.sections.highlights).toEqual({ chat: [mark('keep')] });
    });
    await applyLocalImport(preview, 'replace', { sections: ['prompts'], saveBackup });
    expect(saveBackup).toHaveBeenCalledOnce();
    expect(extensionData[promptsKey]).toEqual([]);
    expect(JSON.parse(localStorage.getItem(highlightKey)!)).toEqual([mark('keep')]);
  });

  it('restores host and extension keys if an extension write partially fails', async () => {
    const old = JSON.stringify([mark('local')]);
    localStorage.setItem(highlightKey, old);
    const preview = await previewLocalImport(
      file({
        prompts: [prompt('incoming')],
        highlights: { chat: [mark('incoming')] },
      }),
    );
    extension.set.mockImplementationOnce(async (values: Record<string, unknown>) => {
      Object.assign(extensionData, values);
      throw new Error('write failed');
    });
    await expect(applyLocalImport(preview, 'merge')).rejects.toMatchObject({ code: 'write' });
    expect(extensionData[promptsKey]).toBeUndefined();
    expect(localStorage.getItem(highlightKey)).toBe(old);
  });
});
