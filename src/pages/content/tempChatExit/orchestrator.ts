/**
 * "Temp Chat Regret" orchestrator.
 *
 * Drives the full flow from button click to a populated input box on a
 * fresh persistent chat:
 *
 *   1. Confirmation modal — "this will rebuild the temp chat as a
 *      hand-off prompt, page will be busy for a few seconds".
 *   2. Loading overlay (non-dismissable) while we:
 *      a. Scroll the conversation container to the top, repeatedly,
 *         waiting between scrolls for ChatGPT's virtualisation to
 *         render older turns into the DOM. Bail when no new turns
 *         have appeared for `IDLE_MS` or after `MAX_MS`.
 *      b. Walk the DOM in document order, pulling user + assistant
 *         turns out as plain text (turn text only — no formatting
 *         preservation beyond what `innerText` gives us; the goal is
 *         a hand-off prompt, not a lossless archive).
 *      c. Programmatically click the temp-chat toggle to leave temp
 *         mode. Wait for ChatGPT to settle (URL drops the
 *         `temporary-chat` param, the chat UI clears).
 *      d. Build the hand-off prompt via `promptBuilder.buildHandoffPrompt`
 *         and inject it into the chat input via the shared
 *         `setInputText` helper.
 *   3. Tear down the overlay. The user reviews the input and clicks
 *      send themselves (per design choice "只填进输入框，等用户亲手点
 *      发送").
 *
 * The flow is fully sync-from-user's-POV: no async fire-and-forget.
 * Any step that takes longer than its budget aborts with a toast.
 */

import { setInputText } from '../utils/inputHelper';
import { t } from './i18n';
import {
  type ExtractedTurn,
  type HandoffDelivery,
  type TurnRole,
  planHandoffDelivery,
} from './promptBuilder';

/* ---------------------------------------------------------------- */
/* Selectors / constants                                            */
/* ---------------------------------------------------------------- */

const TURN_SELECTOR =
  '[data-message-author-role="user"], [data-message-author-role="assistant"]';

const TEMP_TOGGLE_SELECTOR =
  '[data-testid="temporary-chat-toggle"], button[aria-label*="临时聊天"], button[aria-label*="temporary chat" i]';

const INPUT_SELECTOR = '#prompt-textarea, [contenteditable="true"][role="textbox"]';

const MODAL_CLASS = 'gv-temp-regret-modal';
const BACKDROP_CLASS = 'gv-temp-regret-modal__backdrop';
const OVERLAY_CLASS = 'gv-temp-regret-overlay';

const SCROLL_IDLE_MS = 600; // no new turns for this long → stop scrolling
const SCROLL_MAX_MS = 15_000; // hard cap on scroll-to-top phase
const SCROLL_POLL_MS = 200; // how often to check for new turns
const TOGGLE_SETTLE_MS = 1_500; // budget for ChatGPT to clear the temp UI

/* ---------------------------------------------------------------- */
/* Detection                                                         */
/* ---------------------------------------------------------------- */

export function isInTemporaryChatMode(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get('temporary-chat') === 'true') {
      return true;
    }
  } catch {
    /* malformed URL — fall through to DOM check */
  }
  const toggle = document.querySelector<HTMLElement>(TEMP_TOGGLE_SELECTOR);
  if (!toggle) return false;
  // The label flips: "关闭临时聊天" / "Close temporary chat" when temp
  // mode IS active; "开启..." / "Start temporary chat" when it is not.
  const label = (toggle.getAttribute('aria-label') || '').toLowerCase();
  return label.includes('关闭') || label.includes('close');
}

/* ---------------------------------------------------------------- */
/* DOM utilities                                                    */
/* ---------------------------------------------------------------- */

