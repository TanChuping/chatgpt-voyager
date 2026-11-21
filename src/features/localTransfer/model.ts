import type { PromptItem } from '@/features/backup/types/backup';
import type { Folder, FolderData } from '@/pages/content/folder/types';
import { HIGHLIGHT_COLORS, type TextHighlight } from '@/pages/content/textHighlights/anchors';
import type { StarredMessage, StarredMessagesData } from '@/pages/content/timeline/starredTypes';

export const LOCAL_BACKUP_FORMAT = 'gpt-voyager.local-backup.v1';
export const LOCAL_SECTIONS = [
  'folders',
  'favorites',
  'textPins',
  'highlights',
  'prompts',
] as const;
export const ROOT_FOLDER = '__root_conversations__';

export type LocalSection = (typeof LOCAL_SECTIONS)[number];

export interface TimelineTextPin {
  id: string;
  turnId: string;
  xRatio: number;
  xOffset: number;
  yRatio: number;
  yOffset: number;
  text: string;
  createdAt: number;
}

export interface LocalSections {
  folders: FolderData;
  favorites: { shared: StarredMessagesData; legacy: Record<string, string[]> };
  textPins: Record<string, TimelineTextPin[]>;
  highlights: Record<string, TextHighlight[]>;
  prompts: PromptItem[];
}

export interface LocalBackup {
  format: typeof LOCAL_BACKUP_FORMAT;
  exportedAt: string;
  accountFingerprint?: string;
  sections: Partial<LocalSections>;
}

export interface ImportCounts {
  local: number;
  incoming: number;
  duplicates: number;
  conflicts: number;
  added: number;
}

export class LocalTransferError extends Error {
  constructor(
    readonly code:
      | 'invalid'
      | 'read'
      | 'folder-diverged'
      | 'changed'
      | 'backup'
      | 'write'
      | 'rollback',
    cause?: unknown,
  ) {
    super(code, { cause });
    this.name = 'LocalTransferError';
  }
}

const reservedKeys = new Set(Object.getOwnPropertyNames(Object.prototype));
const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && !reservedKeys.has(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function validUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return ['http:', 'https:'].includes(new URL(value, 'https://chatgpt.com').protocol);
  } catch {
    return false;
  }
}

function optionalRecordFields(
  record: Record<string, unknown>,
  fields: Record<string, (value: unknown) => boolean>,
): boolean {
  return Object.entries(fields).every(
    ([key, valid]) => record[key] === undefined || valid(record[key]),
  );
}

function rows<T>(
  value: unknown,
  isRow: (value: unknown) => value is T,
  identity?: (row: T) => string,
): value is T[] {
  if (!Array.isArray(value) || !value.every(isRow)) return false;
  return !identity || new Set(value.map(identity)).size === value.length;
}

function buckets<T>(
  value: unknown,
  validate: (value: unknown, key: string) => value is T[],
): value is Record<string, T[]> {
  return (
    isObject(value) &&
    Object.entries(value).every(([key, list]) => isId(key) && validate(list, key))
  );
}

function validFolder(value: unknown): value is Folder {
  return (
    isObject(value) &&
    isId(value.id) &&
    value.id !== ROOT_FOLDER &&
    isString(value.name) &&
    (value.parentId === undefined || value.parentId === null || isId(value.parentId)) &&
    optionalRecordFields(value, {
      isExpanded: isBoolean,
      pinned: isBoolean,
      color: isString,
      sortIndex: isNumber,
      createdAt: isNumber,
      updatedAt: isNumber,
      instructions: isString,
    })
  );
}

function validFolderRef(value: unknown): value is FolderData['folderContents'][string][number] {
  return (
    isObject(value) &&
    isId(value.conversationId) &&
    isString(value.title) &&
    validUrl(value.url) &&
    optionalRecordFields(value, {
      addedAt: isNumber,
      lastOpenedAt: isNumber,
      updatedAt: isNumber,
      isGem: isBoolean,
      gemId: isString,
      starred: isBoolean,
      customTitle: isBoolean,
      sortIndex: isNumber,
    })
  );
}

function hasValidParents(folders: Folder[]): boolean {
  const ids = new Map(folders.map((folder) => [folder.id, folder]));
  const resolved = new Set<string>();
  for (const folder of folders) {
    const path = new Set<string>();
    let current: Folder | undefined = folder;
    while (current && !resolved.has(current.id)) {
      if (path.has(current.id)) return false;
      path.add(current.id);
      const parentId: string | null = current.parentId;
      current = parentId ? ids.get(parentId) : undefined;
      if (parentId && !current) return false;
    }
    for (const id of path) resolved.add(id);
  }
  return true;
}

