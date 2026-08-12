import { getConversationCaptureService } from '@/features/conversationApi/ConversationCaptureService';
import type { LinearConversation } from '@/features/conversationApi/types';
import {
  collectLiveConversationMessages,
  mergeLiveConversationMessages,
  rebuildConversationFromLive,
  reconcileExportTail,
} from '@/features/singleConvExport/liveSnapshot';

import { hydrateConversationHistory } from './historyHydrator';

export type WholeExportPreparationStage = 'checking' | 'incremental' | 'rebuilding';

export interface PrepareWholeExportOptions {
  onStage?: (stage: WholeExportPreparationStage, discovered?: number) => void;
}

function currentTitle(): string {
  const title =
    document.querySelector<HTMLElement>('header#page-header h1, header h1')?.textContent ||
    document.title.replace(/\s*[-|]\s*ChatGPT\s*$/i, '');
  return title.trim() || 'Untitled conversation';
}

export async function prepareWholeConversationExport(
  convId: string,
  options: PrepareWholeExportOptions = {},
): Promise<LinearConversation> {
  const capture = getConversationCaptureService();
  let cached = capture.getLatest(convId);
  let live = collectLiveConversationMessages();
  options.onStage?.('checking', live.length);
  const reconciliation = reconcileExportTail(cached, live);

  if (reconciliation.kind === 'fresh' && cached) return cached;

  if (reconciliation.kind === 'incremental' && cached) {
    options.onStage?.('incremental', reconciliation.changed.length);
    const merged = mergeLiveConversationMessages(cached, live);
    return capture.updateLatest(convId, merged);
  }

  options.onStage?.('rebuilding', live.length);
  const hydration = await hydrateConversationHistory({
    onProgress: ({ discovered }) => options.onStage?.('rebuilding', discovered),
  });
  if (!hydration.reachedTop) {
    throw new Error('Unable to reach the beginning of the conversation safely.');
  }

  live = hydration.messages;
  cached = capture.getLatest(convId);
  if (live.length === 0 && !cached) {
    throw new Error('No exportable conversation messages were found.');
  }

  // A network capture may have arrived while ChatGPT hydrated history. Prefer
  // it when its latest-five tail is now consistent; otherwise rebuild the
  // current user-facing branch from what was actually mounted.
  if (cached) {
    const afterHydration = reconcileExportTail(cached, live);
    if (afterHydration.kind === 'fresh') return cached;
    if (afterHydration.kind === 'incremental') {
      return capture.updateLatest(convId, mergeLiveConversationMessages(cached, live));
    }
  }

  const rebuilt = rebuildConversationFromLive(cached, convId, currentTitle(), live);
  return capture.updateLatest(convId, rebuilt, { force: true });
}
