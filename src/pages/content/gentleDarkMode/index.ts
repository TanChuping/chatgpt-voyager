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

function applyStyle(): void {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent = CSS;
}

function removeStyle(): void {
  document.getElementById(STYLE_ID)?.remove();
}

export function startGentleDarkMode(): void {
  chrome.storage?.sync?.get({ [STORAGE_KEY]: DEFAULT_ENABLED }, (res) => {
    if (res?.[STORAGE_KEY] === true) applyStyle();
  });

  const storageChangeHandler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area === 'sync' && changes[STORAGE_KEY]) {
      if (changes[STORAGE_KEY].newValue === true) applyStyle();
      else removeStyle();
    }
  };

  chrome.storage?.onChanged?.addListener(storageChangeHandler);

  window.addEventListener(
    'beforeunload',
    () => {
      removeStyle();
      try {
        chrome.storage?.onChanged?.removeListener(storageChangeHandler);
      } catch {
        // Ignore cleanup errors during page teardown.
      }
    },
    { once: true },
  );
}
