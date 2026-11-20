import { APP_LANGUAGES, type AppLanguage } from '@/utils/language';

export type Copy = string | Partial<Record<AppLanguage, string>>;
export type Leaf =
  | { type: 'heading' | 'text' | 'caption'; text: Copy }
  | { type: 'progress'; value: number; max: number; unit: string }
  | { type: 'link' | 'image'; text: Copy; url: string; color?: string; fit?: 'cover' | 'square' };
export type Tab = { label: Copy; color?: string; blocks: Leaf[] };
export type Block = Leaf | { type: 'tabs'; items: Tab[]; side: boolean };
export type Row = { columns: Block[][]; weights: number[] };
export interface MysteryCard {
  v: 1;
  enabled: boolean;
  rows: Row[];
  align: 'start' | 'center' | 'end';
  gap: 'compact' | 'normal' | 'wide';
  colors: { accent?: string; background?: string; text?: string };
  label?: Copy;
  icon?: string;
}
function record(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === 'object' && !Array.isArray(input);
}
function copy(input: unknown): Copy | undefined {
  if (typeof input === 'string') return input.trim().slice(0, 3000) || undefined;
  if (!record(input)) return;
  const translations: Partial<Record<AppLanguage, string>> = {};
  for (const lang of APP_LANGUAGES) {
    const value = input[lang];
    if (typeof value === 'string' && value.trim()) translations[lang] = value.trim().slice(0, 3000);
  }
  return Object.keys(translations).length ? translations : undefined;
}
export function cardText(value: Copy | undefined, lang: AppLanguage): string {
  if (typeof value === 'string') return value;
  return value?.[lang] ?? value?.en ?? value?.zh ?? Object.values(value ?? {})[0] ?? '';
}
function color(v: unknown) {
  return typeof v === 'string' && /^#[\da-f]{6}$/i.test(v) ? v : undefined;
}
function leaf(entry: unknown): Leaf | undefined {
  if (!record(entry)) return;
  const { type, value, max, unit } = entry;
  if (type === 'progress') {
    if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      typeof max === 'number' &&
      Number.isFinite(max) &&
      max > 0 &&
      typeof unit === 'string' &&
      unit.length <= 12
    )
      return { type, value, max, unit };
    return;
  }
  const text = copy(entry.text);
  if (!text) return;
  if (type === 'heading' || type === 'text' || type === 'caption') return { type, text };
  if (
    (type !== 'link' && type !== 'image') ||
    typeof entry.url !== 'string' ||
    entry.url.length > 2048
  )
    return;
  let url: URL;
  try {
    url = new URL(entry.url);
  } catch {
    return;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return;
  return {
    type,
    text,
    url: url.href,
    color: color(entry.color),
    fit: entry.fit === 'cover' || entry.fit === 'square' ? entry.fit : undefined,
  };
}
function list<T>(
  value: unknown,
  limit: number,
  parse: (item: unknown) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > limit) return;
  const out: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (!parsed) return;
    out.push(parsed);
  }
  return out;
}
function block(entry: unknown): Block | undefined {
  if (!record(entry) || entry.type !== 'tabs') return leaf(entry);
  const items = list(entry.items, 8, (item): Tab | undefined => {
    if (!record(item)) return;
    const label = copy(item.label),
      blocks = list(item.blocks, 8, leaf);
    if (label && blocks) return { label, blocks, color: color(item.color) };
  });
  if (items) return { type: 'tabs', items, side: entry.side === true };
}
function row(raw: unknown): Row | undefined {
  // The compact array syntax places one block in each equal-width column.
  const config = Array.isArray(raw) ? { columns: raw.map((b) => [b]), weights: undefined } : raw;
  if (!record(config)) return;
  const columns = list(config.columns, 3, (col) => list(col, 8, block));
  if (!columns) return;
  const weights = config.weights ?? columns.map(() => 1);
  if (
    !Array.isArray(weights) ||
    weights.length !== columns.length ||
    !weights.every((w) => Number.isInteger(w) && w >= 1 && w <= 6)
  )
    return;
  return { columns, weights };
}
export function parseMysteryCard(raw: unknown): MysteryCard | undefined {
  if (!record(raw) || raw.v !== 1 || typeof raw.enabled !== 'boolean') return;
  const rows =
    !raw.enabled && Array.isArray(raw.rows) && raw.rows.length === 0 ? [] : list(raw.rows, 12, row);
  if (!rows) return;
  const c = record(raw.colors) ? raw.colors : {};
  return {
    v: 1,
    enabled: raw.enabled,
    rows,
    colors: { accent: color(c.accent), background: color(c.background), text: color(c.text) },
    align: raw.align === 'center' || raw.align === 'end' ? raw.align : 'start',
    gap: raw.gap === 'compact' || raw.gap === 'wide' ? raw.gap : 'normal',
    icon:
      typeof raw.icon === 'string' ? Array.from(raw.icon.trim()).slice(0, 4).join('') : undefined,
    label: copy(raw.label),
  };
}
export { renderMysteryCard } from './renderMysteryCard';
