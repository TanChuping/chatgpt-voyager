import browser from 'webextension-polyfill';

import { SUPPORT_GOAL_JSON_URL } from '@/core/constants/project';

export type SupportGoalData = {
  enabled: boolean;
  title: string;
  titleZh: string;
  titleEn: string;
  description: string;
  descriptionZh: string;
  descriptionEn: string;
  current: number;
  target: number;
  currency: string;
  kofiUrl: string;
  imageUrl: string;
  wechatQrUrl: string;
  alipayQrUrl: string;
  updatedAt: string;
};

type SupportGoalCache = {
  fetchedAt: number;
  data: SupportGoalData;
};

const CACHE_KEY = 'gvSupportGoalCacheV1';
const CACHE_TTL_MS = 30 * 60 * 1000;
export const SUPPORT_GOAL_REFRESH_MS = 5 * 60 * 1000;

export const DEFAULT_SUPPORT_GOAL: SupportGoalData = {
  enabled: false,
  title: '',
  titleZh: '',
  titleEn: '',
  description: '',
  descriptionZh: '',
  descriptionEn: '',
  current: 0,
  target: 699,
  currency: 'CNY',
  kofiUrl: '',
  imageUrl: '',
  wechatQrUrl: '',
  alipayQrUrl: '',
  updatedAt: '2026-05-07',
};

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toSafeString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeSupportGoal(raw: unknown): SupportGoalData {
  const item = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const target = Math.max(1, toFiniteNumber(item.target, DEFAULT_SUPPORT_GOAL.target));
  const current = Math.max(0, toFiniteNumber(item.current, DEFAULT_SUPPORT_GOAL.current));
  const titleZh = toSafeString(
    item.titleZh,
    toSafeString(item.title, DEFAULT_SUPPORT_GOAL.titleZh),
  );
  const titleEn = toSafeString(item.titleEn, DEFAULT_SUPPORT_GOAL.titleEn);
  const descriptionZh = toSafeString(
    item.descriptionZh,
    toSafeString(item.description, DEFAULT_SUPPORT_GOAL.descriptionZh),
  );
  const descriptionEn = toSafeString(item.descriptionEn, DEFAULT_SUPPORT_GOAL.descriptionEn);

  return {
    enabled: item.enabled !== false,
    title: toSafeString(item.title, titleZh),
    titleZh,
    titleEn,
    description: toSafeString(item.description, descriptionZh),
    descriptionZh,
    descriptionEn,
    current,
    target,
    currency: toSafeString(item.currency, DEFAULT_SUPPORT_GOAL.currency),
    kofiUrl: toSafeString(item.kofiUrl, DEFAULT_SUPPORT_GOAL.kofiUrl),
    imageUrl: typeof item.imageUrl === 'string' ? item.imageUrl.trim() : '',
    wechatQrUrl: typeof item.wechatQrUrl === 'string' ? item.wechatQrUrl.trim() : '',
    alipayQrUrl: typeof item.alipayQrUrl === 'string' ? item.alipayQrUrl.trim() : '',
    updatedAt: toSafeString(item.updatedAt, DEFAULT_SUPPORT_GOAL.updatedAt),
  };
}

async function getCachedGoal(): Promise<SupportGoalCache | null> {
  try {
    const result = await browser.storage.local.get(CACHE_KEY);
    const cache = result[CACHE_KEY] as Partial<SupportGoalCache> | undefined;
    if (!cache || typeof cache.fetchedAt !== 'number' || !cache.data) return null;
    return {
      fetchedAt: cache.fetchedAt,
      data: normalizeSupportGoal(cache.data),
    };
  } catch {
    return null;
  }
}

async function setCachedGoal(data: SupportGoalData): Promise<void> {
  try {
    await browser.storage.local.set({
      [CACHE_KEY]: {
        fetchedAt: Date.now(),
        data,
      },
    });
  } catch {
    // Cache failure should never block the support panel.
  }
}

function cacheBustedUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('gv', String(Math.floor(Date.now() / (5 * 60 * 1000))));
  return parsed.toString();
}

function decodeBase64Json(content: string): unknown {
  const compact = content.replace(/\s/g, '');
  const bytes = Uint8Array.from(atob(compact), (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function unwrapRemotePayload(payload: unknown): unknown {
  if (
    payload &&
    typeof payload === 'object' &&
    'content' in payload &&
    typeof (payload as { content?: unknown }).content === 'string'
  ) {
    return decodeBase64Json((payload as { content: string }).content);
  }
  return payload;
}

export function getSupportGoalProgress(goal: SupportGoalData): number {
  return Math.max(0, Math.min(100, Math.round((goal.current / Math.max(1, goal.target)) * 100)));
}

export function formatSupportAmount(value: number, currency: string): string {
  const rounded = Math.round(value);
  if (currency.toUpperCase() === 'CNY') return `¥${rounded}`;
  if (currency.toUpperCase() === 'USD') return `$${rounded}`;
  return `${rounded} ${currency}`;
}

export async function loadSupportGoal(options: { force?: boolean } = {}): Promise<SupportGoalData> {
  const cached = await getCachedGoal();
  if (!options.force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const response = await fetch(cacheBustedUrl(SUPPORT_GOAL_JSON_URL), {
      cache: 'no-store',
      credentials: 'omit',
    });
    if (!response.ok) throw new Error(`Support goal request failed: ${response.status}`);
    const data = normalizeSupportGoal(unwrapRemotePayload(await response.json()));
    await setCachedGoal(data);
    return data;
  } catch {
    return cached?.data ?? DEFAULT_SUPPORT_GOAL;
  }
}
