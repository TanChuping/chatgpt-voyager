/**
 * Single-conversation export bootstrap.
 *
 * Wires together:
 *  - the page-world capture service (the actual fetch wrapper runs in MAIN
 *    world via the `conversationHook.ts` content-script entry; this side
 *    installs the postMessage listener so the content-script world gets the
 *    payloads).
 *  - the top-right export button next to Share.
 *  - the "pending export" resume hook (called when a previous tab navigation
 *    was triggered to fetch a conversation before exporting it).
 */
import { getConversationCaptureService } from '@/features/conversationApi/ConversationCaptureService';
import { resumePendingExport } from '@/features/singleConvExport';

import { startTopBarExportButton } from './topBarButton';

let started = false;

export async function startSingleConversationExport(): Promise<void> {
  if (started) return;
  started = true;

  // Install the capture listener. The page-world hook posts captured
  // conversation payloads via window.postMessage (and also stashes them in
  // sessionStorage for the cold-start case where this listener wasn't yet
  // ready when ChatGPT's first fetch fired).
  getConversationCaptureService().install();

  startTopBarExportButton();
  resumePendingExport();
}
