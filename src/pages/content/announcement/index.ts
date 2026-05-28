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
 * The announcement id our currently-mounted bubble belongs to. Used to
 * make `showBubbleFor` idempotent: if applySnapshot fires twice for the
 * same id (which it routinely does — notify + .then both call it on
 * each refreshSnapshot), we MUST NOT re-call mountBubble because
 * mountBubble starts with `querySelectorAll(.bubble).forEach(remove)`
 * — i.e. it destroys the live bubble before recreating it. With
 * eager-mark + multi-tab storage onChanged events, that destroy/create
 * cascade visually looked like rapid flashing and also stole the × click
 * before its handler could fire (the element was detached mid-click).
 *
 * Reset to null whenever the bubble is destroyed for any reason.
 */
let mountedBubbleId: string | null = null;

/**
 * Announcement we *intended* to surface but couldn't mount because the
 * megaphone button hadn't been injected by `topBarButton` yet on the
 * first snapshot evaluation. The button-available listener replays
 * `showBubbleFor` against this when ChatGPT's header finally settles,
 * so the bubble visibly pops at least once. Cleared once the bubble
 * actually mounts OR when a later snapshot says the user has dismissed.
 */
let pendingAnnouncement: RemoteAnnouncement | null = null;

/**
 * Single source of truth for bubble teardown — every code path that
 * removes the bubble must go through here so `mountedBubbleId` stays
 * in sync with the actual DOM state.
 */
function destroyBubble(): void {
  bubble?.destroy();
  bubble = null;
  mountedBubbleId = null;
}

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
  destroyBubble();
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

  // IDEMPOTENCY: applySnapshot fires twice per refresh (notify path +
  // any redundant .then path) — and any cross-tab onChanged can fire
  // more on top of that. If we already have a live bubble for this
  // same id, do NOT re-mount: mountBubble's first line removes every
  // existing `.gv-announcement-bubble` from the DOM, which produced
  // the "rapid flashing + × button can't be clicked" regression (the
  // × element was being detached mid-click between event dispatch and
  // handler invocation).
  if (mountedBubbleId === announcement.id && bubble) return;

  const anchor = getButtonElement();
  if (!anchor) {
    // Stash for the button-available listener to retry once the
    // megaphone mounts. Don't return until we've recorded intent.
    pendingAnnouncement = announcement;
    return;
  }
  pendingAnnouncement = null;
  destroyBubble();
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
  mountedBubbleId = announcement.id;
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
  // Same idempotency check as showBubbleFor — don't re-mount on top
  // of an already-mounted bubble for the same id.
  if (mountedBubbleId === pending.id && bubble) return;
  const anchor = getButtonElement();
  if (!anchor) return; // very unlikely — the listener says it's there
  destroyBubble();
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
  mountedBubbleId = pending.id;
}

function applySnapshot(snapshot: AnnouncementSnapshot): void {
  applyUnreadState(snapshot.hasUnread);
  if (snapshot.shouldPopBubble && snapshot.current) {
    showBubbleFor(snapshot.current);
  } else if (!snapshot.hasUnread) {
    // Cross-tab acknowledgment: another tab just marked this seen —
    // dismiss any bubble we still have hanging around. Also clear
    // mountedBubbleId so a fresh announcement (different id) can
    // re-pop later.
    destroyBubble();
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

  // Kick off the first fetch + render pass. Note: we DON'T chain
  // `.then(applySnapshot)` here. `refreshSnapshot` internally calls
  // `notify(snap)`, which fan-outs to every subscriber including the
  // one `installAnnouncementWatchers` registered above pointing at
  // `applySnapshot`. Calling .then(applySnapshot) would fire a SECOND
  // applySnapshot with the same snapshot — and with eager-mark
  // shouldPopBubble flipping true→false async, the two calls would
  // race and each could call showBubbleFor, which (pre-fix) destroyed
  // and re-mounted the bubble = visible flashing + × button stolen
  // mid-click. The notify path is enough.
  void refreshSnapshot();

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
