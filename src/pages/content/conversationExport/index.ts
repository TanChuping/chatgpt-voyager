/**
 * Single-conversation export bootstrap.
 *
 * Wires together:
 *  - the lazy capture consumer (the MAIN-world fetch wrapper hands captures
 *    to a document-start isolated bridge, which validates and persists them
 *    in the background-private per-tab store).
 *  - the top-right export button next to Share.
 *  - the "pending export" resume hook (called when a previous tab navigation
 *    was triggered to fetch a conversation before exporting it).
 */
import { getConversationCaptureService } from '@/features/conversationApi/ConversationCaptureService';
import { resumePendingExport } from '@/features/singleConvExport';

import { startTopBarExportButton, stopTopBarExportButton } from './topBarButton';

let started = false;

export function stopSingleConversationExport(): void {
  if (!started) return;
  started = false;

  stopTopBarExportButton();
  getConversationCaptureService().uninstall();
}

export function startSingleConversationExport(): () => void {
  if (started) return stopSingleConversationExport;
  started = true;

  try {
    // Drain early private captures and subscribe to payload-free availability
    // signals from the document-start bridge.
    getConversationCaptureService().install();

    startTopBarExportButton();
    resumePendingExport();
  } catch (error) {
    stopSingleConversationExport();
    throw error;
  }

  return stopSingleConversationExport;
}
