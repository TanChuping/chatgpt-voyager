import type enMessages from '@locales/en/messages.json';
import browser from 'webextension-polyfill';

import type { AppLanguage } from './language';

// A type-only import: no full dictionary is included in any JavaScript entry.
export type TranslationKey = keyof typeof enMessages;
export type Translation = Record<TranslationKey, string>;

// Only used until initialization, or if even the packaged English file is missing.
// The normal fallback is a fetched English dictionary, never a second resident map.
export const EMERGENCY_TRANSLATIONS: Readonly<Partial<Translation>> = Object.freeze({
  extName: 'GPT-Voyager',
  pm_settings: 'Settings',
  pm_settings_fallback: 'Open settings using the extension icon in the browser toolbar.',
  pm_search_placeholder: 'Search prompts',
  pm_add: 'Add',
  pm_close: 'Close',
  pm_cancel: 'Cancel',
  pm_save: 'Save',
  pm_export: 'Export',
  formula_copied: 'Formula copied.',
  formula_copy_failed: 'Could not copy formula.',
});

let activeTranslations: Readonly<Partial<Translation>> = EMERGENCY_TRANSLATIONS;

export function installTranslations(dictionary: Readonly<Partial<Translation>>): void {
  // No map of previous languages, promises or module imports retains older dictionaries.
  activeTranslations = dictionary;
}

export function translate(key: TranslationKey): string {
  return activeTranslations[key] ?? EMERGENCY_TRANSLATIONS[key] ?? key;
}

export function isTranslationKey(value: string): value is TranslationKey {
  return Object.prototype.hasOwnProperty.call(activeTranslations, value) || Object.prototype.hasOwnProperty.call(EMERGENCY_TRANSLATIONS, value);
}

export async function fetchTranslations(
  language: AppLanguage,
  signal?: AbortSignal,
): Promise<Translation> {
  // Fetch JSON, not import(): ESM module caches cannot be explicitly evicted.
  // Packaged extension resources work offline and are never written to chrome.storage.
  const response = await fetch(browser.runtime.getURL(`locales/${language}.json`), {
    signal,
    cache: 'force-cache',
  });
  if (!response.ok) throw new Error(`Locale ${language}: HTTP ${response.status}`);
  const raw: unknown = await response.json();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Locale ${language}: invalid dictionary`);
  }
  const entries = Object.entries(raw);
  if (!entries.length || entries.some(([, value]) => typeof value !== 'string' || !value.trim())) {
    throw new Error(`Locale ${language}: invalid messages`);
  }
  return Object.freeze(raw) as Translation;
}
