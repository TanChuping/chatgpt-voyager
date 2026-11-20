import browser from 'webextension-polyfill';

import { MYSTERY_CARD_URL } from '@/core/constants/project';

import { type MysteryCard, parseMysteryCard } from './mysteryCard';

const CACHE_KEY = 'gvMysteryCardCacheV1';
export const CARD_REFRESH_MS = 5 * 60 * 1000;
let pending: Promise<MysteryCard | null> | undefined;

async function readCard(force: boolean): Promise<MysteryCard | null> {
  let cached: MysteryCard | undefined;
  try {
    const entry = (await browser.storage.local.get(CACHE_KEY))[CACHE_KEY] as
      | { card?: unknown; fetchedAt?: unknown }
      | undefined;
    cached = parseMysteryCard(entry?.card);
    const age = typeof entry?.fetchedAt === 'number' ? Date.now() - entry.fetchedAt : Infinity;
    if (cached && !force && age >= 0 && age < CARD_REFRESH_MS) return cached;
  } catch {
    /* Public cache may be unavailable. */
  }
  try {
    const response = await fetch(
      `${MYSTERY_CARD_URL}?gv=${Math.floor(Date.now() / CARD_REFRESH_MS)}`,
      {
        cache: 'no-store',
        credentials: 'omit',
      },
    );
    if (!response.ok) return cached ?? null;
    const data = await response.text();
    if (data.length > 65536) return cached ?? null;
    const card = parseMysteryCard(JSON.parse(data));
    if (!card) return cached ?? null;
    try {
      await browser.storage.local.set({ [CACHE_KEY]: { fetchedAt: Date.now(), card } });
    } catch {
      /* Display fresh content even if the cache is full. */
    }
    return card;
  } catch {
    return cached ?? null;
  }
}

export function loadMysteryCard(force = false): Promise<MysteryCard | null> {
  pending ??= readCard(force).finally(() => {
    pending = undefined;
  });
  return pending;
}
