/**
 * Gentle dark mode — softens ChatGPT's dark theme by replacing its pure-black
 * surfaces with muted dark grays. Opt-in from the extension popup.
 *
 * ChatGPT's dark theme drives every surface from CSS custom properties that
 * resolve to pure black (#000): the main chat/page surface, the sidebar, and
 * the elevated surface used for menus / dialogs (e.g. the Settings modal). We
 * override just those (plus the border tokens) with the user's palette. The
 * override is scoped to ChatGPT's own dark marker (`html.dark` before the
 * 2026-09 redesign, `[data-theme="dark"]` after it), so it is automatically a
 * no-op in light mode — no JS theme detection needed.
 *
 * Palette:
 *   #1f1f1e — main / base background
 *   #2c2c2a — elevated "front" panels (menus, dialogs)
 *   #3d3d3b — borders / strokes
 */
import { addPageExitListener } from '@/core/utils/pageLifecycle';

const STYLE_ID = 'gv-gentle-dark-style';
const STORAGE_KEY = 'gvGentleDarkMode';
const DEFAULT_ENABLED = false;
let started = false;
let lifecycleGeneration = 0;
let storageChangeHandler:
  | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
  | null = null;
let removePageExitListener: (() => void) | null = null;

function isActiveGeneration(generation: number): boolean {
  return started && generation === lifecycleGeneration;
}

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
  /* ChatGPT 2026-09 (Codex app shell): dark mode is \`data-theme="dark"\` on
     <html> and on portalled islands — no \`.dark\` class any more. ChatGPT now
     ships its own background setting (Settings → Appearance → Background):
     a generator derives ~85 \`--app-color-*\` / \`--codex-base-*\` tokens from
     {surface, ink, accent, contrast} and writes them into
     \`<style data-codex-app-themes>\` inside \`@layer theme\`; every surface
     token (--color-surface, --chat-background-color, …) resolves from those.
     The values below are that generator's exact output for the stock ChatGPT
     dark theme with surface = #1f1f1e, i.e. what a user gets by typing our
     color into that setting. Accent-derived tokens (send button, user bubble,
     selection, links) are left out so a user's own accent choice survives,
     and so are the primary-button colors: for a custom surface the
     generator paints primary buttons with the same color as their label.
     Unlayered, so it beats ChatGPT's \`@layer theme\` without !important. */
  [data-theme="dark"] {
    --codex-base-contrast: 60;
    --codex-base-ink: #ededed;
    --codex-base-surface: #1f1f1e;
    --app-color-background-application-menu: #262625;
    --app-color-background-button-secondary: rgba(237, 237, 237, 0.052);
    --app-color-background-button-secondary-active: rgba(237, 237, 237, 0.12);
    --app-color-background-button-secondary-hover: rgba(237, 237, 237, 0.078);
    --app-color-background-button-secondary-inactive: rgba(237, 237, 237, 0.038);
    --app-color-background-button-tertiary: rgba(237, 237, 237, 0.029);
    --app-color-background-button-tertiary-active: rgba(237, 237, 237, 0.1);
    --app-color-background-button-tertiary-hover: rgba(237, 237, 237, 0.068);
    --color-background-callout-surface: rgba(57, 57, 56, 0.96);
    --app-color-background-control: rgba(50, 50, 49, 0.96);
    --color-background-control-opaque: rgb(50, 50, 49);
    --color-background-composer-action-bar: rgba(237, 237, 237, 0.032);
    --app-color-background-editor-opaque: rgb(45, 45, 44);
    --app-color-background-elevated-primary: rgba(57, 57, 56, 0.96);
    --app-color-background-elevated-primary-opaque: rgb(57, 57, 56);
    --app-color-background-elevated-secondary: rgba(237, 237, 237, 0.032);
    --app-color-background-elevated-secondary-opaque: #2d2d2c;
    --color-background-mode-toggle-track: rgba(237, 237, 237, 0.068);
    --color-background-mode-toggle-selected: rgb(50, 50, 49);
    --color-background-panel: #292928;
    --app-color-background-surface: #1f1f1e;
    --app-color-background-surface-under: #1a1a19;
    --app-color-border: rgba(237, 237, 237, 0.084);
    --app-color-border-application-menu-separator: #5e5e5d;
    --app-color-border-heavy: rgba(237, 237, 237, 0.156);
    --app-color-border-light: rgba(237, 237, 237, 0.042);
    --color-border-mode-toggle-selected: rgba(237, 237, 237, 0.084);
    --app-color-icon-primary: rgba(237, 237, 237, 0.904);
    --app-color-icon-secondary: rgba(237, 237, 237, 0.71);
    --app-color-icon-tertiary: rgba(237, 237, 237, 0.51);
    --app-color-simple-scrim: rgba(237, 237, 237, 0.104);
    --app-color-text-button-tertiary: rgba(237, 237, 237, 0.51);
    --app-color-foreground-application-menu: #d4d4d4;
    --app-color-text-foreground: #ededed;
    --app-color-text-foreground-secondary: rgba(237, 237, 237, 0.71);
    --app-color-text-foreground-tertiary: rgba(237, 237, 237, 0.498);
    --color-text-mode-toggle-inactive: color-mix(in oklab, #ededed 80%, transparent);
    --shadow-mode-toggle-selected: var(--shadow-md);
    --content-chromatic-channels: clamp(0, l + clamp(-0.015, 0.00643536 + clamp(0, (l - 0.16375795) / 0.82731095, 1) * -0.01183099, 0.015), 1) calc(a * 0.99014084) calc(b * 0.99014084);
    --content-neutral-channels: clamp(0, l + clamp(-0.015, 0.00643536 + clamp(0, (l - 0.16375795) / 0.82731095, 1) * -0.01183099, 0.015), 1) calc(a * 0.99014084 + (-0.00006567 + clamp(0, (l - 0.16375795) / 0.82731095, 1) * 0.00006567) * min(1, 0.01 / max(hypot((-0.00006567 + clamp(0, (l - 0.16375795) / 0.82731095, 1) * 0.00006567), (0.00022086 + clamp(0, (l - 0.16375795) / 0.82731095, 1) * -0.00022086)), 0.00000001))) calc(b * 0.99014084 + (0.00022086 + clamp(0, (l - 0.16375795) / 0.82731095, 1) * -0.00022086) * min(1, 0.01 / max(hypot((-0.00006567 + clamp(0, (l - 0.16375795) / 0.82731095, 1) * 0.00006567), (0.00022086 + clamp(0, (l - 0.16375795) / 0.82731095, 1) * -0.00022086)), 0.00000001)));
    --app-color-text-secondary: initial;
    --app-color-text-primary-solid: initial;
    --app-color-background-card: initial;
    --app-color-ads-background-secondary: initial;
    --app-color-ads-background-secondary-press: initial;
    --app-color-ads-border-medium: initial;
    --app-color-ads-text-primary: initial;
    --color-border-button-outline: var(--color-border);
    --color-background-button-outline-hover: var(--color-background-primary-ghost-hover);
    --color-text-button-outline: var(--color-text);
    --color-text-mode-toggle-primary: var(--color-text);
    --color-text-mode-toggle-accent: var(--color-text-info);
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

export function stopGentleDarkMode(): void {
  started = false;
  lifecycleGeneration += 1;
  removeStyle();

  if (storageChangeHandler) {
    try {
      chrome.storage?.onChanged?.removeListener(storageChangeHandler);
    } catch {
      // Ignore cleanup errors during page teardown.
    }
    storageChangeHandler = null;
  }

  if (removePageExitListener) {
    removePageExitListener();
    removePageExitListener = null;
  }
}

export function startGentleDarkMode(): () => void {
  if (started) return stopGentleDarkMode;
  started = true;
  const generation = ++lifecycleGeneration;

  storageChangeHandler = (changes, area) => {
    if (!isActiveGeneration(generation) || area !== 'sync') return;
    const change = changes[STORAGE_KEY];
    if (!change) return;
    if (change.newValue === true) applyStyle();
    else removeStyle();
  };
  try {
    chrome.storage?.onChanged?.addListener(storageChangeHandler);
  } catch {
    storageChangeHandler = null;
  }

  removePageExitListener = addPageExitListener(stopGentleDarkMode);

  try {
    chrome.storage?.sync?.get({ [STORAGE_KEY]: DEFAULT_ENABLED }, (res) => {
      if (!isActiveGeneration(generation)) return;
      if (res?.[STORAGE_KEY] === true) applyStyle();
      else removeStyle();
    });
  } catch {
    // Storage unavailable: retain the live listener and default to disabled.
    if (isActiveGeneration(generation)) removeStyle();
  }

  return stopGentleDarkMode;
}
