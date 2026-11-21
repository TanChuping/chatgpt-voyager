import { accountMatch, currentAccountFingerprint } from './account';
import { applyLocalImport, exportLocalBackup, previewLocalImport } from './data';
import {
  LOCAL_BACKUP_FORMAT,
  LOCAL_SECTIONS,
  type LocalBackup,
  type LocalSection,
  canonicalJson,
} from './model';
import { exportVoyagerBackup, readVoyagerBackup } from './voyager';

type Request = {
  action: string;
  file?: unknown;
  mode?: 'merge' | 'replace';
  sections?: LocalSection[];
  format?: string;
  token?: string;
};
export async function nativeExport(backup?: LocalBackup) {
  backup ??= await exportLocalBackup();
  const fingerprint = await currentAccountFingerprint();
  return {
    filename: 'GPT-Voyager-' + new Date().toISOString().slice(0, 10) + '.json',
    payload: fingerprint ? { ...backup, accountFingerprint: fingerprint } : backup,
  };
}

export function createTransferHost(_port: chrome.runtime.Port) {
  let preview: Awaited<ReturnType<typeof previewLocalImport>> | null = null;
  let source: unknown = null;
  let accountAtPreview: string | null = null;
  let recovery: { token: string; backup: LocalBackup } | null = null;
  let closed = false;
  function assertOpen() {
    if (closed) throw new Error('changed');
  }
  async function account() {
    const current = await currentAccountFingerprint();
    assertOpen();
    if (preview && current !== accountAtPreview) throw new Error('changed');
    accountMatch(source, current);
    return current;
  }
  async function taggedBackup() {
    const current = await account();
    const backup = await exportLocalBackup();
    return current ? { ...backup, accountFingerprint: current } : backup;
  }
  async function run(request: Request) {
    assertOpen();
    if (request.action === 'export') {
      const backup = await exportLocalBackup();
      if (request.format === 'folders' || request.format === 'prompts')
        return exportVoyagerBackup(request.format, backup);
      if (request.format !== 'native') throw new Error('invalid');
      return nativeExport(backup);
    }
    if (request.action === 'preview') {
      preview = null;
      recovery = null;
      source = null;
      const raw = request.file as Record<string, unknown> | null;
      if (!raw || typeof raw !== 'object') throw new Error('invalid');
      let converted;
      try {
        converted = raw.format === LOCAL_BACKUP_FORMAT ? null : readVoyagerBackup(raw);
      } catch (e) {
        throw new Error(
          (e as { reason?: string }).reason === 'wrong-site'
            ? 'wrong-site'
            : ['stars', 'highlights'].includes((e as { reason: string }).reason)
              ? 'unsupported'
              : 'invalid',
        );
      }
      source = raw.format === LOCAL_BACKUP_FORMAT ? raw.accountFingerprint : null;
      accountAtPreview = await currentAccountFingerprint();
      const match = accountMatch(source, accountAtPreview);
      preview = await previewLocalImport(converted ?? raw);
      return { sections: preview.sections, match };
    }
    if (!preview) throw new Error('changed');
    if (request.action === 'recovery') {
      const backup = await taggedBackup();
      recovery = { token: crypto.randomUUID(), backup };
      return recovery;
    }
    if (
      request.action !== 'apply' ||
      !['merge', 'replace'].includes(request.mode ?? '') ||
      !request.sections?.length ||
      !request.sections.every((s) => LOCAL_SECTIONS.includes(s) && !!preview?.sections[s])
    )
      throw new Error('invalid');
    const plan = preview;
    const commit = async () => {
      await account();
      await applyLocalImport(plan, request.mode!, {
        sections: request.sections,
        saveBackup: async (latest) => {
          assertOpen();
          if (
            !recovery ||
            recovery.token !== request.token ||
            canonicalJson(latest.sections) !== canonicalJson(recovery.backup.sections)
          )
            throw new Error('changed');
        },
      });
      preview = null;
      recovery = null;
      return null;
    };
    return navigator.locks
      ? navigator.locks.request('gpt-voyager.manual-import', commit)
      : commit();
  }
  return {
    run,
    dispose() {
      closed = true;
      preview = null;
      recovery = null;
    },
  };
}
