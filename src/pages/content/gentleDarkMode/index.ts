/**
 * Gentle dark mode — softens ChatGPT's dark theme by replacing its pure-black
 * surfaces with muted dark grays. Opt-in from the extension popup.
 *
 * ChatGPT's dark theme drives every surface from CSS custom properties that
 * resolve to pure black (#000): the main chat/page surface, the sidebar, and
 * the elevated surface used for menus / dialogs (e.g. the Settings modal). We
 * override just those (plus the border tokens) with the user's palette. The
 * override is scoped to ChatGPT's own dark class (`html.dark`), so it is
 * automatically a no-op in light mode — no JS theme detection needed.
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
  /* Second token family (introduced for Codex, merged site-wide by ChatGPT's
     2026-07 redesign — the Chat/Work split): --bg-secondary-surface paints
     content surfaces (Codex main area, library rows), --component-sidebar-bg
     feeds --sidebar-surface-primary, --sidebar-surface is Codex's own sidebar.
     All three resolve to #000 in dark mode. */
  html.dark,
  html.dark body {
    --bg-secondary-surface: #1f1f1e !important;
    --sidebar-surface: #1f1f1e !important;
    --component-sidebar-bg: #1f1f1e !important;
  }
  /* ChatGPT's 2026-07 redesign re-declares --main-surface-primary on EVERY
     dark-scope element (\`html.dark :not(:where(.light, .light *))\`), which
     shadows the html/body override above for all descendants — new utilities
     like .bg-surface-primary (Work-tab suggestion list, library filter bar)
     then paint pure black again. Mirror the exact same selector; our <style>
     is appended after ChatGPT's sheets, so at equal specificity we win by
     order. Deliberately NOT !important: ChatGPT's intentional higher-
     specificity surface variations (.popover menus, .snc, canvas) must keep
     winning, or every floating panel would flatten to the base color. */
  html.dark,
  html.dark :not(:where(.light, .light *)) {
    --main-surface-primary: #1f1f1e;
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
     "primary surface" elements that should sit at the base background.
     .bg-surface-primary is the 2026-07 successor utility; hard-overriding it
     too keeps the fix alive even if a late-loaded route chunk re-shadows the
     token (menus don't use these utilities — verified they paint via their
     own oklch classes — so !important is safe here). */
  html.dark .bg-token-main-surface-primary,
  html.dark .bg-token-sidebar-surface-primary,
  html.dark .bg-surface-primary {
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
