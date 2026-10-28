import {
  APPROVAL_IGNORED_SELECTOR,
  DRIVE_APPROVAL_CARD_SELECTOR as CARD_SELECTOR,
  findDriveApprovalRequest,
} from '../shared/driveApprovalCard';

let cleanup: (() => void) | null = null;

interface RequestState {
  signature: string;
  path: string;
  button: HTMLButtonElement;
  attempts: number;
  lastAttemptAt: number | null;
  stopped: boolean;
}

export function startDriveAutoAllow(): () => void {
  if (cleanup) return cleanup;
  let running = true;
  let dispatching = false;
  const timers = new Map<Element, number>();
  const requests = new WeakMap<Element, RequestState>();
  const cancel = (card: Element) => {
    window.clearTimeout(timers.get(card));
    timers.delete(card);
  };

  const record = async (tool: string, path: string, result: '点击' | '失败') => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'gv.driveApproval.record',
        payload: { time: new Date().toISOString(), tool, path, result },
      });
      if (!response?.ok) throw new Error(response?.error || 'record rejected');
    } catch (error) {
      console.error('[GPT-Voyager] Drive approval record failed:', error);
    }
  };

  const checkCard = (card: Element) => {
    if (!running) return;
    const request = findDriveApprovalRequest(card);
    if (!request) {
      cancel(card);
      return;
    }
    let state = requests.get(card);
    if (!state || state.signature !== request.signature) {
      cancel(card);
      state = {
        signature: request.signature,
        path: location.pathname,
        button: request.button,
        attempts: 0,
        lastAttemptAt: null,
        stopped: false,
      };
      requests.set(card, state);
    }
    if (state.stopped || state.path !== location.pathname || !request.enabled) {
      cancel(card);
      return;
    }
    if (state.button !== request.button) {
      cancel(card);
      state.button = request.button;
    }
    if (timers.has(card)) return;
    const activeState = state;
    const cooldown =
      state.lastAttemptAt === null ? 0 : Math.max(0, state.lastAttemptAt + 4_000 - Date.now());
    // Give React time to finish mounting. Never dispatch inside the observer.
    const timer = window.setTimeout(
      () => {
        timers.delete(card);
        if (!running || requests.get(card) !== activeState || activeState.stopped) return;
        if (activeState.path !== location.pathname) return;
        const current = findDriveApprovalRequest(card);
        if (!current || !current.enabled) return;
        if (current.signature !== activeState.signature || current.button !== activeState.button) {
          checkCard(card); // A replacement request/button gets its own full delay.
          return;
        }
        if (activeState.attempts >= 3) {
          activeState.stopped = true;
          // This records exhausted attempts, not proof that the server rejected them.
          void record(current.tool, activeState.path, '失败');
          return;
        }
        activeState.attempts += 1;
        activeState.lastAttemptAt = Date.now();
        try {
          dispatching = true;
          current.button.click();
          void record(current.tool, activeState.path, '点击');
        } catch {
          void record(current.tool, activeState.path, '失败');
        } finally {
          dispatching = false;
        }
        checkCard(card); // Bounded retries, with a fresh check and a longer cooldown.
      },
      cooldown + 1_000 + Math.floor(Math.random() * 2_001),
    );
    timers.set(card, timer);
  };

  const onClick = (event: MouseEvent) => {
    if (dispatching) return;
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest('button');
    const card = button?.closest(CARD_SELECTOR);
    if (!card || !button?.closest('form')) return; // Details is not an approval action.
    cancel(card);
    const request = findDriveApprovalRequest(card);
    if (request) {
      // Respect manual Allow once / Deny / dropdown choices without intercepting them.
      requests.set(card, {
        signature: request.signature,
        path: location.pathname,
        button: request.button,
        attempts: 0,
        lastAttemptAt: null,
        stopped: true,
      });
    }
  };

  const collectCards = (root: Element, cards: Set<Element>) => {
    if (root.closest(APPROVAL_IGNORED_SELECTOR)) return;
    const parent = root.closest(CARD_SELECTOR);
    if (parent) cards.add(parent);
    root.querySelectorAll(CARD_SELECTOR).forEach((card) => cards.add(card));
  };

  const observer = new MutationObserver((records) => {
    const cards = new Set<Element>();
    const added = new Set<Element>();
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (target?.closest(APPROVAL_IGNORED_SELECTOR)) continue;
      const card = target?.closest(CARD_SELECTOR);
      if (card) cards.add(card);
      // Unrelated class churn must not cause subtree/document rescans.
      if (target && record.type === 'attributes' && !card && record.attributeName !== 'class') {
        added.add(target);
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element) added.add(node);
      }
    }
    // Inspect only newly inserted subtrees, once per delivered mutation batch.
    // Streaming text outside a card never causes a document-wide query.
    for (const root of added) {
      let parent = root.parentElement;
      while (parent && !added.has(parent)) parent = parent.parentElement;
      if (!parent) collectCards(root, cards);
    }
    cards.forEach(checkCard);
    // Only pending cards are checked here, never the whole document.
    for (const card of timers.keys()) {
      const state = requests.get(card);
      if (!card.isConnected || state?.path !== location.pathname) cancel(card);
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['disabled', 'aria-disabled', 'hidden', 'aria-hidden', 'class'],
  });
  document.addEventListener('click', onClick, true);
  const initialCards = new Set<Element>();
  collectCards(document.body, initialCards);
  initialCards.forEach(checkCard);

  // Browser suspension can delay both timers and observers until JS resumes.
  cleanup = () => {
    running = false;
    observer.disconnect();
    document.removeEventListener('click', onClick, true);
    timers.forEach((timer) => window.clearTimeout(timer));
    timers.clear();
    cleanup = null;
  };
  return cleanup;
}

export function stopDriveAutoAllow(): void {
  cleanup?.();
}
