/**
 * Gentle dark mode — softens ChatGPT's dark theme by replacing its pure-black
 * surfaces with muted dark grays. Opt-in from the extension popup.
 *
 * ChatGPT's dark theme drives every surface from CSS custom properties; three
 * of them resolve to pure black (#000): the main chat/page surface, the
 * sidebar, and the elevated surface used for menus / dialogs (e.g. the Settings
 * modal). We override just those (plus the border tokens) with the user's
 * palette. The override is scoped to ChatGPT's own dark class (`html.dark`), so
 * it is automatically a no-op in light mode — no JS theme detection needed.
 *
 * Palette:
 *   #1f1f1e — main / base background
 *   #2c2c2a — elevated "front" panels (menus, dialogs)
 *   #3d3d3b — borders / strokes
 */

const STYLE_ID = 'gv-gentle-dark-style';
const CODEX_STYLE_ID = 'gv-gentle-dark-codex-style';
const STORAGE_KEY = 'gvGentleDarkMode';
const DEFAULT_ENABLED = false;

// We redefine the tokens on BOTH html and body: ChatGPT re-declares them on
// <body>, so an html-only override would be shadowed for the whole document.
const CSS = `
  html.dark,
  html.dark body {
    --main-surface-primary: #1f1f1e !important;
    --sidebar-surface-primary: #1f1f1e !important;
    --bg-elevated-secondary: #2c2c2a !important;
    --border-default: #3d3d3b !important;
    --border-medium: #3d3d3b !important;
    --border-heavy: #3d3d3b !important;
    --border-sharp: #3d3d3b !important;
    --border-light: #3d3d3b !important;
    background-color: #1f1f1e !important;
  }
  /* The sticky conversation header paints its own opaque black instead of using
     the surface token, so the token override alone leaves a black bar at top. */
  html.dark header.sticky.top-0 {
    background-color: #1f1f1e !important;
  }
  /* The composer fade overlay (fades messages out behind the input box) uses a
     hardcoded black background masked to fade in — leaving a black band at the
     bottom over the now-gray page. Recolor it to the gentle background so the
     fade blends in instead of showing as a dark strip. */
  html.dark [class*="thread-bottom-container"]::after {
    background-color: #1f1f1e !important;
  }
  /* ChatGPT re-declares the surface tokens on a wrapper below <body>, so the
     variable overrides above don't reach deep nodes (e.g. code-block headers).
     Override the surface *utility classes* directly — these are exactly the
     "primary surface" elements that should sit at the base background. */
  html.dark .bg-token-main-surface-primary,
  html.dark .bg-token-sidebar-surface-primary {
    background-color: #1f1f1e !important;
  }
`;

/**
 * Codex (`chatgpt.com/codex/*`) is a separate React-Router route module inside
 * the same ChatGPT app, and its dark theme drives surfaces from a DIFFERENT set
 * of tokens than the chat UI — these three resolve to pure black (#000) and are
 * NOT touched by the base override above, so Codex pages come out half-gentle,
 * half-black (issue #4). Overriding them to the gentle base color recolors the
 * whole Codex surface stack (main scroll area, top bar, its own sidebar).
 *
 * This block is injected ONLY on `/codex` paths (see `isCodexPage`), so it adds
 * zero weight to normal chat pages — the rules never exist in the DOM there.
 */
const CODEX_CSS = `
  html.dark,
  html.dark body {
    --bg-secondary-surface: #1f1f1e !important;
    --sidebar-surface: #1f1f1e !important;
    --component-sidebar-bg: #1f1f1e !important;
  }
`;

function injectStyle(id: string, css: string): void {
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = id;
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent = css;
}

function applyStyle(): void {
  injectStyle(STYLE_ID, CSS);
}

function removeStyle(): void {
  document.getElementById(STYLE_ID)?.remove();
}

/** True while the user is anywhere under the Codex section of the app. */
function isCodexPage(): boolean {
  return location.pathname.startsWith('/codex');
}

function removeCodexStyle(): void {
  document.getElementById(CODEX_STYLE_ID)?.remove();
}

/**
 * Add the Codex overrides when (and only when) gentle mode is on AND we are on a
 * Codex page; otherwise make sure they are gone. Called at start-up and on
 * history navigation so entering / leaving Codex flips the extra rules on / off.
 */
function refreshCodexStyle(enabled: boolean): void {
  if (enabled && isCodexPage()) injectStyle(CODEX_STYLE_ID, CODEX_CSS);
  else removeCodexStyle();
}

export function startGentleDarkMode(): void {
  let enabled = DEFAULT_ENABLED;

  const setEnabled = (next: boolean): void => {
    enabled = next;
    if (next) {
      applyStyle();
      refreshCodexStyle(true);
    } else {
      removeStyle();
      removeCodexStyle();
    }
  };

  chrome.storage?.sync?.get({ [STORAGE_KEY]: DEFAULT_ENABLED }, (res) => {
    if (res?.[STORAGE_KEY] === true) setEnabled(true);
  });

  const storageChangeHandler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area === 'sync' && changes[STORAGE_KEY]) {
      setEnabled(changes[STORAGE_KEY].newValue === true);
    }
  };

  chrome.storage?.onChanged?.addListener(storageChangeHandler);

  // Codex sub-navigation (tasks ↔ settings ↔ archive) is client-side routing
  // that keeps the `/codex` prefix, so the style injected at start-up stays
  // valid; a `popstate` re-check is a cheap safety net for back/forward moves
  // across the Codex boundary. No polling / MutationObserver — the whole
  // Codex path stays dormant until the user is actually inside Codex.
  const onPopState = (): void => refreshCodexStyle(enabled);
  window.addEventListener('popstate', onPopState);

  window.addEventListener(
    'beforeunload',
    () => {
      removeStyle();
      removeCodexStyle();
      window.removeEventListener('popstate', onPopState);
      try {
        chrome.storage?.onChanged?.removeListener(storageChangeHandler);
      } catch {
        // Ignore cleanup errors during page teardown.
      }
    },
    { once: true },
  );
}
