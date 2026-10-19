import { afterEach, describe, expect, it, vi } from 'vitest';

import { startDriveAutoAllow, stopDriveAutoAllow } from '../index';

// Structural fixture from the supplied 2026-10-20 sample; no live approval.
function addCard(provider = 'Google Drive', label = '始终允许') {
  const card = document.createElement('div');
  card.className = 'flex @container/approval-card';
  card.innerHTML = `<div><div role="alert"><div><span>${provider}</span></div>
    <div>允许 ChatGPT 使用 ${provider} 吗？ Upload File</div></div></div>
    <form class="@max-md/approval-card:flex-col"><button type="button"><span>${label}</span></button>
    <button type="button">拒绝 <kbd>Esc</kbd></button>
    <button type="button">允许一次 <kbd>⏎</kbd></button></form>`;
  const button = card.querySelector('button')!;
  const click = vi.fn();
  button.addEventListener('click', click);
  document.body.appendChild(card);
  return { card, button, click };
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

afterEach(() => {
  stopDriveAutoAllow();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('Google Drive auto-allow', () => {
  it.each(['始终允许', 'Always allow'])('handles the recorded card with %s once', async (label) => {
    const { card, click } = addCard('Google Drive', label);
    const otherClick = vi.fn();
    card.querySelectorAll('button')[2].addEventListener('click', otherClick);
    startDriveAutoAllow();
    startDriveAutoAllow();
    card.querySelector('[role="alert"]')!.append(' updated');
    await flush();
    expect(click).toHaveBeenCalledTimes(1);
    expect(otherClick).not.toHaveBeenCalled();
  });

  it('handles newly rendered cards even when the tab is hidden', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    startDriveAutoAllow();
    const { click } = addCard();
    await flush();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('waits for hydrated text and an enabled button', async () => {
    startDriveAutoAllow();
    const { card, button, click } = addCard('Google Drive', 'Loading');
    button.disabled = true;
    await flush();
    button.firstElementChild!.firstChild!.textContent = 'Always allow';
    await flush();
    expect(click).not.toHaveBeenCalled();
    button.disabled = false;
    await flush();
    expect(click).toHaveBeenCalledTimes(1);
    card.remove();
    const next = addCard();
    await flush();
    expect(next.click).toHaveBeenCalledTimes(1);
  });

  it('ignores other providers, ordinary content, ambiguous and disabled actions', () => {
    const other = addCard('Gmail');
    other.card.querySelector('[role="alert"]')!.append(' Google Drive');
    const ordinary = addCard();
    ordinary.card.className = 'message';
    const ambiguous = addCard();
    ambiguous.button.after(ambiguous.button.cloneNode(true));
    const disabled = addCard();
    disabled.button.setAttribute('aria-disabled', 'true');
    const once = addCard('Google Drive', 'Allow once');
    const hidden = addCard();
    hidden.card.hidden = true;
    startDriveAutoAllow();
    for (const fixture of [other, ordinary, ambiguous, disabled, once, hidden]) {
      expect(fixture.click).not.toHaveBeenCalled();
    }
  });

  it('disconnects on stop and can be enabled again', async () => {
    startDriveAutoAllow();
    const pending = addCard();
    stopDriveAutoAllow();
    await flush();
    expect(pending.click).not.toHaveBeenCalled();
    startDriveAutoAllow();
    expect(pending.click).toHaveBeenCalledTimes(1);
  });

  it('handles an existing card when its hidden wrapper is revealed', async () => {
    const wrapper = document.createElement('div');
    wrapper.hidden = true;
    document.body.appendChild(wrapper);
    const { card, click } = addCard();
    wrapper.appendChild(card);
    startDriveAutoAllow();
    expect(click).not.toHaveBeenCalled();
    wrapper.hidden = false;
    await flush();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('does not rescan the document for unrelated streamed text', async () => {
    const message = document.createElement('div');
    message.textContent = 'stream';
    document.body.appendChild(message);
    startDriveAutoAllow();
    const scan = vi.spyOn(document.body, 'querySelectorAll');
    message.firstChild!.textContent = 'streaming';
    await flush();
    expect(scan).not.toHaveBeenCalled();
  });
});
