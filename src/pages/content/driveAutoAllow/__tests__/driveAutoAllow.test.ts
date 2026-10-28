import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import { appendDriveApprovalRecord } from '@/pages/background/driveApprovalLog';

import { startDriveAutoAllow, stopDriveAutoAllow } from '../index';

// Structural fixture from the supplied 2026-10-20 sample; no live approval.
function addCard(provider = 'Google Drive', label = '始终允许', tool = 'Upload File') {
  const card = document.createElement('div');
  card.className = 'flex @container/approval-card';
  card.innerHTML = `<div><div role="alert"><svg></svg><span>${provider}</span>
    <div>允许 ChatGPT 使用 ${provider} 吗？</div><button>查看详情</button></div></div>
    <div class="tool-request">ChatGPT 将调用 ${provider} 的 ${tool} 工具。</div>
    <form class="@max-md/approval-card:flex-col"><button type="button"><span>${label}</span></button>
    <button type="button">拒绝 <kbd>Esc</kbd></button>
    <button type="button">允许一次 <kbd>⏎</kbd></button></form>`;
  const button = card.querySelector<HTMLButtonElement>('form button')!;
  const click = vi.fn();
  button.addEventListener('click', click);
  document.body.appendChild(card);
  return { card, button, click };
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  chrome.runtime.sendMessage = vi.fn().mockResolvedValue({ ok: true });
});