function findScrollContainer(): HTMLElement | null {
  // Walk up from any visible turn until we hit an ancestor whose
  // scrollHeight exceeds clientHeight AND has scrollable overflow-y.
  const anyTurn = document.querySelector<HTMLElement>(TURN_SELECTOR);
  let n: HTMLElement | null = anyTurn?.parentElement ?? null;
  while (n && n !== document.body) {
    const cs = window.getComputedStyle(n);
    if (
      (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
      n.scrollHeight > n.clientHeight + 4
    ) {
      return n;
    }
    n = n.parentElement;
  }
  return null;
}

function normalizeTurnText(el: HTMLElement): string {
  // Clone and strip noise that wouldn't help the next assistant
  // understand context: copy/share/regenerate action bars, reasoning
  // disclosure toggles ("Thought for 8s"), KaTeX hidden-source spans
  // (the visible math is in the rendered output, we don't need both),
  // and the small "Edit / Continue" affordance underneath user turns.
  const clone = el.cloneNode(true) as HTMLElement;
  const dropSelectors = [
    'button',
    '[role="button"]',
    'model-thoughts',
    '.thoughts-container',
    '.thoughts-content',
    '.katex-html', // visible-but-redundant — .katex-mathml carries the source
    'svg',
    'style',
    'script',
  ];
  for (const sel of dropSelectors) {
    clone.querySelectorAll(sel).forEach((n) => n.remove());
  }
  // innerText respects line breaks for block elements better than
  // textContent — we want paragraph boundaries to survive.
  const raw = (clone.innerText || clone.textContent || '').replace(/ /g, ' ');
  return raw
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTurnsFromDom(): ExtractedTurn[] {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(TURN_SELECTOR));
  // De-dupe by text content + role (ChatGPT sometimes re-mounts the same
  // turn during virtualisation reconciliation, briefly leaving two
  // copies of the same data-message-author-role in the DOM).
  const seen = new Set<string>();
  const out: ExtractedTurn[] = [];
  for (const el of nodes) {
    const role = el.getAttribute('data-message-author-role') as TurnRole | null;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = normalizeTurnText(el);
    if (!text) continue;
    const key = `${role}:${text.slice(0, 200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role, text });
  }
  return out;
}

/* ---------------------------------------------------------------- */
/* Scroll-to-top with virtualisation-load wait                      */
/* ---------------------------------------------------------------- */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function scrollToTopAndLoadAll(
  onProgress: (turnsLoaded: number) => void,
): Promise<void> {
  const start = Date.now();
  let lastChangeAt = Date.now();
  let lastCount = document.querySelectorAll(TURN_SELECTOR).length;
  onProgress(lastCount);

  while (Date.now() - start < SCROLL_MAX_MS) {
    const container = findScrollContainer();
    if (container) {
      // ChatGPT loads older turns when its inner scroll hits the top.
      // smooth scroll would be slower per step but easier on layout;
      // we use 'instant' (the default for non-string behaviour) since
      // we throttle ourselves with SCROLL_POLL_MS anyway.
      container.scrollTop = 0;
    }
    // Also nudge window scroll in case the page has a wider scroll
    // (some ChatGPT layouts make the whole page scroll on small
    // viewports rather than just the chat container).
    window.scrollTo({ top: 0, behavior: 'auto' });

    await sleep(SCROLL_POLL_MS);

    const count = document.querySelectorAll(TURN_SELECTOR).length;
    if (count !== lastCount) {
      lastCount = count;
      lastChangeAt = Date.now();
      onProgress(count);
    } else if (Date.now() - lastChangeAt >= SCROLL_IDLE_MS) {
      // No new turns for the idle window AND container is at top — done.
      const container2 = findScrollContainer();
      if (!container2 || container2.scrollTop <= 1) return;
      // Still some scroll left to climb — keep going one more tick.
    }
  }
}

/* ---------------------------------------------------------------- */
/* Toggle temp mode off                                             */
/* ---------------------------------------------------------------- */

async function leaveTemporaryMode(): Promise<boolean> {
  // Two cases:
  //  - Pre-message: the temp-chat-toggle button is in the header.
  //    Clicking it flips temp mode off and clears the (empty) chat.
  //  - Post-message: ChatGPT replaces the toggle with a conversation-
  //    options button, and the options menu only offers Share / View
  //    files — no in-place "leave temp mode". The cleanest exit is the
  //    sidebar's "新聊天 / New chat" link (`a[data-testid="create-new
  //    -chat-button"]` with href="/"), which the ChatGPT app routes
  //    client-side, leaving our content script alive.
  const toggle = document.querySelector<HTMLElement>(TEMP_TOGGLE_SELECTOR);
  if (toggle) {
    toggle.click();
    const start = Date.now();
    while (Date.now() - start < TOGGLE_SETTLE_MS) {
      if (!isInTemporaryChatMode()) return true;
      await sleep(80);
    }
    if (!isInTemporaryChatMode()) return true;
    // Fall through if the click didn't take effect (post-message state).
  }
  const newChat =
    document.querySelector<HTMLElement>('a[data-testid="create-new-chat-button"]') ||
    document.querySelector<HTMLAnchorElement>('a[href="/"][data-testid*="new" i]');
  if (newChat) {
    newChat.click();
  } else {
    // Last resort: full navigation. This reloads the page, but our
    // orchestrator stashes the prompt in sessionStorage before calling
    // us, and the bootstrap on the new page will pick it up via
    // `resumePendingHandoff`.
    window.location.href = '/';
  }
  const navStart = Date.now();
  while (Date.now() - navStart < TOGGLE_SETTLE_MS) {
    if (
      !isInTemporaryChatMode() &&
      document.querySelector<HTMLElement>(INPUT_SELECTOR)
    ) {
      return true;
    }
    await sleep(80);
  }
  return !isInTemporaryChatMode();
}

/* ---------------------------------------------------------------- */
/* Modal + overlay UI                                               */
/* ---------------------------------------------------------------- */

interface ConfirmHandle {
  destroy: () => void;
}

function showConfirmModal(args: {
  onConfirm: () => void;
  onCancel: () => void;
  turnCount: number;
}): ConfirmHandle {
  document.querySelectorAll(`.${BACKDROP_CLASS}`).forEach((b) => b.remove());

  const backdrop = document.createElement('div');
  backdrop.className = BACKDROP_CLASS;

  const card = document.createElement('div');
  card.className = MODAL_CLASS;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');

  const title = document.createElement('h2');
  title.className = `${MODAL_CLASS}__title`;
  title.textContent = t('tempChatRegretConfirmTitle');
  card.appendChild(title);

  // Body: build out of separate <p> elements so we can safely use
  // .textContent (no HTML injection from translation strings). The
  // detail line includes a `{count}` placeholder that gets substituted
  // here, not via innerHTML, so a Chinese translation containing `<`
  // or `&` can't break the markup.
  const body = document.createElement('div');
  body.className = `${MODAL_CLASS}__body`;

  const head = document.createElement('p');
  head.textContent = t('tempChatRegretConfirmBodyHead');
  body.appendChild(head);

  const detail = document.createElement('p');
  detail.textContent = t('tempChatRegretConfirmBodyDetail', { count: args.turnCount });
  body.appendChild(detail);

  const footerHint = document.createElement('p');
  footerHint.style.opacity = '0.7';
  footerHint.textContent = t('tempChatRegretConfirmBodyFooter');
  body.appendChild(footerHint);

  card.appendChild(body);

  const footer = document.createElement('footer');
  footer.className = `${MODAL_CLASS}__footer`;

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = `${MODAL_CLASS}__btn ${MODAL_CLASS}__btn--ghost`;
  cancelBtn.textContent = t('tempChatRegretConfirmCancel');
  footer.appendChild(cancelBtn);

  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = `${MODAL_CLASS}__btn ${MODAL_CLASS}__btn--primary`;
  okBtn.textContent = t('tempChatRegretConfirmContinue');
  footer.appendChild(okBtn);

  card.appendChild(footer);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  const handle: ConfirmHandle = {
    destroy: () => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
    },
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      handle.destroy();
      args.onCancel();
    }
  };
  document.addEventListener('keydown', onKey);
  cancelBtn.addEventListener('click', () => {
    handle.destroy();
    args.onCancel();
  });
  okBtn.addEventListener('click', () => {
    handle.destroy();
    args.onConfirm();
  });
  // Backdrop click cancels.
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) {
      handle.destroy();
      args.onCancel();
    }
  });
  // Focus the primary action for keyboard users.
  setTimeout(() => okBtn.focus(), 0);

  return handle;
}

