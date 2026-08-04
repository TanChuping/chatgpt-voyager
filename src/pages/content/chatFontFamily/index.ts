/**
 * Applies a user-selected font family across the ChatGPT interface while
 * preserving the native typefaces used by code editors and rendered math.
 *
 * Presets (storage key: gvChatFontFamily):
 *   - 'default' →  no override (ChatGPT's own Söhne stack)
 *   - 'claude'  →  Tiempos-style serif stack (gives ChatGPT a "Claude-ish"
 *                  reading feel — falls back to system serifs if Tiempos
 *                  isn't installed locally, which it almost certainly isn't)
 *   - 'gemini'  →  Google-Sans-style stack (Roboto fallback is universal,
 *                  so this preset always *does* something even without
 *                  Google Sans installed)
 *   - 'custom'  →  user-imported font from the popup (woff2/woff/ttf/otf
 *                  base64 stored in `chrome.storage.local` because sync
 *                  has an 8 KB per-item cap that no real font fits in)
 *
 * The preset selection + custom-font *metadata* live in storage.sync so
 * they round-trip across devices. Only the heavy base64 *payload* lives
 * in local. If the user re-syncs from a second device, the preset
 * gracefully degrades to the system fallback for "custom" until they
 * import the font again.
 *
 * Code blocks deliberately keep their monospace, and KaTeX/MathJax keep
 * their specialist glyph fonts.
 */

const STYLE_ID = 'gv-chat-font-family';
const FONT_FACE_ID = 'gv-chat-font-family-face';
/**
 * Display name we register the imported font under in the CSS @font-face
 * block. We use a single internal identifier (not the user's filename)
 * so the stack we apply later can refer to a known name regardless of
 * what `customName` was at import time.
 */
const CUSTOM_FONT_NAME = 'gv-custom-chat-font';

const ENABLED_KEY = 'gvChatFontFamilyEnabled';
const FAMILY_KEY = 'gvChatFontFamily';
const CUSTOM_NAME_KEY = 'gvChatCustomFontName';
const CUSTOM_FORMAT_KEY = 'gvChatCustomFontFormat';
const CUSTOM_DATA_KEY = 'gvChatCustomFontData';

type FontPreset = 'default' | 'claude' | 'gemini' | 'custom';

const PRESETS: Record<Exclude<FontPreset, 'default' | 'custom'>, string> = {
  // Claude-ish reading feel: Tiempos Text is what Anthropic ships in their
  // own UI; the rest of the stack is a serif chain that produces a
  // recognizable serif look even on machines without Tiempos installed.
  claude: `'Tiempos Text', 'Charter', 'Source Serif Pro', 'Iowan Old Style', 'Apple Garamond', 'Baskerville', Georgia, 'Times New Roman', serif`,
  // Gemini's UI shipped with Google Sans / Google Sans Text. Roboto is
  // bundled on Android and ChromeOS, so this stack has a high hit rate
  // even when the user doesn't have Google Sans installed.
  gemini: `'Google Sans Text', 'Google Sans', 'Product Sans', Roboto, 'Helvetica Neue', Arial, sans-serif`,
};

function isValidPreset(value: unknown): value is FontPreset {
  return value === 'default' || value === 'claude' || value === 'gemini' || value === 'custom';
}

function extToCssFormat(ext: string): string {
  switch (ext) {
    case 'woff2':
      return 'woff2';
    case 'woff':
      return 'woff';
    case 'ttf':
      return 'truetype';
    case 'otf':
      return 'opentype';
    default:
      return 'truetype';
  }
}

function buildFontFaceCss(name: string, ext: string, dataUrl: string): string {
  const cssFormat = extToCssFormat(ext);
  return `
    @font-face {
      font-family: '${CUSTOM_FONT_NAME}';
      src: url('${dataUrl}') format('${cssFormat}');
      font-display: swap;
      font-weight: 100 900;
      font-style: normal;
    }
    /* Also register under the user's chosen display name so dev tools and
       any consumer querying by-name resolves to the imported bytes. */
    @font-face {
      font-family: ${JSON.stringify(name)};
      src: url('${dataUrl}') format('${cssFormat}');
      font-display: swap;
      font-weight: 100 900;
      font-style: normal;
    }
  `;
}

function buildAppliedStack(preset: FontPreset, customName: string | null): string | null {
  if (preset === 'default') return null;
  if (preset === 'custom') {
    if (customName) {
      return `'${CUSTOM_FONT_NAME}', ${JSON.stringify(customName)}, system-ui, -apple-system, sans-serif`;
    }
    // Custom selected but no font imported yet — fall back to system so
    // the user isn't stuck looking at the previous preset (which would
    // be confusing — they explicitly switched to 'custom').
    return `system-ui, -apple-system, 'Helvetica Neue', sans-serif`;
  }
  return PRESETS[preset];
}

function applyStyles(stack: string | null, fontFace: string | null) {
  // 1) @font-face block (only when custom font is loaded)
  let faceEl = document.getElementById(FONT_FACE_ID) as HTMLStyleElement | null;
  if (fontFace) {
    if (!faceEl) {
      faceEl = document.createElement('style');
      faceEl.id = FONT_FACE_ID;
      document.head.appendChild(faceEl);
    }
    faceEl.textContent = fontFace;
  } else if (faceEl) {
    faceEl.remove();
  }

  // 2) Application rules
  let styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!stack) {
    if (styleEl) styleEl.remove();
    return;
  }
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    document.head.appendChild(styleEl);
  }

  styleEl.textContent = `
    /* Apply to the whole ChatGPT surface: sidebar, headers, menus, dialogs,
       conversation content, composer, and Voyager-injected controls. */
    html,
    body,
    body :not(
      pre,
      pre *,
      code,
      code *,
      kbd,
      kbd *,
      samp,
      samp *,
      .cm-editor,
      .cm-editor *,
      .cm-content,
      .cm-content *,
      .hljs,
      .hljs *,
      .katex,
      .katex *,
      math,
      math *,
      mjx-container,
      mjx-container *,
      [class*="font-mono"],
      [class*="font-mono"] *
    ) {
      font-family: ${stack} !important;
    }

    /* Code and math are intentionally excluded so alignment and glyph
       rendering continue to use ChatGPT's native specialist fonts. */
  `;
}