afterEach(() => {
  stopDriveAutoAllow();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Google Drive auto-allow', () => {
  it.each(['始终允许', 'Always allow'])(
    'delays %s and never clicks other actions',
    async (label) => {
      const { card, click } = addCard('Google Drive', label);
      const otherClick = vi.fn();
      card.querySelectorAll('form button')[2].addEventListener('click', otherClick);
      startDriveAutoAllow();
      startDriveAutoAllow();
      card.querySelector('[role="alert"]')!.append(' updated');
      await flush();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(click).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(click).toHaveBeenCalledTimes(1);
      expect(otherClick).not.toHaveBeenCalled();
    },
  );

  it.each([
    [0, 1_000],
    [0.99999, 3_000],
  ])('uses random %s for delay %s', async (random, delay) => {
    vi.mocked(Math.random).mockReturnValue(random);
    const { click } = addCard();
    startDriveAutoAllow();
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(click).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('handles newly rendered cards in a hidden tab', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    startDriveAutoAllow();
    const { click } = addCard();
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('waits for hydrated tool, label and enabled state', async () => {
    const { card, button, click } = addCard('Google Drive', 'Loading');
    card.querySelector('.tool-request')!.textContent = 'Loading';
    button.disabled = true;
    startDriveAutoAllow();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(click).not.toHaveBeenCalled();
    button.firstElementChild!.firstChild!.textContent = 'Always allow';
    card.querySelector('.tool-request')!.textContent =
      "ChatGPT will call Google Drive's Update File tool.";
    button.disabled = false;
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('ignores other providers, ordinary messages, ambiguous and disabled actions', async () => {
    const other = addCard('Gmail');
    other.card
      .querySelector('[role="alert"]')!
      .insertAdjacentHTML('beforeend', '<span>Google Drive</span>');
    const ordinary = addCard();
    ordinary.card.className = 'message';
    const ambiguous = addCard();
    ambiguous.button.after(ambiguous.button.cloneNode(true));
    const disabled = addCard();
    disabled.button.setAttribute('aria-disabled', 'true');
    const once = addCard('Google Drive', 'Allow once');
    const hidden = addCard();
    hidden.card.hidden = true;
    const reordered = addCard();
    const deny = document.createElement('button');
    deny.textContent = '拒绝';
    reordered.button.before(deny);
    startDriveAutoAllow();
    await vi.advanceTimersByTimeAsync(30_000);
    for (const fixture of [other, ordinary, ambiguous, disabled, once, hidden, reordered]) {
      expect(fixture.click).not.toHaveBeenCalled();
    }
  });

  it('retries gently up to three times without mutations shortening the delay', async () => {
    const { card, click } = addCard();
    startDriveAutoAllow();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(click).toHaveBeenCalledTimes(1);
    card.append('updated');
    await flush();
    await vi.advanceTimersByTimeAsync(5_999);
    expect(click).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(click).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(click).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    card.append('updated again');
    await flush();
    expect(click).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    const payloads = vi
      .mocked(chrome.runtime.sendMessage)
      .mock.calls.map(([message]) => message.payload);
    expect(payloads.map((entry) => entry.result)).toEqual(['点击', '点击', '点击', '失败']);
    expect(payloads[0]).toEqual({
      time: expect.any(String),
      tool: 'Upload File',
      path: location.pathname,
      result: '点击',
    });
  });

  it('gives a changed tool a fresh delay and independent retry budget', async () => {
    const { card, click } = addCard();
    startDriveAutoAllow();
    await vi.advanceTimersByTimeAsync(1_500);
    card.querySelector('.tool-request')!.textContent =
      'ChatGPT 将调用 Google Drive 的 Update File 工具。';
    await flush();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(click).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chrome.runtime.sendMessage).mock.calls[0][0].payload.tool).toBe('Update File');
  });

  it('revalidates even if the DOM observer did not deliver a change', async () => {
    vi.spyOn(globalThis, 'MutationObserver').mockImplementation(function () {
      return { observe: vi.fn(), disconnect: vi.fn(), takeRecords: () => [] } as MutationObserver;
    });
    const { card, click } = addCard();
    startDriveAutoAllow();
    card.querySelector('[role="alert"] span')!.textContent = 'Gmail';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(click).not.toHaveBeenCalled();
  });

  it('waits again on button replacement and retains the retry budget', async () => {
    const { button, click } = addCard();
    startDriveAutoAllow();
    await vi.advanceTimersByTimeAsync(2_000);
    const replacement = button.cloneNode(true) as HTMLButtonElement;
    const replacedClick = vi.fn();
    replacement.addEventListener('click', replacedClick);
    button.replaceWith(replacement);
    await flush();
    await vi.advanceTimersByTimeAsync(5_999);
    expect(replacedClick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(click).toHaveBeenCalledTimes(1);
    expect(replacedClick).toHaveBeenCalledTimes(2);
  });

  it('does not click removed or disabled cards and resumes when enabled', async () => {
    const removed = addCard();
    const disabled = addCard();
    startDriveAutoAllow();
    removed.card.remove();
    disabled.button.disabled = true;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(removed.click).not.toHaveBeenCalled();
    expect(disabled.click).not.toHaveBeenCalled();
    disabled.button.disabled = false;
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(disabled.click).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 2])('yields to a manual form action %s', async (index) => {
    const { card, click } = addCard();
    startDriveAutoAllow();
    await vi.advanceTimersByTimeAsync(500);
    card.querySelectorAll<HTMLButtonElement>('form button')[index].click();
    card.append('changed');
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(click).toHaveBeenCalledTimes(index === 0 ? 1 : 0);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('detects class hydration and revealed wrappers without polling', async () => {
    const late = addCard();
    late.card.className = 'pending';
    const hidden = addCard();
    const wrapper = document.createElement('div');
    wrapper.hidden = true;
    document.body.append(wrapper);
    wrapper.append(hidden.card);
    startDriveAutoAllow();
    expect(vi.getTimerCount()).toBe(0);
    late.card.className = '@container/approval-card';
    wrapper.hidden = false;
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(late.click).toHaveBeenCalledTimes(1);
    expect(hidden.click).toHaveBeenCalledTimes(1);
  });

  it('ignores code blocks and editors and never mutates their DOM', async () => {
    const wrappers = ['pre', 'code', 'div', 'section'].map((tag, index) => {
      const node = document.createElement(tag);
      if (index === 2) node.setAttribute('data-markdown-copy', 'code-block');
      if (index === 3) node.setAttribute('contenteditable', 'true');
      document.body.append(node);
      return node;
    });
    const fixtures = wrappers.map((node) => {
      const fixture = addCard();
      node.append(fixture.card);
      return fixture;
    });
    const original = document.body.innerHTML;
    const mutations = vi.fn();
    const watcher = new MutationObserver(mutations);
    watcher.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    startDriveAutoAllow();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(document.body.innerHTML).toBe(original);
    expect(mutations).not.toHaveBeenCalled();
    for (const fixture of fixtures) expect(fixture.click).not.toHaveBeenCalled();
    const scan = vi.spyOn(wrappers[0], 'querySelectorAll');
    wrappers[0].append(document.createElement('span'));
    await flush();
    expect(scan).not.toHaveBeenCalled();
    watcher.disconnect();
  });

  it('does not rescan for unrelated text or class churn and installs no interval', async () => {
    const message = document.createElement('div');
    message.textContent = 'stream';
    document.body.append(message);
    startDriveAutoAllow();
    const scan = vi.spyOn(document.body, 'querySelectorAll');
    const localScan = vi.spyOn(message, 'querySelectorAll');
    message.firstChild!.textContent = 'streaming';
    message.className = 'changed';
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(scan).not.toHaveBeenCalled();
    expect(localScan).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels pending clicks and retries when disabled, and allows re-enabling', async () => {
    const { click } = addCard();
    startDriveAutoAllow();
    stopDriveAutoAllow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(click).not.toHaveBeenCalled();
    startDriveAutoAllow();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(click).toHaveBeenCalledTimes(1);
    stopDriveAutoAllow();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(click).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not click after navigation away from the original conversation', async () => {
    const { click } = addCard();
    startDriveAutoAllow();
    const original = location.pathname;
    window.history.pushState({}, '', '/c/other');
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(click).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState({}, '', original);
    }
  });
});

describe('Drive approval ring records', () => {
  // 守: concurrent tabs share one writer, retaining only the last 50 metadata records.
  it('serializes writes, keeps 50 entries, and strips extra conversation data', async () => {
    const key = StorageKeys.DRIVE_AUTO_ALLOW_LOG;
    let data: Record<string, unknown> = {};
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ ...data }));
    vi.mocked(chrome.storage.local.set).mockImplementation(async (items) => {
      data = { ...data, ...items };
    });
    await Promise.all(
      Array.from({ length: 55 }, (_, i) =>
        appendDriveApprovalRecord({
          time: new Date(1_700_000_000_000 + i).toISOString(),
          tool: `Tool ${i}`,
          path: '/c/example',
          result: '点击',
          content: 'must not be stored',
        }),
      ),
    );
    const history = data[key] as Record<string, unknown>[];
    expect(history).toHaveLength(50);
    expect(history[0].tool).toBe('Tool 5');
    expect(history[49].tool).toBe('Tool 54');
    expect(Object.keys(history[0]).sort()).toEqual(['path', 'result', 'time', 'tool']);
  });

  it('rejects invalid records and recovers after a failed storage write', async () => {
    const entry = {
      time: new Date().toISOString(),
      tool: 'Upload File',
      path: '/c/test',
      result: '失败',
    };
    await expect(
      appendDriveApprovalRecord({ ...entry, path: '/c/test?content=secret' }),
    ).rejects.toThrow();
    vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(appendDriveApprovalRecord(entry)).rejects.toThrow('storage unavailable');
    vi.mocked(chrome.storage.local.get).mockResolvedValue({});
    vi.mocked(chrome.storage.local.set).mockResolvedValue(undefined);
    await expect(appendDriveApprovalRecord(entry)).resolves.toBeUndefined();
  });
});
