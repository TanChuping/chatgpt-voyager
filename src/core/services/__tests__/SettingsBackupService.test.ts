import { describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import {
  BACKUPABLE_SYNC_SETTINGS_DEFAULTS,
  exportBackupableSyncSettings,
  restoreBackupableSyncSettings,
} from '../SettingsBackupService';

describe('SettingsBackupService', () => {
  it('exports only backupable sync settings with defaults applied', async () => {
    const storageArea = {
      get: vi.fn().mockResolvedValue({
        ...BACKUPABLE_SYNC_SETTINGS_DEFAULTS,
        [StorageKeys.CHAT_WIDTH]: 88,
        unknownKey: 'ignore-me',
      }),
      set: vi.fn(),
    };

    const payload = await exportBackupableSyncSettings(storageArea);

    expect(storageArea.get).toHaveBeenCalledWith(BACKUPABLE_SYNC_SETTINGS_DEFAULTS);
    expect(payload).toEqual({
      format: 'gpt-voyager.settings.v1',
      exportedAt: expect.any(String),
      version: expect.any(String),
      data: expect.objectContaining({
        [StorageKeys.CHAT_WIDTH]: 88,
        [StorageKeys.CHAT_FONT_SIZE]: 100,
        [StorageKeys.CODE_FONT_SIZE]: 100,
        [StorageKeys.PLAIN_TEXT_INPUT_ENABLED]: false,
      }),
    });
    expect(payload.data).not.toHaveProperty('unknownKey');
  });

  it('restores only whitelisted settings keys', async () => {
    const storageArea = {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue(undefined),
    };

    const restored = await restoreBackupableSyncSettings(
      {
        [StorageKeys.CHAT_WIDTH]: 92,
        [StorageKeys.PLAIN_TEXT_INPUT_ENABLED]: true,
        unknownKey: 'ignore-me',
      },
      storageArea,
    );

    expect(restored).toEqual({
      [StorageKeys.CHAT_WIDTH]: 92,
      [StorageKeys.PLAIN_TEXT_INPUT_ENABLED]: true,
    });
    expect(storageArea.set).toHaveBeenCalledWith({
      [StorageKeys.CHAT_WIDTH]: 92,
      [StorageKeys.PLAIN_TEXT_INPUT_ENABLED]: true,
    });
  });

  it('skips storage writes for invalid settings payloads', async () => {
    const storageArea = {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue(undefined),
    };

    const restored = await restoreBackupableSyncSettings(null, storageArea);

    expect(restored).toEqual({});
    expect(storageArea.set).not.toHaveBeenCalled();
  });
});