function removeStyles() {
  document.getElementById(STYLE_ID)?.remove();
  document.getElementById(FONT_FACE_ID)?.remove();
}

interface SyncState {
  enabled: boolean;
  preset: FontPreset;
  customName: string | null;
  customFormat: string | null;
}

interface LocalState {
  customData: string | null; // data: URL or bare base64 — normalised below
}

let sync: SyncState = {
  enabled: false,
  preset: 'default',
  customName: null,
  customFormat: null,
};

let localState: LocalState = { customData: null };
let started = false;
let lifecycleGeneration = 0;
let storageChangeHandler:
  | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
  | null = null;
let beforeUnloadHandler: (() => void) | null = null;

function isActiveGeneration(generation: number): boolean {
  return started && generation === lifecycleGeneration;
}

function normalizeDataUrl(data: string, format: string): string {
  if (data.startsWith('data:')) return data;
  // Bare base64 — wrap with a font mime type. (Old builds may have
  // stored data without the data: prefix; honour both shapes.)
  const mime =
    format === 'woff2'
      ? 'font/woff2'
      : format === 'woff'
        ? 'font/woff'
        : format === 'ttf'
          ? 'font/ttf'
          : format === 'otf'
            ? 'font/otf'
            : 'application/octet-stream';
  return `data:${mime};base64,${data}`;
}

function reapply() {
  if (!sync.enabled) {
    removeStyles();
    return;
  }
  const stack = buildAppliedStack(sync.preset, sync.customName);
  let fontFace: string | null = null;
  if (sync.preset === 'custom' && localState.customData && sync.customName && sync.customFormat) {
    const url = normalizeDataUrl(localState.customData, sync.customFormat);
    fontFace = buildFontFaceCss(sync.customName, sync.customFormat, url);
  }
  applyStyles(stack, fontFace);
}

export function stopChatFontFamilyAdjuster(): void {
  started = false;
  lifecycleGeneration += 1;
  if (storageChangeHandler) {
    try {
      chrome.storage?.onChanged?.removeListener(storageChangeHandler);
    } catch {}
    storageChangeHandler = null;
  }
  if (beforeUnloadHandler) {
    window.removeEventListener('beforeunload', beforeUnloadHandler);
    beforeUnloadHandler = null;
  }
  removeStyles();
}

export function startChatFontFamilyAdjuster(): () => void {
  if (started) return stopChatFontFamilyAdjuster;
  started = true;
  const generation = ++lifecycleGeneration;
  // Initial load — sync side first, then local.
  chrome.storage?.sync?.get(
    [ENABLED_KEY, FAMILY_KEY, CUSTOM_NAME_KEY, CUSTOM_FORMAT_KEY],
    (res) => {
      if (!isActiveGeneration(generation)) return;
      sync = {
        enabled: res?.[ENABLED_KEY] === true,
        preset: isValidPreset(res?.[FAMILY_KEY]) ? res[FAMILY_KEY] : 'default',
        customName: typeof res?.[CUSTOM_NAME_KEY] === 'string' ? res[CUSTOM_NAME_KEY] : null,
        customFormat: typeof res?.[CUSTOM_FORMAT_KEY] === 'string' ? res[CUSTOM_FORMAT_KEY] : null,
      };
      chrome.storage?.local?.get([CUSTOM_DATA_KEY], (lres) => {
        if (!isActiveGeneration(generation)) return;
        localState = {
          customData: typeof lres?.[CUSTOM_DATA_KEY] === 'string' ? lres[CUSTOM_DATA_KEY] : null,
        };
        reapply();
      });
    },
  );

  storageChangeHandler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (!isActiveGeneration(generation)) return;
    if (area === 'sync') {
      let touched = false;
      if (changes[ENABLED_KEY]) {
        sync.enabled = changes[ENABLED_KEY].newValue === true;
        touched = true;
      }
      if (changes[FAMILY_KEY]) {
        const v = changes[FAMILY_KEY].newValue;
        sync.preset = isValidPreset(v) ? v : 'default';
        touched = true;
      }
      if (changes[CUSTOM_NAME_KEY]) {
        sync.customName =
          typeof changes[CUSTOM_NAME_KEY].newValue === 'string'
            ? changes[CUSTOM_NAME_KEY].newValue
            : null;
        touched = true;
      }
      if (changes[CUSTOM_FORMAT_KEY]) {
        sync.customFormat =
          typeof changes[CUSTOM_FORMAT_KEY].newValue === 'string'
            ? changes[CUSTOM_FORMAT_KEY].newValue
            : null;
        touched = true;
      }
      if (touched) reapply();
    } else if (area === 'local') {
      if (changes[CUSTOM_DATA_KEY]) {
        localState.customData =
          typeof changes[CUSTOM_DATA_KEY].newValue === 'string'
            ? changes[CUSTOM_DATA_KEY].newValue
            : null;
        reapply();
      }
    }
  };

  try {
    chrome.storage?.onChanged?.addListener(storageChangeHandler);
  } catch {
    storageChangeHandler = null;
  }

  beforeUnloadHandler = () => stopChatFontFamilyAdjuster();
  window.addEventListener('beforeunload', beforeUnloadHandler, { once: true });
  return stopChatFontFamilyAdjuster;
}
