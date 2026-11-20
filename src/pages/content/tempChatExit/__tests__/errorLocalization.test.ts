import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import frMessages from '@/locales/fr/messages.json';
import { extractMessageDictionary } from '@/utils/localeMessages';
import { installTranslations } from '@/utils/translations';

import { runTempChatRegret } from '../orchestrator';

function mountConversation(options: { scrollable?: boolean; busy?: boolean; stuck?: boolean } = {}) {
  document.body.innerHTML = `
    <main>
      <div id="test-scroll">
        <div data-message-author-role="user" data-message-id="question">Keep the user's question.</div>
        <div data-message-author-role="assistant" data-message-id="answer">Keep the original response.</div>
      </div>
      <textarea id="prompt-textarea">Keep the unsent draft.</textarea>
    </main>`;
  const scroll = document.querySelector<HTMLElement>('#test-scroll')!;
  if (options.scrollable) {
    scroll.style.overflowY = 'auto';
    Object.defineProperties(scroll, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 2000 },
    });
  }
  if (options.busy) scroll.setAttribute('aria-busy', 'true');
  if (options.stuck) Object.defineProperty(scroll, 'scrollTop', { get: () => 0, set: () => {} });
  return scroll;
}

function confirmActualFlow(): Promise<void> {
  const operation = runTempChatRegret();
  const confirm = document.querySelector<HTMLButtonElement>('.gv-temp-regret-modal__btn--primary');
  expect(confirm).not.toBeNull();
  confirm!.click();
  return operation;
}

function visibleFailure(): string | null {
  return document.querySelector('.gv-temp-regret-overlay__toast--error')?.textContent ?? null;
}

function expectDataUntouched(): void {
  expect(document.querySelector<HTMLTextAreaElement>('#prompt-textarea')?.value).toBe('Keep the unsent draft.');
  expect(document.querySelector('[data-message-id="question"]')?.textContent).toBe("Keep the user's question.");
  expect(sessionStorage.getItem('gv-pending-temp-regret-handoff')).toBeNull();
  expect(window.location.search).toBe('?temporary-chat=true');
}

describe('temporary-chat collection failures shown to the user', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installTranslations(extractMessageDictionary(frMessages));
    window.history.replaceState({}, '', '/?temporary-chat=true');
    sessionStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/');
  });

  it('shows French for the actual bottom-settle timeout and keeps the original diagnostic', async () => {
    mountConversation();
    const generating = document.createElement('button');
    generating.dataset.testid = 'stop-button';
    document.body.appendChild(generating);
    const operation = confirmActualFlow();
    await vi.advanceTimersByTimeAsync(120_000);
    await operation;
    expect(visibleFailure()).toBe('Échec de l’opération: Le délai de collecte a expiré avant la fin de la mise à jour de la conversation.');
    expect(console.error).toHaveBeenCalledWith(
      '[GPT-Voyager] temp-chat regret failed',
      expect.objectContaining({ message: 'conversation did not settle before the collection timeout' }),
    );
    expectDataUntouched();
  }, 20_000);

  it('shows French when history never finishes loading and restores the original scroll position', async () => {
    const scroll = mountConversation({ scrollable: true });
    const loading = document.createElement('div');
    loading.setAttribute('aria-busy', 'true');
    scroll.appendChild(loading);
    scroll.scrollTop = 75;
    const operation = confirmActualFlow();
    await vi.advanceTimersByTimeAsync(15_000);
    await operation;
    expect(visibleFailure()).toBe('Échec de l’opération: Le délai de collecte a expiré avant la fin du chargement de l’historique de la conversation.');
    expect(scroll.scrollTop).toBe(75);
    expect(console.error).toHaveBeenCalledWith(
      '[GPT-Voyager] temp-chat regret failed',
      expect.objectContaining({ message: 'conversation history did not settle before the collection timeout' }),
    );
    expectDataUntouched();
  });

  it('localizes a real stalled collection and substitutes its actual message count', async () => {
    mountConversation({ scrollable: true, stuck: true });
    const operation = confirmActualFlow();
    await vi.advanceTimersByTimeAsync(2_500);
    await operation;
    expect(visibleFailure()).toBe('Échec de l’opération: La collecte de la conversation s’est arrêtée prématurément (2 messages trouvés).');
    expect(console.error).toHaveBeenCalledWith(
      '[GPT-Voyager] temp-chat regret failed',
      expect.objectContaining({ message: 'conversation collection stopped early (2 messages found)' }),
    );
    expectDataUntouched();
  });

  it('preserves an external error even when its text resembles our internal diagnostic', async () => {
    mountConversation();
    const nativeMessage = 'conversation did not settle before the collection timeout';
    vi.spyOn(document.querySelector('[data-message-id="question"]')!, 'cloneNode').mockImplementation(() => {
      throw new Error(nativeMessage);
    });
    await confirmActualFlow();
    expect(visibleFailure()).toBe(`Échec de l’opération: ${nativeMessage}`);
    expectDataUntouched();
  });
});
