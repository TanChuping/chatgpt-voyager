import React, { useEffect, useRef, useState } from 'react';

import { downloadJson } from '@/features/localTransfer/download';
import {
  LOCAL_SECTIONS,
  type LocalBackup,
  type LocalSection,
} from '@/features/localTransfer/model';
import type { TranslationKey } from '@/utils/translations';

import { useLanguage } from '../../contexts/LanguageContext';
import { connectTransfer, recoveryCopy } from './transferClient';

type Stats = {
  local: number;
  incoming: number;
  duplicates: number;
  conflicts: number;
  added: number;
};
type Preview = { sections: Partial<Record<LocalSection, Stats>>; match: 'matched' | 'unknown' };
const names: Record<LocalSection, TranslationKey> = {
  folders: 'folder_title',
  favorites: 'favoritesSidebarTitle',
  textPins: 'transferPins',
  highlights: 'textHighlights',
  prompts: 'transferPrompts',
};
const errors: Record<string, TranslationKey> = {
  'account-mismatch': 'transferMismatch',
  'wrong-site': 'transferWrongSite',
  unsupported: 'transferUnsupported',
  invalid: 'transferInvalid',
  changed: 'transferChanged',
  backup: 'transferBackupFailed',
  connection: 'transferOpenChat',
  read: 'transferReadFailed',
  'folder-diverged': 'transferDiverged',
  write: 'transferWriteFailed',
  rollback: 'transferRollbackFailed',
};
const params = new URLSearchParams(location.search);
const review = params.get('review');
const sourceTab = Number(params.get('source'));
export function LocalTransfer() {
  const { t } = useLanguage();
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([]);
  const [tab, setTab] = useState<number>();
  const [format, setFormat] = useState('native');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sections, setSections] = useState<LocalSection[]>([]);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<TranslationKey | null>(null);
  const [hasRecovery, setHasRecovery] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const client = useRef<ReturnType<typeof connectTransfer> | null>(null);
  const locked = useRef(false);
  const offered = useRef(review);
  useEffect(() => {
    let live = true;
    let generation = 0;
    let bound: number | undefined;
    function release() {
      const port = client.current;
      client.current = null;
      bound = undefined;
      port?.close();
      setTab(undefined);
      setPreview(null);
      setFilename('');
      setMessage(null);
    }
    async function refresh() {
      const version = ++generation;
      const chats = (
        await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] })
      )
        .filter((x) => x.id !== undefined && !x.incognito && !x.discarded)
        .sort(
          (a, b) =>
            Number(b.url?.startsWith('https://chatgpt.com/')) -
              Number(a.url?.startsWith('https://chatgpt.com/')) ||
            (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0),
        );
      if (!live || version !== generation) return;
      setTabs(chats);
      // A preview belongs to this connection. Keep it when the user focuses another chat.
      if (bound !== undefined && chats.some((x) => x.id === bound)) return;
      if (bound !== undefined) release();
      for (const chat of chats) {
        if (review && chat.id !== sourceTab) continue;
        const port = connectTransfer(chat.id!, () => {
          if (live && client.current === port) {
            release();
            void refresh();
          }
        });
        try {
          await port.request('ping');
        } catch {
          port.close();
          if (!live || version !== generation) return;
          continue;
        }
        if (!live || version !== generation) {
          port.close();
          return;
        }
        client.current = port;
        bound = chat.id;
        setTab(bound);
        const ticket = offered.current;
        if (ticket) {
          offered.current = null;
          void perform(async () => {
            const value = await port.request<{ preview: Preview; filename: string }>(
              'preview-picked',
              { ticket },
            );
            if (!live || client.current !== port) return;
            setFilename(value.filename);
            setSections(LOCAL_SECTIONS.filter((k) => value.preview.sections[k]));
            setPreview(value.preview);
          });
        }
        return;
      }
    }
    const updated = (_id: number, change: chrome.tabs.OnUpdatedInfo, chat: chrome.tabs.Tab) => {
      if (
        change.status === 'complete' &&
        /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(chat.url ?? '')
      )
        void refresh();
    };
    void refresh();
    chrome.tabs.onUpdated.addListener(updated);
    window.addEventListener('focus', refresh);
    void recoveryCopy()
      .then((copy) => {
        if (live) setHasRecovery(!!copy);
      })
      .catch(() => {});
    return () => {
      live = false;
      chrome.tabs.onUpdated.removeListener(updated);
      window.removeEventListener('focus', refresh);
      client.current?.close();
      client.current = null;
    };
  }, []);
  async function perform(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (e) {
      const code = e instanceof Error ? e.message : 'invalid';
      setMessage(errors[code] ?? 'transferInvalid');
      if (['connection', 'changed', 'account-mismatch', 'write', 'rollback'].includes(code))
        setPreview(null);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  function call<T>(action: string, args?: Record<string, unknown>) {
    if (!client.current) throw new Error('connection');
    return client.current.request<T>(action, args);
  }
  function readFile(file?: File) {
    if (!file) return;
    void perform(async () => {
      setPreview(null);
      setFilename(file.name);
      setMode('merge');
      const raw = JSON.parse(await file.text());
      const result = await call<Preview>('preview', { file: raw });
      setSections(LOCAL_SECTIONS.filter((k) => result.sections[k]));
      setPreview(result);
    });
  }
  function apply() {
    void perform(async () => {
      if (sections.includes('folders')) {
        if (!(await call<boolean>('folders-ready'))) throw new Error('changed');
        await Promise.all(
          tabs
            .filter((other) => other.id && other.id !== tab)
            .map(async (other) => {
              const otherClient = connectTransfer(other.id!);
              try {
                const ready = await otherClient.request<boolean>('folders-ready');
                if (!ready) throw new Error('changed');
              } catch (e) {
                // Tabs left open before installation may have no extension listener.
                if (!(e instanceof Error && e.message === 'connection')) throw e;
              } finally {
                otherClient.close();
              }
            }),
        );
      }
      let token: string | undefined;
      if (mode === 'replace') {
        const copied = await call<{ token: string; backup: LocalBackup }>('recovery');
        await recoveryCopy(copied.backup);
        setHasRecovery(true);
        token = copied.token;
      }
      await call('apply', { mode, sections, token });
      setPreview(null);
      setFilename('');
      setMessage('transferDone');
    });
  }
  return (
    <main className="gv-transfer">
      <header>
        <img src="/icon-32.png" alt="" width="24" height="24" />
        <span>GPT-Voyager</span>
      </header>
      <h1>{t(review ? 'transferReviewTitle' : 'localTransferTitle')}</h1>
      {tab === undefined && (
        <p role="status">
          {t('transferOpenChat')}{' '}
          <a href="https://chatgpt.com/" target="_blank" rel="noreferrer">
            ChatGPT ↗
          </a>
        </p>
      )}
      {!review && (
        <section>
          <h2>{t('pm_export')}</h2>
          <div className="gv-transfer-actions">
            <select
              aria-label={t('transferFormat')}
              value={format}
              onChange={(e) => setFormat(e.target.value)}
            >
              <option value="native">{t('transferFull')}</option>
              <option value="folders">Voyager · {t('folder_title')}</option>
              <option value="prompts">Voyager · {t('transferPrompts')}</option>
            </select>
            <button
              disabled={busy || !tab}
              onClick={() =>
                void perform(async () => {
                  const result = await call<{ filename: string; payload: unknown }>('export', {
                    format,
                  });
                  downloadJson(result.filename, result.payload);
                  setMessage('transferExported');
                })
              }
            >
              {t('pm_export')} JSON
            </button>
          </div>
          <p>{t('transferFormatsHelp')}</p>
        </section>
      )}
      <section>
        {!review && <h2>{t('pm_import')}</h2>}
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            readFile(f);
          }}
        />
        <div className="gv-transfer-actions">
          <button
            hidden={!!review && (!!preview || busy)}
            disabled={busy || !tab}
            onClick={() => fileInput.current?.click()}
          >
            {t('transferChoose')}
          </button>
          <span>{filename}</span>
        </div>
        {preview && (
          <>
            <p>{t(preview.match === 'matched' ? 'transferMatch' : 'transferUnknown')}</p>
            <div className="gv-transfer-table">
              <table>
                <thead>
                  <tr>
                    {(
                      [
                        'transferItems',
                        'transferLocal',
                        'transferIncoming',
                        'transferAdded',
                        'transferDuplicates',
                        'transferConflicts',
                      ] as const
                    ).map((k) => (
                      <th key={k}>{t(k)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {LOCAL_SECTIONS.map((k) => {
                    const count = preview.sections[k];
                    if (!count) return null;
                    return (
                      <tr key={k}>
                        <th>
                          <label>
                            <input
                              type="checkbox"
                              checked={sections.includes(k)}
                              disabled={busy}
                              onChange={(e) =>
                                setSections((old) =>
                                  e.target.checked ? [...old, k] : old.filter((v) => v !== k),
                                )
                              }
                            />
                            {t(names[k])}
                          </label>
                        </th>
                        {[
                          count.local,
                          count.incoming,
                          count.added,
                          count.duplicates,
                          count.conflicts,
                        ].map((v, i) => (
                          <td key={i}>{v}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <fieldset disabled={busy}>
              <label>
                <input
                  name="mode"
                  type="radio"
                  checked={mode === 'merge'}
                  onChange={() => setMode('merge')}
                />
                {t('transferMerge')}
              </label>
              <label>
                <input
                  name="mode"
                  type="radio"
                  checked={mode === 'replace'}
                  onChange={() => setMode('replace')}
                />
                {t('transferReplace')}
              </label>
            </fieldset>
            <p>{t(mode === 'merge' ? 'transferMergeHelp' : 'transferReplaceHelp')}</p>
            <button
              className={mode === 'replace' ? 'gv-transfer-destructive' : 'gv-transfer-primary'}
              disabled={busy || !sections.length}
              onClick={apply}
            >
              {t(mode === 'merge' ? 'transferApplyMerge' : 'transferApplyReplace')}
            </button>
          </>
        )}
      </section>
      <p role="status" aria-live="polite">
        {busy ? t('loading') : message ? t(message) : ''}
      </p>
      {review && (
        <button disabled={busy} onClick={() => window.close()}>
          {t(preview ? 'pm_cancel' : 'transferClose')}
        </button>
      )}
      {hasRecovery && (
        <button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const copy = await recoveryCopy();
              if (!copy) throw new Error('backup');
              downloadJson('GPT-Voyager-before-replace.json', copy);
            })
          }
        >
          {t('transferRecovery')}
        </button>
      )}
    </main>
  );
}
