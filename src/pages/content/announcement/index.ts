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
  setAnnouncementButtonAvailableListener,
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

/**
 * Announcement we *intended* to surface but couldn't mount because the
 * megaphone button hadn't been injected by `topBarButton` yet on the
 * first snapshot evaluation. The button-available listener replays
 * `showBubbleFor` against this when ChatGPT's header finally settles,
 * so the bubble visibly pops at least once. Cleared once the bubble
 * actually mounts OR when a later snapshot says the user has dismissed.
 */
let pendingAnnouncement: RemoteAnnouncement | null = null;

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
  // EAGER MARK: write `BUBBLE_SHOWN_FOR` first, before touching the
  // DOM. Reason: pre-fix this lived AFTER the `if (!anchor) return`
  // bail-out, so if the megaphone button hadn't injected yet (very
  // common on cold load — content-script feature-init order races
  // ChatGPT's header mount), the mark NEVER ran. Each subsequent page
  // load saw the flag empty and re-decided shouldPopBubble=true —
  // meaning the bubble would pop on EVERY page load for that id, not
  // exactly once as the CLAUDE.md contract requires.
  //
  // Trade-off: if the user closes the tab in the ~50ms before the
  // button mounts and the retry fires, they may never visually see
  // the bubble for this id. That's the lesser evil — the red dot
  // still flags it, and the megaphone-click path still opens the
  // modal. Annoyance from re-popping is much worse than missing one
  // visual pop in a corner-case timing.
  //
  // The `current.id`-keyed flag means a NEW announcement (different
  // id pushed to the support repo) STILL passes the shouldPopBubble
  // check — eager write only locks in the *current* id.
  void markBubbleShown(announcement.id);

  const anchor = getButtonElement();
  if (!anchor) {
    // Stash for the button-available listener to retry once the
    // megaphone mounts. Don't return until we've recorded intent.
    pendingAnnouncement = announcement;
    return;
  }
  pendingAnnouncement = null;
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
}

/**
 * Fires when `topBarButton` has just injected a fresh megaphone into
 * the DOM. Two jobs:
 *
 *  1. Re-apply the current unread state to the new button, so the
 *     red dot reflects `getLastSnapshot().hasUnread` immediately
 *     (without waiting on the next snapshot refresh or storage
 *     onChanged round-trip).
 *
 *  2. If we have a `pendingAnnouncement` whose first showBubbleFor
 *     attempt landed before the button was ready, mount the bubble
 *     now — subject to a fresh seen-state check so a cross-tab
 *     dismiss between then and now still suppresses it.
 */
function onAnnouncementButtonAvailable(): void {
  const snap = getLastSnapshot();
  applyUnreadState(snap.hasUnread);
  if (!pendingAnnouncement) return;
  const pending = pendingAnnouncement;
  pendingAnnouncement = null;
  // If a cross-tab markSeen flipped hasUnread off between the eager
  // write and now, don't surprise the user with a bubble. Same if
  // the publisher swapped the announcement under us.
  if (!snap.hasUnread || snap.current?.id !== pending.id) return;
  const anchor = getButtonElement();
  if (!anchor) return; // very unlikely — the listener says it's there
  bubble?.destroy();
  bubble = mountBubble({
    anchor,
    title: pending.title,
    summary: pending.summary,
    detailLabel: tt('announcementDetail', 'View details'),
    closeLabel: tt('announcementClose', 'Close'),
    onDetail: () => {
      openModalFor(pending);
    },
    onClose: () => {
      void markSeen(pending.id);
    },
  });
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

  // Register BEFORE the first refreshSnapshot/applySnapshot so that
  // if the button is *already* in the DOM by the time we get here
  // (uncommon but possible if startAnnouncement is called late in
  // feature-init), the listener fires immediately and re-syncs state.
  setAnnouncementButtonAvailableListener(onAnnouncementButtonAvailable);

  installAnnouncementWatchers(applySnapshot);

  // Kick off the first fetch + render pass. `showBubbleFor` now
  // eagerly writes `markBubbleShown` even if the button isn't ready,
  // and stashes the announcement to `pendingAnnouncement` for the
  // button-available listener to surface visually when the megaphone
  // finally mounts. No more "bubble pops on every page load" because
  // the flag never got written in time.
  void refreshSnapshot().then(applySnapshot);

  // The old 2.5s setTimeout retry is now redundant (button-available
  // listener covers the same case more responsively), but we keep a
  // shorter version as a defense against the listener never firing —
  // e.g., if ChatGPT removes the temp-toggle anchor entirely and our
  // findAnchor returns null indefinitely. In that scenario the bubble
  // can't visually appear anyway, but a snapshot re-eval is harmless.
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
  pendingAnnouncement = null;
  setAnnouncementButtonAvailableListener(null);
  stopTopBarAnnouncementButton();
  started = false;
}
