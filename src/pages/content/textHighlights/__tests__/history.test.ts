import { afterEach, expect, it, vi } from 'vitest';

import { HIGHLIGHTS_PREFIX, type TextHighlight } from '../anchors';
import { readHighlightHistory } from '../history';
import { renderHighlightHistory } from '../historyPanel';

vi.mock('@/utils/i18n', () => ({ getTranslationSyncUnsafe: (key: string) => key }));

const record: TextHighlight = {
  id: 'a',
  messageId: 'message-a',
  quote: 'selected quote',
  start: 5,
  end: 19,
  color: 'pink',
  note: 'saved note',
  updatedAt: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.replaceChildren();
  history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

it('renders a settings CTA without reading disabled highlight storage', () => {
  const root = document.createElement('div');
  const open = vi.fn();
  const scan = vi.fn();
  vi.stubGlobal('localStorage', { key: scan, length: 1 });
  renderHighlightHistory(root, false, open, vi.fn());
  expect(scan).not.toHaveBeenCalled();
  root.querySelector('button')!.click();
  expect(open).toHaveBeenCalledOnce();
});

it('reads old records and only mounts another conversation’s rows when expanded', async () => {
  history.replaceState(null, '', '/c/current');
  localStorage.setItem(HIGHLIGHTS_PREFIX + 'old', JSON.stringify([record]));
  localStorage.setItem(
    HIGHLIGHTS_PREFIX + 'current',
    JSON.stringify([{ ...record, note: 'current highlight', conversationTitle: 'Current thread' }]),
  );
  const keys = [HIGHLIGHTS_PREFIX + 'old', HIGHLIGHTS_PREFIX + 'current'];
  const storage = localStorage;
  vi.stubGlobal('localStorage', {
    length: keys.length,
    key: (index: number) => keys[index],
    getItem: (key: string) => storage.getItem(key),
  });
  const groups = readHighlightHistory();
  expect(groups.map((group) => group.id)).toEqual(['current', 'old']);
  expect(groups[1].url.pathname).toBe('/c/old');

  const root = document.createElement('div');
  renderHighlightHistory(root, true, vi.fn(), vi.fn());
  expect(root.textContent).toContain('Current thread');
  expect(root.textContent).toContain('current highlight');
  expect(root.textContent).not.toContain('saved note');
  const group = root.querySelectorAll('details')[1];
  group.open = true;
  group.dispatchEvent(new Event('toggle'));
  expect(group.querySelector('a')?.getAttribute('href')).toBe(
    new URL('/c/old', location.origin).href,
  );
  expect(group.textContent).toContain('saved note');
  expect(group.textContent).toContain('selected quote');
});
