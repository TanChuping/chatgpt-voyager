/**
 * Behaviour-level test for the chat font family adjuster.
 *
 * Covers the three things that broke during dev:
 *   1. The wrong selectors silently produce no effect (caught by the
 *      "preset stack is applied to the user bubble / assistant markdown
 *      / composer" assertions).
 *   2. Code/pre blocks must keep their monospace stack (regression guard
 *      for the :not() chain in the apply rules).
 *   3. Disabling the feature removes both <style> blocks (regression
 *      guard for `reapply()` correctly calling `removeStyles()`).
 *
 * The chrome.storage shim is enough for these checks — we don't need
 * the real browser there. The MutationObserver and DOM are jsdom's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Inline mock so we can flip storage values and re-fire onChanged inside tests.
type StorageListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  area: string,
) => void;

const syncStore: Record<string, unknown> = {};
const localStore: Record<string, unknown> = {};
const listeners: StorageListener[] = [];

function fireChange(area: 'sync' | 'local', changes: Record<string, unknown>) {
  const payload: Record<string, { newValue?: unknown }> = {};
  for (const [k, v] of Object.entries(changes)) payload[k] = { newValue: v };
  for (const cb of listeners) cb(payload, area);
}

(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    sync: {
      get(keys: string[], cb: (res: Record<string, unknown>) => void) {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in syncStore) out[k] = syncStore[k];
        // Mimic chrome's async-but-immediate-on-next-tick behavior.
        Promise.resolve().then(() => cb(out));
      },
      set(items: Record<string, unknown>, cb?: () => void) {
        Object.assign(syncStore, items);
        fireChange('sync', items);
        if (cb) Promise.resolve().then(cb);
      },
    },
    local: {
      get(keys: string[], cb: (res: Record<string, unknown>) => void) {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in localStore) out[k] = localStore[k];
        Promise.resolve().then(() => cb(out));
      },
      set(items: Record<string, unknown>, cb?: () => void) {
        Object.assign(localStore, items);
        fireChange('local', items);
        if (cb) Promise.resolve().then(cb);
      },
    },
    onChanged: {
      addListener(cb: StorageListener) {
        listeners.push(cb);
      },
      removeListener(cb: StorageListener) {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      },
    },
  },
};

// Import after the shim is installed so the module captures the right
// chrome reference at evaluation time.
const { startChatFontFamilyAdjuster } = await import('../index');

function mountChatGptShape(): { user: HTMLElement; asst: HTMLElement; composer: HTMLElement; code: HTMLElement } {
  document.body.innerHTML = '';
  const user = document.createElement('div');
  user.setAttribute('data-message-author-role', 'user');
  const bubble = document.createElement('div');
  bubble.className = 'user-message-bubble-color';
  bubble.textContent = 'hello';
  user.appendChild(bubble);
  document.body.appendChild(user);

  const asst = document.createElement('div');
  asst.setAttribute('data-message-author-role', 'assistant');
  const md = document.createElement('div');
  md.className = 'markdown prose';
  const para = document.createElement('p');
  para.textContent = 'response body';
  md.appendChild(para);
  const code = document.createElement('code');
  code.textContent = "console.log('x');";
  md.appendChild(code);
  asst.appendChild(md);
  document.body.appendChild(asst);

  const composer = document.createElement('div');
  composer.id = 'prompt-textarea';
  composer.className = 'ProseMirror';
  composer.contentEditable = 'true';
  document.body.appendChild(composer);

  return { user, asst, composer, code };
}

function getRuleStack(): string | null {
  const el = document.getElementById('gv-chat-font-family');
  if (!el || !el.textContent) return null;
  const m = el.textContent.match(/font-family:\s*([^!]+)!important/);
  return m ? m[1].trim() : null;
}

async function flushMicrotasks() {
  // Two ticks: one for the sync.get callback, one for the chained local.get.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  for (const k of Object.keys(syncStore)) delete syncStore[k];
  for (const k of Object.keys(localStore)) delete localStore[k];
  listeners.length = 0;
  document.getElementById('gv-chat-font-family')?.remove();
  document.getElementById('gv-chat-font-family-face')?.remove();
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
  document.getElementById('gv-chat-font-family')?.remove();
  document.getElementById('gv-chat-font-family-face')?.remove();
});

describe('chatFontFamily', () => {
  it('does not inject any styles when disabled', async () => {
    mountChatGptShape();
    syncStore.gvChatFontFamilyEnabled = false;
    syncStore.gvChatFontFamily = 'claude';
    startChatFontFamilyAdjuster();
    await flushMicrotasks();
    expect(document.getElementById('gv-chat-font-family')).toBeNull();
  });

  it('applies the gemini preset stack to user bubble, assistant markdown, and composer', async () => {
    mountChatGptShape();
    syncStore.gvChatFontFamilyEnabled = true;
    syncStore.gvChatFontFamily = 'gemini';
    startChatFontFamilyAdjuster();
    await flushMicrotasks();
    const stack = getRuleStack();
    expect(stack).not.toBeNull();
    expect(stack).toContain('Google Sans');
    // The injected CSS targets the three known surfaces — assert by
    // selector substring rather than computed styles (jsdom doesn't
    // resolve @import / inheritance fully).
    const css = document.getElementById('gv-chat-font-family')!.textContent!;
    expect(css).toContain('[data-message-author-role="user"] .user-message-bubble-color');
    expect(css).toContain('[data-message-author-role="assistant"] .markdown');
    expect(css).toContain('#prompt-textarea');
  });

  it('applies the claude preset (serif) stack', async () => {
    mountChatGptShape();
    syncStore.gvChatFontFamilyEnabled = true;
    syncStore.gvChatFontFamily = 'claude';
    startChatFontFamilyAdjuster();
    await flushMicrotasks();
    const stack = getRuleStack();
    expect(stack).toContain('Tiempos Text');
    expect(stack).toContain('serif');
  });

  it('excludes code / pre / .cm-content from the override', async () => {
    mountChatGptShape();
    syncStore.gvChatFontFamilyEnabled = true;
    syncStore.gvChatFontFamily = 'gemini';
    startChatFontFamilyAdjuster();
    await flushMicrotasks();
    const css = document.getElementById('gv-chat-font-family')!.textContent!;
    expect(css).toMatch(/:not\(pre\)/);
    expect(css).toMatch(/:not\(code\)/);
    expect(css).toMatch(/:not\(\.cm-content\)/);
  });

  it('emits an @font-face block when the custom preset has a loaded font', async () => {
    mountChatGptShape();
    syncStore.gvChatFontFamilyEnabled = true;
    syncStore.gvChatFontFamily = 'custom';
    syncStore.gvChatCustomFontName = 'My Cool Font';
    syncStore.gvChatCustomFontFormat = 'woff2';
    localStore.gvChatCustomFontData = 'data:font/woff2;base64,AAAA';
    startChatFontFamilyAdjuster();
    await flushMicrotasks();
    const face = document.getElementById('gv-chat-font-family-face');
    expect(face).not.toBeNull();
    expect(face!.textContent).toContain('@font-face');
    expect(face!.textContent).toContain('gv-custom-chat-font');
    expect(face!.textContent).toContain('My Cool Font');
    expect(face!.textContent).toContain("format('woff2')");
  });

  it('falls back to a system stack when "custom" is selected but no font is imported', async () => {
    mountChatGptShape();
    syncStore.gvChatFontFamilyEnabled = true;
    syncStore.gvChatFontFamily = 'custom';
    // No custom name / data set
    startChatFontFamilyAdjuster();
    await flushMicrotasks();
    const stack = getRuleStack();
    expect(stack).toContain('system-ui');
    // No @font-face block when there are no bytes to register.
    expect(document.getElementById('gv-chat-font-family-face')).toBeNull();
  });

  it('removes both <style> blocks when the user disables the feature', async () => {
    mountChatGptShape();
    syncStore.gvChatFontFamilyEnabled = true;
    syncStore.gvChatFontFamily = 'gemini';
    startChatFontFamilyAdjuster();
    await flushMicrotasks();
    expect(document.getElementById('gv-chat-font-family')).not.toBeNull();
    // Now toggle off via the storage change pathway.
    syncStore.gvChatFontFamilyEnabled = false;
    fireChange('sync', { gvChatFontFamilyEnabled: false });
    expect(document.getElementById('gv-chat-font-family')).toBeNull();
    expect(document.getElementById('gv-chat-font-family-face')).toBeNull();
  });

  it('reapplies when the preset changes at runtime', async () => {
    mountChatGptShape();
    syncStore.gvChatFontFamilyEnabled = true;
    syncStore.gvChatFontFamily = 'gemini';
    startChatFontFamilyAdjuster();
    await flushMicrotasks();
    expect(getRuleStack()).toContain('Google Sans');
    syncStore.gvChatFontFamily = 'claude';
    fireChange('sync', { gvChatFontFamily: 'claude' });
    expect(getRuleStack()).toContain('Tiempos Text');
  });

  it('coerces invalid preset values to "default" (which removes the style)', async () => {
    mountChatGptShape();
    syncStore.gvChatFontFamilyEnabled = true;
    syncStore.gvChatFontFamily = 'something-bogus-from-an-old-build';
    startChatFontFamilyAdjuster();
    await flushMicrotasks();
    // default → null stack → no <style>
    expect(document.getElementById('gv-chat-font-family')).toBeNull();
  });
});
