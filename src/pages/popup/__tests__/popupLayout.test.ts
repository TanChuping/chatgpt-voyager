import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('popup viewport sizing', () => {
  it('uses a concrete extension-popup height instead of a circular viewport unit', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/pages/popup/index.css'), 'utf8');

    expect(css).toMatch(/html,\s*body\s*{[^}]*height:\s*600px/s);
    expect(css).toMatch(/#__root\s*{[^}]*height:\s*100%/s);
    expect(css).not.toContain('100vh');
  });
});
