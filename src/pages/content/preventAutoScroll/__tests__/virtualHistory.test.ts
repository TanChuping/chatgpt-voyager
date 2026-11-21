import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';

it('allows virtual history to preserve the reading position while blocking follow-to-bottom', () => {
  const dom = new JSDOM('<div id="gv-prevent-auto-scroll-bridge" data-enabled="true"></div>', {
    runScripts: 'outside-only',
  });
  try {
    const { window } = dom;
    const thread = window.document.createElement('div');
    thread.className = 'thread-scroll-container';
    Object.defineProperties(thread, {
      clientHeight: { value: 600 },
      scrollHeight: { value: 30000 },
    });
    window.Element.prototype.scrollBy = function (options: ScrollToOptions) {
      this.scrollTop += options.top ?? 0;
    };
    window.Element.prototype.scrollTo = function (options: ScrollToOptions) {
      this.scrollTop = options.top ?? 0;
    };
    thread.scrollTop = 3200;
    window.eval(readFileSync(resolve('public/prevent-auto-scroll.js'), 'utf8'));
    thread.scrollTop += 12000;
    expect(thread.scrollTop).toBe(15200);
    thread.scrollBy({ top: 3000 });
    expect(thread.scrollTop).toBe(18200);
    thread.scrollTo({ top: 20300 });
    expect(thread.scrollTop).toBe(20300);
    thread.scrollTo({ top: thread.scrollHeight });
    expect(thread.scrollTop).toBe(20300);
    window.document.getElementById('gv-prevent-auto-scroll-bridge')!.dataset.enabled = 'false';
    thread.scrollTop = 29400;
    expect(thread.scrollTop).toBe(29400);
  } finally {
    dom.window.close();
  }
});
