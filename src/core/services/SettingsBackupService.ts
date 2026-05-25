import { StorageKeys } from '@/core/types/common';
import type { SettingsExportPayload } from '@/core/types/sync';
import { EXTENSION_VERSION } from '@/core/utils/version';

export type BackupableSyncSettings = Record<string, unknown>;

type StorageAreaLike = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

const DEFAULT_TIMELINE_SHORTCUTS = {
  shortcuts: {
    previous: {
      action: 'timeline:previous',
      modifiers: [],
      key: 'k',
    },
    next: {
      action: 'timeline:next',
      modifiers: [],
      key: 'j',
    },
    first: {
      action: 'timeline:first',
      modifiers: [],
      key: 'g',
      sequenceLength: 2,
    },
    last: {
      action: 'timeline:last',
      modifiers: ['Shift'],
      key: 'G',
      sequenceLength: 2,
    },
  },
  enabled: true,
} as const;

export const BACKUPABLE_SYNC_SETTINGS_DEFAULTS: Record<string, unknown> = {
  [StorageKeys.TIMELINE_SCROLL_MODE]: 'flow',
  [StorageKeys.TIMELINE_HIDE_CONTAINER]: false,
  [StorageKeys.TIMELINE_BAR_WIDTH]: null,
  [StorageKeys.TIMELINE_DRAGGABLE]: false,
  [StorageKeys.TIMELINE_POSITION]: null,
  [StorageKeys.TIMELINE_PREVIEW_PINNED]: false,
  [StorageKeys.TIMELINE_MARKER_LEVEL]: false,
  [StorageKeys.TIMELINE_SHORTCUTS]: DEFAULT_TIMELINE_SHORTCUTS,
  [StorageKeys.CHAT_WIDTH]: 70,
  [StorageKeys.CHAT_WIDTH_ENABLED]: false,
  [StorageKeys.CHAT_FONT_SIZE]: 100,
  [StorageKeys.CHAT_FONT_SIZE_ENABLED]: false,
  [StorageKeys.CODE_FONT_SIZE]: 100,
  [StorageKeys.CODE_FONT_SIZE_ENABLED]: false,
  [StorageKeys.EDIT_INPUT_WIDTH]: 60,
  [StorageKeys.EDIT_INPUT_WIDTH_ENABLED]: false,
  [StorageKeys.SIDEBAR_WIDTH]: 312,
  [StorageKeys.SIDEBAR_WIDTH_ENABLED]: false,
  [StorageKeys.PROMPT_PANEL_LOCKED]: false,
  [StorageKeys.PROMPT_PANEL_POSITION]: null,
  [StorageKeys.PROMPT_TRIGGER_POSITION]: null,
  [StorageKeys.PROMPT_CUSTOM_WEBSITES]: [],
  [StorageKeys.PROMPT_THEME]: null,
  [StorageKeys.PROMPT_VIEW_MODE]: 'compact',
  [StorageKeys.LANGUAGE]: null,
  [StorageKeys.FORMULA_COPY_FORMAT]: 'latex',
  [StorageKeys.HIDE_PROMPT_MANAGER]: false,
  [StorageKeys.MERMAID_ENABLED]: true,
  [StorageKeys.QUOTE_REPLY_ENABLED]: true,
  [StorageKeys.CTRL_ENTER_SEND]: false,
  [StorageKeys.SAFARI_ENTER_FIX]: false,
  [StorageKeys.INPUT_COLLAPSE_ENABLED]: false,
  [StorageKeys.INPUT_COLLAPSE_WHEN_NOT_EMPTY]: false,
  [StorageKeys.DRAFT_AUTO_SAVE]: false,
  [StorageKeys.PREVENT_AUTO_SCROLL_ENABLED]: false,
  [StorageKeys.GV_SIDEBAR_AUTO_HIDE]: false,
  [StorageKeys.GV_SIDEBAR_FULL_HIDE]: false,
  [StorageKeys.GV_FOLDER_SPACING]: 2,
  [StorageKeys.GV_FOLDER_TREE_INDENT]: -8,
  [StorageKeys.FORK_ENABLED]: false,
  [StorageKeys.GV_SHOW_MESSAGE_TIMESTAMPS]: false,
  [StorageKeys.GV_POPUP_SECTION_ORDER]: null,
  [StorageKeys.FOLDER_ENABLED]: true,
  [StorageKeys.FOLDER_HIDE_ARCHIVED_CONVERSATIONS]: false,
  [StorageKeys.SINGLE_CONV_EXPORT_FORMAT]: 'markdown',
  // Chat font family — preset selection only. The custom font bytes
  // (`CHAT_CUSTOM_FONT_DATA`) deliberately live in chrome.storage.local
  // and are NOT round-tripped through settings backup: they can be
  // multi-MB and we don't want to bloat the exported JSON.
  [StorageKeys.CHAT_FONT_FAMILY_ENABLED]: false,
  [StorageKeys.CHAT_FONT_FAMILY]: 'default',
  [StorageKeys.CHAT_CUSTOM_FONT_NAME]: '',
  [StorageKeys.CHAT_CUSTOM_FONT_FORMAT]: '',
};

export const BACKUPABLE_SYNC_SETTINGS_KEYS = Object.keys(BACKUPABLE_SYNC_SETTINGS_DEFAULTS);

function getStorageArea(storageArea?: StorageAreaLike): StorageAreaLike {
  if (storageArea) {
    return storageArea;
  }

  if (typeof chrome !== 'undefined' && chrome.storage?.sync) {
    return chrome.storage.sync;
  }

  return {
    get: async (keys?: unknown) =>
      typeof keys === 'object' && keys !== null ? (keys as Record<string, unknown>) : {},
    set: async () => undefined,
  } as StorageAreaLike;
}

export function filterBackupableSyncSettings(value: unknown): BackupableSyncSettings {
  if (typeof value !== 'object' || value === null) {
    return {};
  }

  const record = value as Record<string, unknown>;
  return BACKUPABLE_SYNC_SETTINGS_KEYS.reduce<BackupableSyncSettings>((acc, key) => {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      acc[key] = record[key];
    }
    return acc;
  }, {});
}

export async function loadBackupableSyncSettings(
  storageArea?: StorageAreaLike,
): Promise<BackupableSyncSettings> {
  const area = getStorageArea(storageArea);
  const result = await area.get(BACKUPABLE_SYNC_SETTINGS_DEFAULTS);
  return filterBackupableSyncSettings(result);
}

export async function exportBackupableSyncSettings(
  storageArea?: StorageAreaLike,
): Promise<SettingsExportPayload> {
  return {
    format: 'gpt-voyager.settings.v1',
    exportedAt: new Date().toISOString(),
    version: EXTENSION_VERSION,
    data: await loadBackupableSyncSettings(storageArea),
  };
}

export async function restoreBackupableSyncSettings(
  settings: unknown,
  storageArea?: StorageAreaLike,
): Promise<BackupableSyncSettings> {
  const filtered = filterBackupableSyncSettings(settings);
  if (Object.keys(filtered).length === 0) {
    return filtered;
  }

  const area = getStorageArea(storageArea);
  await area.set(filtered);
  return filtered;
}
