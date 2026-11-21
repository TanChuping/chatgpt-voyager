import { EXTENSION_VERSION } from '@/core/utils/version';

import {
  LOCAL_BACKUP_FORMAT,
  type LocalBackup,
  type LocalSections,
  parseLocalBackup,
  validateSection,
} from './model';

const FOLDERS_FORMAT = 'gemini-voyager.folders.v1';
const PROMPTS_FORMAT = 'gemini-voyager.prompts.v1';
const ORIGIN = 'https://chatgpt.com';
const FOLDER_ID_PREFIX = 'chatgpt:conv:';

export const VOYAGER_EXPORT_SECTIONS = ['folders', 'prompts'] as const;
export type VoyagerExportSection = (typeof VOYAGER_EXPORT_SECTIONS)[number];

export class VoyagerFormatError extends Error {
  constructor(readonly reason: 'stars' | 'highlights' | 'wrong-site' | 'invalid') {
    super(reason);
    this.name = 'VoyagerFormatError';
  }
}

function translateFolders(
  data: LocalSections['folders'],
  direction: 'import' | 'export',
): LocalSections['folders'] {
  const folderContents = Object.fromEntries(
    Object.entries(data.folderContents).map(([folderId, rows]) => [
      folderId,
      rows.map((row) => {
        let source: URL;
        try {
          source = new URL(row.url, ORIGIN);
        } catch {
          throw new VoyagerFormatError('wrong-site');
        }
        const acceptedOrigin =
          source.origin === ORIGIN ||
          (direction === 'export' && source.origin === 'https://chat.openai.com');
        const route = /^(?:\/u\/[^/]+)?(?:\/g\/[^/]+)?\/c\/([^/?#]+)/.exec(source.pathname);
        if (!acceptedOrigin || source.username || source.password || !route) {
          throw new VoyagerFormatError('wrong-site');
        }
        const bareId = route[1];
        const localId = bareId.replace(/^c_/i, '');
        const voyagerId = FOLDER_ID_PREFIX + bareId;
        const expected = direction === 'import' ? voyagerId : localId;
        const actual =
          direction === 'import' ? row.conversationId : row.conversationId.replace(/^c_/i, '');
        if (expected !== actual || (direction === 'import' && !row.url.startsWith(ORIGIN + '/'))) {
          throw new VoyagerFormatError('wrong-site');
        }
        return {
          ...row,
          conversationId: direction === 'import' ? localId : voyagerId,
          url: ORIGIN + route[0],
        };
      }),
    ]),
  );
  return validateSection('folders', { folders: data.folders, folderContents });
}

/** Read the upstream manual file envelopes before the standard local preview/merge. */
export function readVoyagerBackup(raw: unknown): LocalBackup | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (input.format === 'gemini-voyager.stars.v2' || input.format === 'gemini-voyager.starred.v1') {
    throw new VoyagerFormatError('stars');
  }
  if (input.format === 'gemini-voyager.annotations.v1') {
    throw new VoyagerFormatError('highlights');
  }
  if (input.format !== FOLDERS_FORMAT && input.format !== PROMPTS_FORMAT) return null;
  if (input.format === FOLDERS_FORMAT && input.platform !== 'chatgpt') {
    throw new VoyagerFormatError('wrong-site');
  }
  try {
    const sections =
      input.format === FOLDERS_FORMAT
        ? { folders: translateFolders(validateSection('folders', input.data), 'import') }
        : { prompts: validateSection('prompts', input.items) };
    return parseLocalBackup({
      format: LOCAL_BACKUP_FORMAT,
      exportedAt: input.exportedAt,
      sections,
    });
  } catch (error) {
    if (error instanceof VoyagerFormatError) throw error;
    throw new VoyagerFormatError('invalid');
  }
}

/** Generate files accepted by the upstream ChatGPT folder panel or the Prompt Manager. */
export function exportVoyagerBackup(section: VoyagerExportSection, backup: LocalBackup) {
  const common = { exportedAt: backup.exportedAt, version: EXTENSION_VERSION };
  const stamp = new Date(backup.exportedAt)
    .toISOString()
    .replace(/[-:]/g, '')
    .slice(0, 15)
    .replace('T', '-');
  if (section === 'folders') {
    return {
      filename: `voyager-chatgpt-folders-${stamp}.json`,
      payload: {
        ...common,
        format: FOLDERS_FORMAT,
        platform: 'chatgpt',
        data: translateFolders(validateSection('folders', backup.sections.folders), 'export'),
      },
    };
  }
  const items = validateSection('prompts', backup.sections.prompts);
  if (items.length === 0) throw new VoyagerFormatError('invalid');
  return {
    filename: `gemini-voyager-prompts-${stamp}.json`,
    payload: { ...common, format: PROMPTS_FORMAT, items },
  };
}
