import { describe, expect, it } from 'vitest';

import { LOCAL_BACKUP_FORMAT } from './model';
import { exportVoyagerBackup, readVoyagerBackup } from './voyager';

const exportedAt = '2026-01-02T03:04:05.000Z';
const folderId = '__root_conversations__';
const chatgptFolderFile = {
  format: 'gemini-voyager.folders.v1',
  exportedAt,
  version: '2.0.0',
  platform: 'chatgpt',
  data: {
    folders: [],
    folderContents: {
      [folderId]: [
        {
          conversationId: 'chatgpt:conv:abc123',
          title: 'Notes',
          url: 'https://chatgpt.com/u/1/g/g-p-test/c/abc123',
          addedAt: 1700000000000,
          sortIndex: 0,
          starred: true,
          customTitle: true,
        },
      ],
    },
  },
};

describe('Voyager manual files', () => {
  it('maps the upstream namespace to local bare IDs and preserves the project route and folder metadata', () => {
    const imported = readVoyagerBackup(chatgptFolderFile)!;
    expect(imported.sections.folders?.folderContents[folderId][0]).toEqual({
      ...chatgptFolderFile.data.folderContents[folderId][0],
      conversationId: 'abc123',
    });
    const exported = exportVoyagerBackup('folders', imported);
    expect(exported.filename).toBe('voyager-chatgpt-folders-20260102-030405.json');
    expect(exported.payload).toEqual({
      ...chatgptFolderFile,
      version: expect.any(String),
    });
  });

  it('rejects a wrong-site platform or mismatched folder conversation', () => {
    expect(() => readVoyagerBackup({ ...chatgptFolderFile, platform: 'gemini' })).toThrow(
      expect.objectContaining({ reason: 'wrong-site' }),
    );
    const file = structuredClone(chatgptFolderFile);
    file.data.folderContents[folderId][0].url = 'https://chatgpt.com/c/other';
    expect(() => readVoyagerBackup(file)).toThrow(
      expect.objectContaining({ reason: 'wrong-site' }),
    );
  });

  it('round-trips a named prompt and leaves other sections absent', () => {
    const items = [
      { id: 'prompt-1', text: 'Write an outline', name: 'Outline', tags: ['work'], createdAt: 2 },
    ];
    const file = { format: 'gemini-voyager.prompts.v1', exportedAt, version: '2.0.0', items };
    const imported = readVoyagerBackup(file)!;
    expect(imported).toEqual({
      format: LOCAL_BACKUP_FORMAT,
      exportedAt,
      sections: { prompts: items },
    });
    expect(exportVoyagerBackup('prompts', imported).payload).toEqual({
      ...file,
      version: expect.any(String),
    });
  });

  it('recognizes incompatible annotations and catalog stars without treating them as local data', () => {
    expect(() => readVoyagerBackup({ format: 'gemini-voyager.stars.v2' })).toThrow(
      expect.objectContaining({ reason: 'stars' }),
    );
    expect(() => readVoyagerBackup({ format: 'gemini-voyager.annotations.v1' })).toThrow(
      expect.objectContaining({ reason: 'highlights' }),
    );
    expect(readVoyagerBackup({ format: 'unknown' })).toBeNull();
  });
});
