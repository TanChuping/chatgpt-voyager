/**
 * Announcement system bootstrap.
 *
 * Wires together the four moving pieces:
 *   - service.ts        — fetches the remote feed and tracks "seen" / "shown" flags
 *   - topBarButton.ts   — injects the megaphone button into ChatGPT's header
 *   - bubble.ts         — non-blocking preview drop-down
 *   - modal.ts          — full markdown modal opened on detail click
 *
 * Also exports `openCurrentAnnouncementModal()` so the prompt-manager
 * version chip (`.gv-pm-version`) can wire into the same code path.
 */
import { getTranslationSyncUnsafe } from '@/utils/i18n';

import { mountBubble, type BubbleHandle } from './bubble';
import { openAnnouncementModal } from './modal';
import {
  applyUnreadState,
  getButtonElement,
  startTopBarAnnouncementButton,
  stopTopBarAnnouncementButton,
} from './topBarButton';
import {
  getLastSnapshot,
  installAnnouncementWatchers,
  markBubbleShown,
  markSeen,
  refreshSnapshot,
  type AnnouncementSnapshot,
} from './service';
import type { RemoteAnnouncement } from './types';

let bubble: BubbleHandle | null = null;
let started = false;

function tt(key: string, fallback: string): string {
  try {
    const v = getTranslationSyncUnsafe(key);
    // getTranslationSyncUnsafe returns the *key string itself* when the
    // key isn't registered — guard against that so we don't render
    // "announcementButton" literal in the UI on a stale build.
    return v && v !== key ? v : fallback;
  } catch {
    return fallback;
  }
}

function openModalFor(announcement: RemoteAnnouncement): void {
  // Close the bubble first so the modal isn't fighting it for attention.
  bubble?.destroy();
  bubble = null;
  openAnnouncementModal({
    announcement,
    closeLabel: tt('announcementClose', 'Close'),
    versionPrefix: 'v',
    onClose: () => {
      // The user has now read it — mark seen. Other tabs will also
      // dismiss via the storage.onChanged listener.
      void markSeen(announcement.id);
    },
  });
  // Mark as seen immediately on open as well — closing via × should not
  // be required for "I read it" to register, in case the user reloads
  // before pressing ×.
  void markSeen(announcement.id);
}

function showBubbleFor(announcement: RemoteAnnouncement): void {
  const anchor = getButtonElement();
  if (!anchor) return; // button hasn't injected yet — observer will retrigger
  bubble?.destroy();
  bubble = mountBubble({
    anchor,
    title: announcement.title,
    summary: announcement.summary,
    detailLabel: tt('announcementDetail', 'View details'),
    closeLabel: tt('announcementClose', 'Close'),
    onDetail: () => {
      openModalFor(announcement);
    },
    onClose: () => {
      void markSeen(announcement.id);
    },
  });
  void markBubbleShown(announcement.id);
}

function applySnapshot(snapshot: AnnouncementSnapshot): void {
  applyUnreadState(snapshot.hasUnread);
  if (snapshot.shouldPopBubble && snapshot.current) {
    showBubbleFor(snapshot.current);
  } else if (!snapshot.hasUnread) {
    // Cross-tab acknowledgment: another tab just marked this seen —
    // dismiss any bubble we still have hanging around.
    bubble?.destroy();
    bubble = null;
  }
}

/**
 * Open the modal for whatever is the current announcement, if any.
 * Exported so the prompt manager's version chip can call into it
 * without re-importing all the service plumbing.
 */
export async function openCurrentAnnouncementModal(): Promise<void> {
  // Force a refresh so a user clicking right after a push sees the new
  // content even if the 30-min cache hasn't expired.
  const snap = await refreshSnapshot(true);
  if (snap.current) {
    openModalFor(snap.current);
  } else {
    // No current announcement — render a friendly "no news" modal so
    // the user gets feedback that the button worked.
    openAnnouncementModal({
      announcement: {
        id: 'gv-no-current',
        title: tt('announcementEmptyTitle', 'No announcements'),
        summary: '',
        bodyMarkdown: tt(
          'announcementEmptyBody',
          'There are no extension announcements right now. Check back later.',
        ),
      },
      closeLabel: tt('announcementClose', 'Close'),
      onClose: () => {
        /* nothing to mark */
      },
    });
  }
}

export function startAnnouncement(): void {
  if (started) return;
  started = true;

  startTopBarAnnouncementButton({
    label: tt('announcementButton', 'Announcements'),
    onClick: () => {
      void openCurrentAnnouncementModal();
    },
  });

  installAnnouncementWatchers(applySnapshot);

  // Kick off the first fetch + render pass. If the announcement button
  // hasn't injected yet (ChatGPT header is still mounting), `showBubbleFor`
  // is a no-op for this tick and the subsequent storage change /
  // observer pass will re-run with the button in place.
  void refreshSnapshot().then(applySnapshot);

  // Belt-and-suspenders: re-evaluate after a short delay so any late
  // header mount doesn't leave the bubble unshown for the rest of the
  // session.
  window.setTimeout(() => {
    const snap = getLastSnapshot();
    if (snap.shouldPopBubble && snap.current && !bubble) {
      applySnapshot(snap);
    }
  }, 2500);
}

export function stopAnnouncement(): void {
  bubble?.destroy();
  bubble = null;
  stopTopBarAnnouncementButton();
  started = false;
}
