/** Passive MAIN-world mirror. No extra requests, credentials or durable cache. */
export interface QuotaWindow {
  id: string;
  group: 'general' | 'review' | 'additional';
  name: string;
  remaining: number;
  seconds: number;
  resetAt: number | null;
}

export interface QuotaSnapshot {
  capturedAt: number;
  windows: QuotaWindow[];
  credits: string | null;
  unlimitedCredits: boolean;
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

export function normalizeQuotaSnapshot(value: unknown, now = Date.now()): QuotaSnapshot | null {
  const data = record(value);
  if (!data || !('rate_limit' in data || 'credits' in data)) return null;
  const windows: QuotaWindow[] = [];
  const add = (limit: unknown, group: QuotaWindow['group'], prefix: string, name = '') => {
    const rate = record(limit);
    for (const slot of ['primary_window', 'secondary_window']) {
      const w = record(rate?.[slot]);
      if (
        !w ||
        typeof w.used_percent !== 'number' ||
        !Number.isFinite(w.used_percent) ||
        w.used_percent < 0 ||
        w.used_percent > 100 ||
        typeof w.limit_window_seconds !== 'number' ||
        !Number.isFinite(w.limit_window_seconds) ||
        w.limit_window_seconds <= 0
      )
        continue;
      const resetAt =
        typeof w.reset_at === 'number' && Number.isFinite(w.reset_at) && w.reset_at > 0
          ? w.reset_at
          : typeof w.reset_after_seconds === 'number' &&
              Number.isFinite(w.reset_after_seconds) &&
              w.reset_after_seconds >= 0
            ? Math.floor(now / 1000) + w.reset_after_seconds
            : null;
      windows.push({
        id: `${prefix}:${slot}`,
        group,
        name,
        remaining: 100 - w.used_percent,
        seconds: w.limit_window_seconds,
        resetAt,
      });
    }
  };
  add(data.rate_limit, 'general', 'general');
  add(data.code_review_rate_limit, 'review', 'review');
  if (Array.isArray(data.additional_rate_limits)) {
    data.additional_rate_limits.slice(0, 8).forEach((item, index) => {
      const extra = record(item);
      if (!extra) return;
      const name = typeof extra.limit_name === 'string' ? extra.limit_name.slice(0, 80) : '';
      add(extra.rate_limit, 'additional', `additional-${index}`, name);
    });
  }
  const credits = record(data.credits);
  const balance = credits?.balance;
  const creditText =
    typeof balance === 'string' || typeof balance === 'number' ? String(balance) : '';
  return {
    capturedAt: now,
    windows,
    credits: /^\d+(?:\.\d+)?$/.test(creditText) && creditText.length < 40 ? creditText : null,
    unlimitedCredits: credits?.unlimited === true,
  };
}

interface Ticket {
  epoch: number;
  sequence: number;
}

function accountHeader(headers: HeadersInit | undefined): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get('ChatGPT-Account-Id');
  if (Array.isArray(headers))
    return headers.find(([key]) => key.toLowerCase() === 'chatgpt-account-id')?.[1] ?? null;
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'chatgpt-account-id');
  return key ? headers[key] : null;
}

export function createQuotaMirror() {
  let enabled = true; // Capture an early response before ISOLATED finishes booting.
  let account: string | null = null;
  let epoch = 0;
  let sequence = 0;
  let accepted = 0;
  let snapshot: QuotaSnapshot | null = null;
  let failed = false;
  const publish = () => {
    try {
      window.postMessage({ __gvType: 'gv-quota-state', epoch, snapshot, failed }, location.origin);
    } catch {
      /* never interfere with ChatGPT */
    }
  };
  const listener = (event: MessageEvent) => {
    if (event.origin !== location.origin || !record(event.data)) return;
    if (event.data.__gvType === 'gv-quota-feature' && typeof event.data.enabled === 'boolean') {
      enabled = event.data.enabled;
    } else if (event.data.__gvType === 'gv-quota-subscribe' && enabled) {
      publish(); // In-memory replay; no sessionStorage or new request.
    }
  };
  window.addEventListener('message', listener);
  return {
    beforeFetch(input: RequestInfo | URL, init?: RequestInit): Ticket | null {
      try {
        const raw =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(raw, location.origin);
        if (url.origin !== location.origin || !url.pathname.startsWith('/backend-api/'))
          return null;
        const next = accountHeader(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        if (next && next !== account) {
          account = next;
          epoch++;
          accepted = 0;
          snapshot = null;
          failed = false;
          if (enabled) publish();
        }
        return enabled && url.pathname === '/backend-api/wham/usage'
          ? { epoch, sequence: ++sequence }
          : null;
      } catch {
        return null;
      }
    },
    afterFetch(ticket: Ticket | null, response: Response): void {
      if (!ticket || !enabled || ticket.epoch !== epoch || ticket.sequence < accepted) return;
      if (!response.ok) {
        accepted = ticket.sequence;
        failed = true;
        if (response.status === 401 || response.status === 403) snapshot = null;
        publish();
        return;
      }
      try {
        void response
          .clone()
          .json()
          .then((raw) => {
            if (!enabled || ticket.epoch !== epoch || ticket.sequence < accepted) return;
            accepted = ticket.sequence;
            const next = normalizeQuotaSnapshot(raw);
            failed = !next;
            if (next) snapshot = next;
            publish();
          })
          .catch(() => {
            if (!enabled || ticket.epoch !== epoch || ticket.sequence < accepted) return;
            accepted = ticket.sequence;
            failed = true;
            publish();
          });
      } catch {
        /* response cloning must not affect the native request */
      }
    },
    fetchFailed(ticket: Ticket | null): void {
      if (!ticket || !enabled || ticket.epoch !== epoch || ticket.sequence < accepted) return;
      accepted = ticket.sequence;
      failed = true;
      publish();
    },
    destroy(): void {
      window.removeEventListener('message', listener);
    },
  };
}