interface OverlayHandle {
  setProgress: (msg: string) => void;
  destroy: () => void;
}

function showLoadingOverlay(initial: string): OverlayHandle {
  document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((b) => b.remove());

  const root = document.createElement('div');
  root.className = OVERLAY_CLASS;
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');

  const card = document.createElement('div');
  card.className = `${OVERLAY_CLASS}__card`;

  const spinner = document.createElement('div');
  spinner.className = `${OVERLAY_CLASS}__spinner`;
  card.appendChild(spinner);

  const msg = document.createElement('div');
  msg.className = `${OVERLAY_CLASS}__msg`;
  msg.textContent = initial;
  card.appendChild(msg);

  const hint = document.createElement('div');
  hint.className = `${OVERLAY_CLASS}__hint`;
  hint.textContent = t('tempChatRegretOverlayHint');
  card.appendChild(hint);

  root.appendChild(card);
  document.body.appendChild(root);

  return {
    setProgress: (m) => {
      msg.textContent = m;
    },
    destroy: () => {
      root.remove();
    },
  };
}

function showToast(message: string, kind: 'info' | 'error' = 'info'): void {
  // Reuse the cheap inline toast style — no need to add yet another
  // toast subsystem.
  const el = document.createElement('div');
  el.className = `${OVERLAY_CLASS}__toast ${OVERLAY_CLASS}__toast--${kind}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

/* ---------------------------------------------------------------- */
/* Public entry point                                               */
/* ---------------------------------------------------------------- */

let inFlight = false;

const PENDING_KEY = 'gv-pending-temp-regret-handoff';
const PENDING_TTL_MS = 60_000; // hand-off must land within 1 minute

interface PendingHandoff {
  delivery: HandoffDelivery;
  storedAt: number;
}

function writePendingHandoff(delivery: HandoffDelivery): void {
  try {
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ delivery, storedAt: Date.now() } satisfies PendingHandoff),
    );
  } catch {
    /* sessionStorage may be unavailable — in-memory path is primary */
  }
}

function readPendingHandoff(): PendingHandoff | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingHandoff>;
    if (
      !parsed ||
      typeof parsed.storedAt !== 'number' ||
      !parsed.delivery ||
      typeof parsed.delivery !== 'object'
    )
      return null;
    const d = parsed.delivery as HandoffDelivery;
    if (d.mode === 'inline' && typeof d.text === 'string') {
      return { delivery: d, storedAt: parsed.storedAt };
    }
    if (
      d.mode === 'attachment' &&
      typeof d.directive === 'string' &&
      typeof d.attachment === 'string' &&
      typeof d.filename === 'string'
    ) {
      return { delivery: d, storedAt: parsed.storedAt };
    }
    return null;
  } catch {
    return null;
  }
}

function clearPendingHandoff(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Deliver the hand-off payload into the chat input.
 *
 *  - `inline` mode: just typed in via `setInputText` (execCommand
 *    insertText). Up to ~5K chars this fits comfortably in the input.
 *
 *  - `attachment` mode:
 *      1. Type the directive into the input box (short).
 *      2. Build a `File` from the transcript and dispatch a synthetic
 *         `paste` ClipboardEvent with that file in its DataTransfer.
 *         ChatGPT's own paste handler reads the DataTransfer.files,
 *         sees a text/plain file, and converts it into a `.txt`
 *         attachment chip — the same behaviour you get when pasting
 *         a giant blob manually. We get the auto-attach for free,
 *         without having to call any ChatGPT-internal API.
 *
 * Returns true if both stages reported success.
 */
/**
 * Dispatch a synthetic `paste` event carrying text and/or a file.
 * Returns true iff the ClipboardEvent was constructed with the data
 * actually attached (some browsers silently strip the payload from
 * the constructor); the caller can fall back if not.
 *
 * Why a paste event instead of execCommand insertText?
 *   - ProseMirror (ChatGPT's editor as of 2026-05) tracks its own
 *     state; raw execCommand on the contenteditable lands in DOM but
 *     ProseMirror re-renders from its model and wipes the change on
 *     the next tick. A real `paste` goes through ProseMirror's paste
 *     handler which calls its own transaction API.
 *   - For `File` payloads, ChatGPT's paste handler converts the file
 *     into an attachment chip automatically — exactly what we want.
 */
function dispatchSyntheticPaste(
  input: HTMLElement,
  text: string | null,
  file: File | null,
): boolean {
  input.focus();
  const dt = new DataTransfer();
  if (text) dt.setData('text/plain', text);
  if (file) dt.items.add(file);
  const evt = new ClipboardEvent('paste', {
    clipboardData: dt,
    bubbles: true,
    cancelable: true,
  });
  const haveText = !text || (evt.clipboardData && evt.clipboardData.getData('text/plain') === text);
  const haveFile =
    !file || (evt.clipboardData && evt.clipboardData.files && evt.clipboardData.files.length > 0);
  if (!haveText || !haveFile) return false;
  input.dispatchEvent(evt);
  return true;
}

async function deliverHandoff(
  input: HTMLElement,
  delivery: HandoffDelivery,
): Promise<boolean> {
  if (delivery.mode === 'inline') {
    // Try paste-event first (works around ProseMirror's state model
    // wiping out raw execCommand insertions). Fall back to typed input
    // if the synthetic ClipboardEvent gets its data stripped.
    if (dispatchSyntheticPaste(input, delivery.text, null)) return true;
    setInputText(input, delivery.text);
    return true;
  }
  // Attachment path: directive paste + transcript file paste.
  // Two separate paste events so ChatGPT's handler treats them as
  // independent inputs (the directive lands in the editor, the file
  // becomes a chip). Dispatching both in one DataTransfer also works
  // in current ChatGPT, but separating is more defensive against
  // future handler changes.
  if (!dispatchSyntheticPaste(input, delivery.directive, null)) {
    setInputText(input, delivery.directive);
  }
  try {
    const file = new File([delivery.attachment], delivery.filename, {
      type: 'text/plain',
    });
    if (!dispatchSyntheticPaste(input, null, file)) {
      throw new Error('synthetic paste stripped file payload');
    }
    return true;
  } catch (err) {
    console.warn(
      '[GPT-Voyager] temp-regret: paste-event attach failed, falling back to inline text',
      err,
    );
    // Last resort: dump the whole transcript inline as text.
    setInputText(input, delivery.directive + '\n\n' + delivery.attachment);
    return false;
  }
}

/**
 * On every content-script bootstrap, check whether the previous page
 * had stashed a hand-off prompt for us. If yes and we've landed on a
 * fresh non-temp page with an input box, paste the prompt in.
 *
 * Waits up to 6s for the input box to mount — ChatGPT can be slow to
 * render after a navigation, especially on cold loads.
 */
export async function resumePendingHandoff(): Promise<void> {
  const pending = readPendingHandoff();
  if (!pending) return;
  if (Date.now() - pending.storedAt > PENDING_TTL_MS) {
    clearPendingHandoff();
    return;
  }
  if (isInTemporaryChatMode()) {
    // We're still in temp mode for some reason — don't paste, the
    // user obviously wasn't taken to a fresh persistent chat.
    return;
  }
  const start = Date.now();
  while (Date.now() - start < 6_000) {
    const input = document.querySelector<HTMLElement>(INPUT_SELECTOR);
    if (input) {
      await deliverHandoff(input, pending.delivery);
      clearPendingHandoff();
      // We don't have the original turn count or filename in the
      // resume payload, so fall back to the inline-flavour toast for
      // both modes — it correctly says "ready, click send to continue"
      // without referencing values we don't have.
      showToast(
        pending.delivery.mode === 'attachment'
          ? t('tempChatRegretOkAttachment', {
              count: '?',
              filename: pending.delivery.filename,
            })
          : t('tempChatRegretOkInline', { count: '?' }),
        'info',
      );
      return;
    }
    await sleep(150);
  }
  // Timed out — leave the pending entry; next page load tries again
  // unless TTL expires.
}

export async function runTempChatRegret(): Promise<void> {
  if (inFlight) return;
  if (!isInTemporaryChatMode()) {
    showToast(t('tempChatRegretErrNotInTempMode'), 'error');
    return;
  }
  inFlight = true;
  try {
    const initialTurnCount = document.querySelectorAll(TURN_SELECTOR).length;
    if (initialTurnCount === 0) {
      showToast(t('tempChatRegretErrNoMessages'), 'error');
      return;
    }

    const confirmed = await new Promise<boolean>((resolve) => {
      showConfirmModal({
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
        turnCount: initialTurnCount,
      });
    });
    if (!confirmed) return;

    const overlay = showLoadingOverlay(t('tempChatRegretMsgLoading'));
    try {
      await scrollToTopAndLoadAll((count) => {
        overlay.setProgress(t('tempChatRegretMsgLoaded', { count }));
      });

      overlay.setProgress(t('tempChatRegretMsgExtracting'));
      const turns = extractTurnsFromDom();
      if (turns.length === 0) {
        overlay.destroy();
        showToast(t('tempChatRegretErrExtractFailed'), 'error');
        return;
      }

      // Choose inline vs attachment delivery based on transcript size.
      // Short conversations: directive + transcript all type into the
      // input box. Long ones: directive in the input, transcript as a
      // .txt file attached via a synthetic paste event (ChatGPT's own
      // paste handler converts pasted Files into attachment chips).
      const delivery = planHandoffDelivery(turns);
      // Stash to sessionStorage BEFORE leaving temp mode. If
      // `leaveTemporaryMode` falls back to a full reload, the in-memory
      // delivery + input references die with the page — but the
      // sessionStorage entry survives in the same tab and the bootstrap
      // on the fresh page reads it back via `resumePendingHandoff`.
      writePendingHandoff(delivery);

      overlay.setProgress(t('tempChatRegretMsgLeavingTemp'));
      const left = await leaveTemporaryMode();
      if (!left) {
        overlay.destroy();
        clearPendingHandoff();
        showToast(t('tempChatRegretErrCantLeaveTemp'), 'error');
        return;
      }

      // Give ChatGPT one more frame to remount the input box after the
      // mode switch — the contenteditable element gets a fresh React
      // node and our previous reference would be dead.
      await sleep(250);

      overlay.setProgress(
        delivery.mode === 'attachment'
          ? t('tempChatRegretMsgFillingAttachment')
          : t('tempChatRegretMsgFillingInline'),
      );
      const input = document.querySelector<HTMLElement>(INPUT_SELECTOR);
      if (!input) {
        overlay.destroy();
        const fallback =
          delivery.mode === 'inline'
            ? delivery.text
            : delivery.directive + '\n\n' + delivery.attachment;
        await copyToClipboard(fallback);
        showToast(t('tempChatRegretErrInputNotFound'), 'error');
        return;
      }
      const ok = await deliverHandoff(input, delivery);
      clearPendingHandoff();
      // Clipboard safety net so the user can re-paste if anything
      // looks off when they review the input box before sending.
      const clipboardCopy =
        delivery.mode === 'inline'
          ? delivery.text
          : delivery.directive + '\n\n' + delivery.attachment;
      await copyToClipboard(clipboardCopy);

      overlay.destroy();
      if (ok) {
        showToast(
          delivery.mode === 'attachment'
            ? t('tempChatRegretOkAttachment', {
                count: turns.length,
                filename: delivery.filename,
              })
            : t('tempChatRegretOkInline', { count: turns.length }),
          'info',
        );
      } else {
        showToast(t('tempChatRegretErrPartial'), 'error');
      }
    } catch (err) {
      overlay.destroy();
      console.error('[GPT-Voyager] temp-chat regret failed', err);
      const msg = (err as Error)?.message ?? String(err);
      showToast(`${t('tempChatRegretErrFailed')}: ${msg}`, 'error');
    }
  } finally {
    inFlight = false;
  }
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard may be unavailable — input-fill is the primary path */
  }
}
