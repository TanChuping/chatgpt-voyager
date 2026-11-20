import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';

import { type AppLanguage, normalizeLanguage } from './language';
import { EMERGENCY_TRANSLATIONS, type TranslationKey, fetchTranslations, installTranslations, isTranslationKey, translate } from './translations';

type StorageAreaName = 'sync' | 'local';

const readStorageValue = async (area: StorageAreaName): Promise<unknown> => {
  try {
    const storageArea = browser.storage?.[area];
    if (storageArea?.get) {
      const result = await storageArea.get(StorageKeys.LANGUAGE);
      if (result && typeof result === 'object') {
        return (result as Record<string, unknown>)[StorageKeys.LANGUAGE];
      }
    }
  } catch {
    // Fall through to chrome.* fallback below.
  }

  try {
    const chromeStorage = chrome?.storage?.[area];
    if (!chromeStorage?.get) return null;
    return await new Promise<unknown>((resolve) => {
      chromeStorage.get(StorageKeys.LANGUAGE, (result) => {
        if (result && typeof result === 'object') {
          resolve((result as Record<string, unknown>)[StorageKeys.LANGUAGE]);
        } else {
          resolve(null);
        }
      });
    });
  } catch {
    return null;
  }
};

const getStoredLanguage = async (): Promise<string | null> => {
  const syncValue = await readStorageValue('sync');
  if (typeof syncValue === 'string') return syncValue;
  const localValue = await readStorageValue('local');
  if (typeof localValue === 'string') return localValue;
  return null;
};

/**
 * Get the current language preference
 * 1. First check user's saved preference in storage
 * 2. Fall back to browser UI language
 * 3. Default to English
 */
export async function getCurrentLanguage(): Promise<AppLanguage> {
  const stored = await getStoredLanguage();
  if (typeof stored === 'string') {
    return normalizeLanguage(stored);
  }

  // Fall back to browser UI language
  try {
    const browserLang = browser.i18n.getUILanguage();
    return normalizeLanguage(browserLang);
  } catch {
    return 'en';
  }
}

/** A single parsed dictionary belongs to this JavaScript context. */
let cachedLanguage: AppLanguage | null = null;
let resourceLanguage: AppLanguage | null = null;
let requestedLanguage: AppLanguage | null = null;
let generation = 0;
let activeController: AbortController | null = null;
let loading: Promise<void> | null = null;
let initialization: Promise<void> | null = null;
let preferenceIntent: AppLanguage | null = null;
let preferenceSequence = 0;
let preferenceWrites: Promise<void> = Promise.resolve();
let storageRevision = 0;
let deferredStorageChange: { revision: number; value: unknown } | null = null;
const listeners = new Set<(language: AppLanguage) => void>();

export function getCachedLanguage(): AppLanguage {
  return requestedLanguage ?? cachedLanguage ?? 'en';
}

export function subscribeLanguageChange(listener: (language: AppLanguage) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyLanguageReady(language: AppLanguage): void {
  // Only explicitly marked, extension-owned leaf labels are changed. Keeping
  // markers on their nodes avoids a registry retaining removed UI or dictionaries.
  if (typeof document !== 'undefined') {
    document.querySelectorAll<HTMLElement>('[data-gv-i18n-text], [data-gv-i18n-title], [data-gv-i18n-aria-label]').forEach((element) => {
      const textKey = element.getAttribute('data-gv-i18n-text');
      if (textKey) element.textContent = getTranslationSyncUnsafe(textKey);
      for (const attribute of ['title', 'aria-label'] as const) {
        const key = element.getAttribute(`data-gv-i18n-${attribute}`);
        if (key) element.setAttribute(attribute, getTranslationSyncUnsafe(key));
      }
    });
  }
  for (const listener of listeners) {
    try { listener(language); } catch (error) { console.error('Language refresh failed:', error); }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('voyager:language-changed', { detail: { language } }));
  }
}

