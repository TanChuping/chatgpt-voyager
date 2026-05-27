/**
 * Bootstrap for the "Temp Chat Regret" feature.
 *
 * Wires the top-bar button only; the actual orchestration lives in
 * `orchestrator.ts` and runs on demand when the button is clicked.
 */
import { resumePendingHandoff } from './orchestrator';
import { startTempChatRegretButton, stopTempChatRegretButton } from './topBarButton';

let started = false;

export function startTempChatExit(): void {
  if (started) return;
  started = true;
  startTempChatRegretButton();
  // If a previous page in this tab stashed a pending hand-off (i.e.
  // the user clicked Regret and we navigated here), pick it up and
  // paste it into the freshly-mounted input box.
  void resumePendingHandoff();
}

export function stopTempChatExit(): void {
  if (!started) return;
  started = false;
  stopTempChatRegretButton();
}
