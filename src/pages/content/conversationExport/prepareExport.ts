import { getConversationCaptureService } from '@/features/conversationApi/ConversationCaptureService';
import type { LinearConversation } from '@/features/conversationApi/types';
import {
  collectLiveConversationMessages,
  mergeLiveConversationMessages,
  rebuildConversationFromLive,
  reconcileExportTail,
} from '@/features/singleConvExport/liveSnapshot';

import { findActiveConversationRoot } from '../chatgptDom';
import { findActivePageHeader } from '../shared/headerActionSlot';
import { hydrateConversationHistory } from './historyHydrator';
import { requestFullConversationCapture } from './requestFullCapture';

export type WholeExportPreparationStage = 'checking' | 'incremental' | 'rebuilding';

export interface PrepareWholeExportOptions {
  onStage?: (stage: WholeExportPreparationStage, discovered?: number) => void;
}

function currentTitle(): string {
  const title =
    findActivePageHeader()?.querySelector<HTMLElement>('h1')?.textContent ||
    document.title.replace(/\s*[-|]\s*ChatGPT\s*$/i, '');
  return title.trim() || 'Untitled conversation';
}

export async function prepareWholeConversationExport(
  convId: string,
  options: PrepareWholeExportOptions = {},
): Promise<LinearConversation> {
  const capture = getConversationCaptureService();
  const currentPath = location.pathname;
  const isCurrent = () => location.pathname === currentPath;
  const ensureCurrent = () => {
    if (!isCurrent()) throw new DOMException('Conversation changed during export.', 'AbortError');
  };
  let live = collectLiveConversationMessages();
  options.onStage?.('checking', live.length);
  const isPaginated = () =>
    capture.hasPagedCapture(convId) ||
    Boolean(
      findActiveConversationRoot()?.querySelector('[data-turn-key], [data-gv-thread-anchor]'),
    );

  const reconcileCompleteCapture = (mounted: typeof live): LinearConversation | null => {
    if (!capture.isComplete(convId)) return null;
    const cached = capture.getLatest(convId);
    if (!cached || cached.messages.length === 0) return null;
    const reconciliation = reconcileExportTail(cached, mounted);
    if (reconciliation.kind === 'fresh') return cached;
    if (reconciliation.kind !== 'incremental') return null;
    options.onStage?.('incremental', reconciliation.changed.length);
    return capture.updateLatest(convId, mergeLiveConversationMessages(cached, mounted));
  };

  if (!isPaginated() && capture.isComplete(convId)) {
    const prepared = reconcileCompleteCapture(live);
    if (prepared) return prepared;
  }

  options.onStage?.('rebuilding', live.length);
  // Fetch a verified complete mapping in parallel with native paging. It
  // supplies a second way to identify the first real message when Chrome did
  // not capture the entire native cursor chain (for example from page cache).
  const request = capture.isComplete(convId) ? null : requestFullConversationCapture(convId);
  if (!isPaginated() && request) {
    await request;
    ensureCurrent();
    live = collectLiveConversationMessages();
    if (!isPaginated()) {
      const prepared = reconcileCompleteCapture(live);
      if (prepared) return prepared;
    }
  }

  const paginated = isPaginated();
  const oldestIsLoaded = () => {
    if (!capture.isComplete(convId)) return false;
    const messages = capture.getLatest(convId)?.messages;
    const oldest =
      messages?.find((message) => message.role === 'user') ??
      messages?.find((message) => message.role === 'assistant');
    if (!oldest) return false;
    const root = findActiveConversationRoot();
    if (!root) return false;
    for (const element of root.querySelectorAll('[data-message-id], [data-gv-thread-anchor]')) {
      if (
        element.getAttribute('data-message-id') === oldest.messageId ||
        element.getAttribute('data-gv-thread-anchor') === oldest.messageId
      )
        return true;
    }
    return false;
  };

  const hydration = await hydrateConversationHistory({
    onProgress: ({ discovered }) => options.onStage?.('rebuilding', discovered),
    isComplete: paginated ? oldestIsLoaded : undefined,
    oldestLoadedId: paginated
      ? () =>
          findActiveConversationRoot()
            ?.querySelector('[data-gv-thread-anchor]')
            ?.getAttribute('data-gv-thread-anchor') ??
          collectLiveConversationMessages()[0]?.message.messageId ??
          null
      : undefined,
    isCurrent,
  });
  ensureCurrent();
  if (!hydration.reachedTop) {
    throw new Error('Unable to reach the beginning of the conversation safely.');
  }

  const prepared = reconcileCompleteCapture(paginated ? live : hydration.messages);
  if (prepared) return prepared;
  if (paginated || hydration.messages.length === 0) {
    throw new Error('Unable to verify all messages of the current conversation.');
  }

  const cached = capture.getLatest(convId);
  const rebuilt = rebuildConversationFromLive(cached, convId, currentTitle(), hydration.messages);
  return capture.updateLatest(convId, rebuilt, { force: true });
}