/** Resolves only after the requested dictionary (or its fallback) is usable. */
export function setCachedLanguage(language: AppLanguage): Promise<void> {
  if (requestedLanguage === language && loading) return loading;
  if (cachedLanguage === language && resourceLanguage === language && !loading) {
    requestedLanguage = language;
    return Promise.resolve();
  }
  requestedLanguage = language;
  const ticket = ++generation;
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  const task = (async () => {
    let dictionary = EMERGENCY_TRANSLATIONS;
    let source: AppLanguage | null = null;
    try {
      dictionary = await fetchTranslations(language, controller.signal);
      source = language;
    } catch {
      if (controller.signal.aborted || ticket !== generation) return;
      if (language !== 'en') {
        try {
          dictionary = await fetchTranslations('en', controller.signal);
          source = 'en';
        } catch {
          if (controller.signal.aborted || ticket !== generation) return;
        }
      }
    }
    if (controller.signal.aborted || ticket !== generation) return;
    installTranslations(dictionary);
    cachedLanguage = language;
    resourceLanguage = source;
    notifyLanguageReady(language);
  })();
  loading = task.finally(() => {
    if (ticket === generation) {
      loading = null;
      activeController = null;
    }
  });
  return loading;
}

/** Preserve the existing sync-first / local-fallback key and write semantics. */
export async function setLanguagePreference(language: AppLanguage): Promise<void> {
  preferenceIntent = language;
  const selection = ++preferenceSequence;
  const dictionaryReady = setCachedLanguage(language);
  const write = preferenceWrites.then(async () => {
    // A rapid later selection supersedes a not-yet-started write.
    if (selection !== preferenceSequence) return;
    let writtenArea: StorageAreaName | null = null;
    try {
      await browser.storage.sync.set({ [StorageKeys.LANGUAGE]: language });
      writtenArea = 'sync';
    } catch (syncError) {
      try {
        await browser.storage.local.set({ [StorageKeys.LANGUAGE]: language });
        writtenArea = 'local';
      } catch (localError) {
        console.error('Failed to save language preference:', syncError, localError);
      }
    }
    if (selection !== preferenceSequence) return;
    // A different open surface may have written after this one. Reconcile the
    // final value once our write completes, without waiting for a slow fetch.
    // Read the successful area so the existing local-fallback behavior remains.
    const revisionBeforeRead = storageRevision;
    const stored = writtenArea ? await readStorageValue(writtenArea) : null;
    if (selection !== preferenceSequence) return;
    const deferred = deferredStorageChange;
    deferredStorageChange = null;
    preferenceIntent = null;
    if (deferred && (deferred.revision > revisionBeforeRead || !writtenArea)) {
      applyStorageLanguage(deferred.value, deferred.revision);
    } else if (typeof stored === 'string') {
      void setCachedLanguage(normalizeLanguage(stored));
    }
  });
  preferenceWrites = write.catch(() => {});
  await Promise.all([dictionaryReady, write]);
  while (selection === preferenceSequence && loading) await loading;
}

function applyStorageLanguage(value: unknown, revision: number): void {
  if (typeof value === 'string') {
    void setCachedLanguage(normalizeLanguage(value));
    return;
  }
  const selection = preferenceSequence;
  void getCurrentLanguage().then((language) => {
    if (revision === storageRevision && selection === preferenceSequence && preferenceIntent === null) {
      void setCachedLanguage(language);
    }
  });
}

/** Idempotent initialization: one storage listener, one selected-language request. */
export function initI18n(): Promise<void> {
  if (initialization) return initialization;
  const ticket = generation;
  browser.storage.onChanged.addListener((changes, areaName) => {
    if ((areaName !== 'sync' && areaName !== 'local') || !changes[StorageKeys.LANGUAGE]) return;
    const next = changes[StorageKeys.LANGUAGE]?.newValue;
    const revision = ++storageRevision;
    if (preferenceIntent !== null) {
      deferredStorageChange = { revision, value: next };
      return;
    }
    // These events carry the same canonical value written by the existing UI.
    applyStorageLanguage(next, revision);
  });
  initialization = getCurrentLanguage().then(async (language) => {
    if (ticket === generation) await setCachedLanguage(language);
    else if (loading) await loading;
  });
  return initialization;
}

export async function getTranslation(key: TranslationKey): Promise<string> {
  await initI18n();
  while (loading) await loading;
  return translate(key);
}

export function getTranslationSync(key: TranslationKey): string {
  return translate(key);
}

export function getTranslationSyncUnsafe(key: string): string {
  return isTranslationKey(key) ? translate(key) : key;
}

export function createTranslator(): (key: string) => string {
  return getTranslationSyncUnsafe;
}
