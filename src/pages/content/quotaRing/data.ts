import type { QuotaSnapshot, QuotaWindow } from '../../pageWorld/quotaMirror';

export interface QuotaState {
  epoch: number;
  snapshot: QuotaSnapshot | null;
  failed: boolean;
}

/** Validate the cross-world message again; never carry identity or credentials. */
export function readQuotaState(value: unknown): QuotaState | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (
    data.__gvType !== 'gv-quota-state' ||
    !Number.isSafeInteger(data.epoch) ||
    Number(data.epoch) < 0 ||
    typeof data.failed !== 'boolean'
  )
    return null;
  if (data.snapshot === null)
    return { epoch: Number(data.epoch), snapshot: null, failed: data.failed };
  if (!data.snapshot || typeof data.snapshot !== 'object') return null;
  const s = data.snapshot as Record<string, unknown>;
  if (
    typeof s.capturedAt !== 'number' ||
    !Number.isFinite(s.capturedAt) ||
    s.capturedAt <= 0 ||
    s.capturedAt > Date.now() + 60_000 ||
    !Array.isArray(s.windows) ||
    s.windows.length > 20
  )
    return null;
  const windows: QuotaWindow[] = [];
  for (const w of s.windows) {
    if (
      !w ||
      typeof w !== 'object' ||
      typeof w.id !== 'string' ||
      w.id.length > 100 ||
      !['general', 'review', 'additional'].includes(w.group) ||
      typeof w.name !== 'string' ||
      w.name.length > 80 ||
      typeof w.remaining !== 'number' ||
      !Number.isFinite(w.remaining) ||
      w.remaining < 0 ||
      w.remaining > 100 ||
      typeof w.seconds !== 'number' ||
      !Number.isFinite(w.seconds) ||
      w.seconds <= 0 ||
      (w.resetAt !== null &&
        (typeof w.resetAt !== 'number' || !Number.isFinite(w.resetAt) || w.resetAt <= 0))
    )
      return null;
    windows.push({
      id: w.id,
      group: w.group,
      name: w.name,
      remaining: w.remaining,
      seconds: w.seconds,
      resetAt: w.resetAt,
    });
  }
  if (
    s.credits !== null &&
    (typeof s.credits !== 'string' || s.credits.length >= 40 || !/^\d+(?:\.\d+)?$/.test(s.credits))
  )
    return null;
  if (typeof s.unlimitedCredits !== 'boolean') return null;
  return {
    epoch: Number(data.epoch),
    failed: data.failed,
    snapshot: {
      capturedAt: s.capturedAt,
      windows,
      credits: s.credits as string | null,
      unlimitedCredits: s.unlimitedCredits,
    },
  };
}

/** General plan windows determine the ring; a separate code-review cap does not. */
export function ringRemaining(snapshot: QuotaSnapshot | null): number | null {
  const windows = snapshot?.windows.filter((w) => w.group === 'general') ?? [];
  return windows.length ? Math.min(...windows.map((w) => w.remaining)) : null;
}
