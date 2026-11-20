import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppLanguage } from '@/utils/language';

import { openCurrentAnnouncementModal, startAnnouncement, stopAnnouncement } from '../index';
import type { AnnouncementSnapshot } from '../service';

const state = vi.hoisted(() => ({
  language: 'en' as AppLanguage,
  languageListener: null as (() => void) | null,
  changeListener: null as ((snapshot: AnnouncementSnapshot) => void) | null,
  snapshot: {
    current: null,
    status: 'unavailable',
    hasUnread: false,
    shouldPopBubble: false,
  } as AnnouncementSnapshot,
  markedSeen: vi.fn(async () => {}),
  markedBubble: vi.fn(async () => {}),
}));
vi.mock('@/utils/i18n', () => ({
  initI18n: async () => {},
  getCachedLanguage: () => state.language,
  getTranslationSyncUnsafe: (key: string) => key,
  subscribeLanguageChange: (listener: () => void) => {
    state.languageListener = listener;
    return () => {
      state.languageListener = null;
    };
  },
}));
vi.mock('../service', () => ({
  getLastSnapshot: () => state.snapshot,
  refreshSnapshot: vi.fn(async () => {
    state.changeListener?.(state.snapshot);
    return state.snapshot;
  }),
  installAnnouncementWatchers: (listener: (snapshot: AnnouncementSnapshot) => void) => {
    state.changeListener = listener;
  },
  markSeen: state.markedSeen,
  markBubbleShown: state.markedBubble,
}));
vi.mock('../topBarButton', () => ({
  applyUnreadState: vi.fn(),
  getButtonElement: () => document.getElementById('anchor'),
  setAnnouncementButtonAvailableListener: vi.fn(),
  startTopBarAnnouncementButton: vi.fn(),
  stopTopBarAnnouncementButton: vi.fn(),
  updateAnnouncementButtonLabel: vi.fn(),
}));

function announcement(language: AppLanguage = 'en') {
  return {
    id: 'A',
    title: `Title ${language}`,
    summary: `Summary ${language}`,
    bodyMarkdown: `Body ${language}`,
    language,
    requestedLanguage: language,
    locales: {
      en: { title: 'Title en', summary: 'Summary en', bodyMarkdown: 'Body en' },
      ja: { title: 'Title ja', summary: 'Summary ja', bodyMarkdown: 'Body ja' },
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = '<button id="anchor">Announcements</button>';
  state.snapshot = {
    current: null,
    status: 'unavailable',
    hasUnread: false,
    shouldPopBubble: false,
  };
  state.markedSeen.mockClear();
  state.markedBubble.mockClear();
  state.changeListener = null;
  state.languageListener = null;
  state.language = 'en';
});
afterEach(() => {
  stopAnnouncement();
  document.querySelector<HTMLButtonElement>('.gv-announcement-modal__close')?.click();
  document.body.replaceChildren();
});

describe('announcement bootstrap DOM fixture (not live ChatGPT evidence)', () => {
  it.each(['empty', 'unavailable'] as const)(
    'opening %s state does not acknowledge a fake announcement',
    async (status) => {
      state.snapshot.status = status;
      await openCurrentAnnouncementModal();
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(document.querySelector('.gv-announcement-modal__title')!.textContent).toBe(
        status === 'empty' ? 'No announcements' : 'Announcements unavailable',
      );
      document.querySelector<HTMLButtonElement>('.gv-announcement-modal__close')!.click();
      expect(state.markedSeen).not.toHaveBeenCalled();
      expect(state.markedBubble).not.toHaveBeenCalled();
    },
  );

  it('opening genuine content marks its ID once; switching reading language and closing add no marks', async () => {
    state.snapshot = {
      current: announcement(),
      status: 'ready',
      hasUnread: true,
      shouldPopBubble: false,
    };
    await openCurrentAnnouncementModal();
    expect(state.markedSeen).toHaveBeenCalledExactlyOnceWith('A');
    document.querySelector<HTMLButtonElement>('button[data-language="ja"]')!.click();
    document.querySelector<HTMLButtonElement>('.gv-announcement-modal__close')!.click();
    expect(state.markedSeen).toHaveBeenCalledTimes(1);
    expect(state.markedBubble).not.toHaveBeenCalled();
  });

  it('switches an already visible bubble in place without re-pop or seen/cooldown actions', async () => {
    state.snapshot = {
      current: announcement(),
      status: 'ready',
      hasUnread: true,
      shouldPopBubble: true,
    };
    startAnnouncement();
    await vi.waitFor(() =>
      expect(document.querySelector('.gv-announcement-bubble')).not.toBeNull(),
    );
    const originalBubble = document.querySelector('.gv-announcement-bubble');
    expect(state.markedBubble).toHaveBeenCalledExactlyOnceWith('A');
    state.snapshot = {
      current: announcement('ja'),
      status: 'ready',
      hasUnread: true,
      shouldPopBubble: false,
    };
    state.language = 'ja';
    state.languageListener!();
    await vi.waitFor(() =>
      expect(document.querySelector('.gv-announcement-bubble__title')!.textContent).toBe(
        'Title ja',
      ),
    );
    expect(document.querySelector('.gv-announcement-bubble')).toBe(originalBubble);
    expect(state.markedBubble).toHaveBeenCalledTimes(1);
    expect(state.markedSeen).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('.gv-announcement-bubble__detail')!.click();
    expect(document.querySelector('.gv-announcement-modal__title')!.textContent).toBe('Title ja');
    expect(state.markedSeen).toHaveBeenCalledExactlyOnceWith('A');
  });

  it('withdrawal dismisses an already mounted bubble without marking it read', async () => {
    state.snapshot = {
      current: announcement(),
      status: 'ready',
      hasUnread: true,
      shouldPopBubble: true,
    };
    startAnnouncement();
    await vi.waitFor(() =>
      expect(document.querySelector('.gv-announcement-bubble')).not.toBeNull(),
    );
    state.snapshot = { current: null, status: 'empty', hasUnread: false, shouldPopBubble: false };
    state.changeListener!(state.snapshot);
    expect(document.querySelector('.gv-announcement-bubble')).toBeNull();
    expect(state.markedSeen).not.toHaveBeenCalled();
  });
});
