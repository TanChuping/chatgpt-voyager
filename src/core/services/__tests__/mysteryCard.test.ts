import { afterEach, expect, it, vi } from 'vitest';

import { MYSTERY_CARD_URL } from '../../constants/project';
import { parseMysteryCard, renderMysteryCard } from '../mysteryCard';
import { loadMysteryCard } from '../mysteryCardFeed';

const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: store.get(k) }),
        set: async (v: Record<string, unknown>) =>
          Object.entries(v).forEach(([k, x]) => store.set(k, x)),
      },
    },
  },
}));
const fixture = {
  v: 1,
  enabled: true,
  rows: [
    [{ type: 'heading', text: { en: 'An indie game', fr: 'Un jeu indépendant' } }],
    [
      { type: 'image', url: 'https://example.com/cover.png', text: 'Cover' },
      { type: 'link', text: 'Play', url: 'https://example.com/game' },
    ],
  ],
};
afterEach(() => {
  vi.unstubAllGlobals();
  store.clear();
});
it('renders the specified rows, language and links with no donation controls', () => {
  const card = parseMysteryCard(fixture)!;
  const el = renderMysteryCard(card, 'fr');
  expect(el.querySelector('strong')?.textContent).toBe('Un jeu indépendant');
  expect(el.children[1].children).toHaveLength(2);
  expect(el.querySelector('a')?.href).toBe('https://example.com/game');
  expect(el.querySelector('progress')).toBeNull();
});
it('only reads the new feed and retains the last good card on invalid responses', async () => {
  const old = {
    gvFolderData: { folders: ['a'] },
    gptTimelineStarredMessages: ['star'],
    gvPromptItems: ['p'],
    gvSupportGoalCacheV1: { fetchedAt: 1, data: { title: 'legacy' } },
  };
  for (const [k, v] of Object.entries(old)) store.set(k, v);
  const get = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(fixture)))
    .mockResolvedValueOnce(new Response('{"v":3}'));
  vi.stubGlobal('fetch', get);
  const initial = await loadMysteryCard();
  expect(initial?.enabled).toBe(true);
  expect(await loadMysteryCard()).toEqual(initial);
  expect(get).toHaveBeenCalledTimes(1);
  expect(await loadMysteryCard(true)).toEqual(initial);
  expect(get.mock.calls.every(([url]) => String(url).startsWith(MYSTERY_CARD_URL + '?'))).toBe(
    true,
  );
  expect([...store.keys()].sort()).toEqual([...Object.keys(old), 'gvMysteryCardCacheV1'].sort());
  for (const [k, v] of Object.entries(old)) expect(store.get(k)).toEqual(v);
});
it('accepts a disabled card and rejects malformed rows and non-HTTPS media', () => {
  expect(parseMysteryCard({ v: 1, enabled: false, rows: [] })?.enabled).toBe(false);
  expect(parseMysteryCard({ ...fixture, rows: [[]] })).toBeUndefined();
  expect(
    parseMysteryCard({
      ...fixture,
      rows: [[{ type: 'image', text: 'Cover', url: 'file:///tmp/image' }]],
    }),
  ).toBeUndefined();
});

it('switches between configured panes, honors column proportions and ignores unrecognized actions', () => {
  const card = parseMysteryCard({
    ...fixture,
    colors: { accent: '#354477' },
    rows: [
      {
        weights: [2, 1],
        columns: [
          [
            {
              type: 'tabs',
              side: true,
              items: [
                { label: 'Intro', blocks: [{ type: 'text', text: 'Introduction' }] },
                {
                  label: 'Store',
                  color: '#224466',
                  blocks: [{ type: 'link', text: 'Visit', url: 'https://example.com/store' }],
                },
              ],
            },
          ],
          [{ type: 'caption', text: 'By the author' }],
        ],
      },
    ],
  })!;
  const state = new Map<string, number>();
  const el = renderMysteryCard(card, 'en', state);
  expect((el.firstElementChild as HTMLElement).style.gridTemplateColumns).toContain('2fr');
  const buttons = el.querySelectorAll('button');
  expect(buttons.length).toBe(2);
  buttons[1].click();
  expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
  expect(el.querySelector('a')?.href).toBe('https://example.com/store');
  expect(renderMysteryCard(card, 'fr', state).querySelector('a')).not.toBeNull();
  expect(
    parseMysteryCard({ ...fixture, rows: [[{ type: 'command', text: 'ignored' }]] }),
  ).toBeUndefined();
});
