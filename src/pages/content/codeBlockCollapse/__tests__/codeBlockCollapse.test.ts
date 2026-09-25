import { afterEach, describe, expect, it } from 'vitest';

import { processLongCodeBlocks, stopCodeBlockCollapse } from '../index';

/** ChatGPT 2026-09 code block: sticky header + scroller with `<code>` directly (no `<pre>`). */
function renderAppShellCodeBlock(lines: number): HTMLElement {
  const host = document.createElement('div');
  host.setAttribute('data-markdown-copy', 'code-block');
  host.innerHTML = `
    <div data-markdown-copy="exclude" class="sticky flex">
      <div class="min-w-0 flex-1 truncate">纯文本</div>
      <div class="ms-auto flex"><div class="flex items-center" id="actions">
        <span class="contents" style="display: contents"><button type="button" aria-label="复制">copy</button></span>
      </div></div>
    </div>
    <div class="overflow-auto" dir="ltr"><code class="CodeContent-x"></code></div>`;
  host.querySelector('code')!.textContent = Array.from(
    { length: lines },
    (_, i) => `line ${i}`,
  ).join('\n');
  document.body.appendChild(host);
  return host;
}

describe('long code block collapse — 2026-09 layout', () => {
  afterEach(() => {
    stopCodeBlockCollapse();
    document.body.innerHTML = '';
  });

  it('adds the toggle to the header row, beside the display:contents wrappers', () => {
    const host = renderAppShellCodeBlock(40);
    processLongCodeBlocks();

    const toggle = host.querySelector<HTMLButtonElement>('.gv-code-block-toggle');
    expect(toggle).not.toBeNull();
    expect(toggle!.parentElement?.id).toBe('actions');
    expect(host.hasAttribute('data-gv-code-collapsible')).toBe(true);

    toggle!.click();
    expect(host.hasAttribute('data-gv-code-collapsed')).toBe(true);
    toggle!.click();
    expect(host.hasAttribute('data-gv-code-collapsed')).toBe(false);
  });

  it('leaves short blocks alone', () => {
    const host = renderAppShellCodeBlock(5);
    processLongCodeBlocks();
    expect(host.querySelector('.gv-code-block-toggle')).toBeNull();
    expect(host.hasAttribute('data-gv-code-collapsible')).toBe(false);
  });
});