function validFolders(value: unknown): value is FolderData {
  if (
    !isObject(value) ||
    !rows(value.folders, validFolder, (item) => item.id) ||
    !buckets(value.folderContents, (list): list is FolderData['folderContents'][string] =>
      rows(list, validFolderRef, (item) => item.conversationId),
    )
  )
    return false;
  const ids = new Set(value.folders.map((folder) => folder.id));
  return (
    Object.keys(value.folderContents).every((key) => key === ROOT_FOLDER || ids.has(key)) &&
    hasValidParents(value.folders)
  );
}

function validStar(value: unknown): value is StarredMessage {
  return (
    isObject(value) &&
    isId(value.turnId) &&
    isId(value.conversationId) &&
    isString(value.content) &&
    validUrl(value.conversationUrl) &&
    isNumber(value.starredAt) &&
    optionalRecordFields(value, { conversationTitle: isString })
  );
}

function validFavorites(value: unknown): value is LocalSections['favorites'] {
  return (
    isObject(value) &&
    isTransferStarredData(value.shared) &&
    buckets(value.legacy, (list): list is string[] => rows(list, isString))
  );
}

export function isTransferStarredData(value: unknown): value is StarredMessagesData {
  return (
    isObject(value) &&
    buckets(
      value.messages,
      (list, key): list is StarredMessage[] =>
        rows(list, validStar) && list.every((item) => item.conversationId === key),
    )
  );
}

function validTextPin(value: unknown): value is TimelineTextPin {
  return (
    isObject(value) &&
    isId(value.id) &&
    isId(value.turnId) &&
    optionalRecordFields(value, {
      text: isString,
      xRatio: isNumber,
      xOffset: isNumber,
      yRatio: isNumber,
      yOffset: isNumber,
      createdAt: isNumber,
    })
  );
}

function validHighlight(value: unknown): value is TextHighlight {
  return (
    isObject(value) &&
    isId(value.id) &&
    isId(value.messageId) &&
    isNumber(value.start) &&
    Number.isSafeInteger(value.start) &&
    value.start >= 0 &&
    isString(value.quote) &&
    !!value.quote.trim() &&
    value.end === value.start + value.quote.length &&
    HIGHLIGHT_COLORS.some((color) => color === value.color) &&
    isString(value.note) &&
    isNumber(value.updatedAt)
  );
}

function validPrompt(value: unknown): value is PromptItem {
  return (
    isObject(value) &&
    isId(value.id) &&
    isString(value.text) &&
    !!value.text.trim() &&
    rows(value.tags, isString) &&
    optionalRecordFields(value, { name: isString, createdAt: isNumber, updatedAt: isNumber })
  );
}

const validators: { [K in LocalSection]: (value: unknown) => value is LocalSections[K] } = {
  folders: validFolders,
  favorites: validFavorites,
  textPins: (value): value is LocalSections['textPins'] =>
    buckets(value, (list): list is TimelineTextPin[] => rows(list, validTextPin)),
  highlights: (value): value is LocalSections['highlights'] =>
    buckets(value, (list): list is TextHighlight[] => rows(list, validHighlight)),
  prompts: (value): value is LocalSections['prompts'] => rows(value, validPrompt),
};

export function validateSection<K extends LocalSection>(
  section: K,
  value: unknown,
): LocalSections[K] {
  if (!validators[section](value)) throw new LocalTransferError('invalid');
  return value as LocalSections[K];
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new LocalTransferError('invalid', error);
  }
}

export function parseLocalBackup(input: unknown): LocalBackup {
  // The caller may have parsed the file already. Keep the preview immutable to
  // the caller and apply exactly the validated view even if it changes later.
  const value = typeof input === 'string' ? parseJson(input) : input;
  if (
    !isObject(value) ||
    value.format !== LOCAL_BACKUP_FORMAT ||
    typeof value.exportedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.exportedAt)) ||
    (value.accountFingerprint !== undefined && typeof value.accountFingerprint !== 'string') ||
    !isObject(value.sections)
  )
    throw new LocalTransferError('invalid');

  const sections = Object.keys(value.sections);
  if (!sections.length || sections.some((key) => !LOCAL_SECTIONS.includes(key as LocalSection))) {
    throw new LocalTransferError('invalid');
  }
  for (const key of sections as LocalSection[]) validateSection(key, value.sections[key]);
  return structuredClone(value) as unknown as LocalBackup;
}

export function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, entry: unknown) => {
      if (!isObject(entry)) return entry;
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, entry[key]]),
      );
    }) ?? ''
  );
}
