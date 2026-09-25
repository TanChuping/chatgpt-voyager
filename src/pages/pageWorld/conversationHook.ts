/**
 * Page-world fetch/XHR hook.
 *
 * Runs in MAIN world so it can wrap ChatGPT's own `window.fetch` and
 * `XMLHttpRequest.prototype.open`. Whenever ChatGPT issues
 *   GET /backend-api/conversation/<uuid>
 * we clone the response body, parse it as JSON, and dispatch the payload via
 * a `CustomEvent('gv-conv-captured')` on `window` so the content-script-world
 * code can pick it up.
 *
 * We piggyback because the endpoint requires `Authorization: Bearer <jwt>`
 * plus several proprietary headers (oai-client-version, oai-device-id,
 * oai-session-id, x-oai-is) that aren't readable from outside ChatGPT's
 * JS runtime. ChatGPT auto-fires this fetch every time the user opens a
 * conversation, so as long as we install our wrapper before that fetch,
 * capture is silent and automatic.
 */
import { installClipboardLatexFix } from './clipboardLatexFix';
import { installFiberReader } from './fiberReader';
import { installThreadMirror } from './threadMirror';

// Match the bare conversation endpoint only — NOT sub-resources like
// `/conversation/<uuid>/stream_status` or `/conversation/<uuid>/textdocs`,
// which also return JSON but with empty / unrelated payloads that would
// overwrite our useful capture with garbage.
const CONV_RE =
  /\/backend-api\/conversation\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:$|[?#])/i;

// ChatGPT 2026-09 pages conversations instead: the latest page from
// `/backend-api/conversations/<uuid>?num_turns=N`, each older one from
// `/backend-api/conversations/<uuid>/messages?before=<message id>`.
const PAGE_RE =
  /\/backend-api\/conversations\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(\/messages)?(?:$|[?#])/i;

interface CaptureTarget {
  convId: string;
  /** Absent for the classic whole-conversation endpoint. */
  page?: { kind: 'latest' | 'before'; before?: string | null };
}

function extractTarget(url: string | URL | undefined | null): CaptureTarget | null {
  if (!url) return null;
  const s = typeof url === 'string' ? url : url.toString();
  const full = CONV_RE.exec(s);
  if (full) return { convId: full[1] };
  const paged = PAGE_RE.exec(s);
  if (!paged) return null;
  if (!paged[2]) return { convId: paged[1], page: { kind: 'latest' } };
  let before: string | null = null;
  try {
    before = new URL(s, window.location.origin).searchParams.get('before');
  } catch {
    /* keep null: the page is then prepended */
  }
  return { convId: paged[1], page: { kind: 'before', before } };
}

const SESSION_KEY_PREFIX = 'gv-cap-';

function dispatchCaptured(target: CaptureTarget, data: unknown, source: 'fetch' | 'xhr'): void {
  const { convId, page } = target;
  // Two delivery channels:
  //
  // 1. `window.postMessage` — for the LIVE case where the content-script
  //    listener is already installed when this fires. Chrome bridges
  //    postMessage between main world and isolated content-script world.
  //
  // 2. `sessionStorage` — for the COLD-START case. The page's first fetch
  //    for the conversation typically fires before our content script has
  //    booted (the script runs after the page's own bundle, despite
  //    `run_at: document_start` for the hook). A bare postMessage would be
  //    lost. By stashing the payload in sessionStorage under a magic key
  //    prefix, the content-script can re-ingest it on init, then clear.
  //    sessionStorage is shared across worlds in the same tab and dies on
  //    tab close — no cross-session pollution.
  const payload = { convId, data, source, page, capturedAt: Date.now() };
  try {
    window.postMessage({ __gvType: 'gv-conv-captured', payload }, window.location.origin);
  } catch {
    /* swallow — never break ChatGPT */
  }
  try {
    // One slot per page, so a cold start replays every page it missed.
    const slot = page?.kind === 'before' ? `${convId}@${page.before ?? ''}` : convId;
    sessionStorage.setItem(SESSION_KEY_PREFIX + slot, JSON.stringify(payload));
  } catch {
    /* quota exceeded / private mode — postMessage is still our primary */
  }
}

(function installFetchHook() {
  if ((window as unknown as { __gvFetchHooked?: boolean }).__gvFetchHooked) return;
  (window as unknown as { __gvFetchHooked?: boolean }).__gvFetchHooked = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function gvHookedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const response = await originalFetch(input as RequestInfo, init);
    try {
      const url = typeof input === 'string' || input instanceof URL ? input : input.url;
      const target = extractTarget(url);
      if (target && response.ok) {
        // Clone so we don't consume the body the app needs.
        response
          .clone()
          .json()
          .then((data) => dispatchCaptured(target, data, 'fetch'))
          .catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
    return response;
  };
})();

(function installXhrHook() {
  if ((window as unknown as { __gvXhrHooked?: boolean }).__gvXhrHooked) return;
  (window as unknown as { __gvXhrHooked?: boolean }).__gvXhrHooked = true;

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function gvHookedOpen(
    this: XMLHttpRequest & { __gvTarget?: CaptureTarget | null },
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    try {
      this.__gvTarget = extractTarget(url);
      if (this.__gvTarget) {
        this.addEventListener('load', () => {
          try {
            if (this.status >= 200 && this.status < 300) {
              const text =
                this.responseType === '' || this.responseType === 'text' ? this.responseText : null;
              if (text) {
                const parsed = JSON.parse(text);
                dispatchCaptured(this.__gvTarget as CaptureTarget, parsed, 'xhr');
              }
            }
          } catch {
            /* ignore */
          }
        });
      }
    } catch {
      /* ignore */
    }
    return originalOpen.call(this, method, url as string, ...(rest as [boolean, string?, string?]));
  } as typeof XMLHttpRequest.prototype.open;
})();

// React-fiber fallback reader: answers `gv-fiber-request` from the isolated
// content script for conversations opened from client cache (no network
// capture). Pull-on-demand, fully guarded — see fiberReader.ts.
installFiberReader();

// Mirror ChatGPT's virtualised thread (2026-09 layout) into invisible,
// positioned DOM anchors the timeline can select. See threadMirror.ts.
installThreadMirror();

// Repair math delimiters in ChatGPT's own "copy message" output (it strips the
// backslash off \[ \] / \( \), breaking the LaTeX). Fully guarded — see
// clipboardLatexFix.ts.
installClipboardLatexFix();
