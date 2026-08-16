import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('popup viewport sizing', () => {
  it('uses a concrete extension-popup height instead of a circular viewport unit', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/pages/popup/index.css'), 'utf8');

    expect(css).toMatch(/html,\s*body\s*{[^}]*height:\s*600px/s);
    expect(css).toMatch(/#__root\s*{[^}]*height:\s*100%/s);
    expect(css).toMatch(
      /html\[data-settings-surface='window'\][^{]*,[^{]*body\s*{[^}]*height:\s*100vh/s,
    );
  });

  it('marks the explicit fallback window so its footer fits the real viewport', () => {
    const background = readFileSync(
      resolve(process.cwd(), 'src/pages/background/index.ts'),
      'utf8',
    );
    const entry = readFileSync(resolve(process.cwd(), 'src/pages/popup/index.tsx'), 'utf8');

    expect(background).toContain('?surface=window');
    expect(entry).toContain("document.documentElement.dataset.settingsSurface = 'window'");
  });

  it('keeps the support popover centered inside the popup viewport', () => {
    const popup = readFileSync(resolve(process.cwd(), 'src/pages/popup/Popup.tsx'), 'utf8');

    expect(popup).toContain('fixed bottom-12 left-1/2');
    expect(popup).toContain('w-[min(20rem,calc(100vw-2rem))]');
    expect(popup).toContain('-translate-x-1/2');
    expect(popup).not.toContain('absolute right-0 bottom-6 z-50 w-80');
  });
});
