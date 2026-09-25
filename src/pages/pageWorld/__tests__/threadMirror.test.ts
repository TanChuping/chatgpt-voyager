import { afterEach, describe, expect, it } from 'vitest';

import { syncThreadMirror } from '../threadMirror';

type Fiber = Record<string, unknown>;

const K1 = '11111111-aaaa-4aaa-8aaa-000000000001';
const K2 = '11111111-aaaa-4aaa-8aaa-000000000002';
const K3 = '11111111-aaaa-4aaa-8aaa-000000000003';

function entry(key: string, message: string, attachments: unknown[] = []) {
  return {
    id: `turn-${key}`,
    turn: {
      items: [
        { messageId: key, serverMessageId: key, message, attachments, chatGptFileAttachments: [] },
        { type: 'chatgpt-reasoning-group' },
      ],
    },
  };
}

/**
 * Build what the mirror reads from React: a mounted row whose fiber climbs to
 * the virtual-list component (`props.entries` + a `useRef` holding the layout)
 * and whose first host child is the list's relative container.
 */
function renderVirtualList(
  keys: string[],
  tops: number[],
  heights: number[],
  entries: unknown[],
  mountedKey = keys[keys.length - 1],
): HTMLElement {
  const container = document.createElement('div');
  container.style.position = 'relative';
  const row = document.createElement('div');
  row.setAttribute('data-turn-key', mountedKey);
  container.appendChild(row);
  document.body.appendChild(container);

  const hostFiber: Fiber = { tag: 5, stateNode: container, child: null };
  const layoutRef = { current: { turnKeys: keys, topOffsetsPx: tops, heightsPx: heights } };
  const listFiber: Fiber = {
    tag: 0,
    memoizedProps: { entries },
    memoizedState: { memoizedState: 42, next: { memoizedState: layoutRef, next: null } },
    child: hostFiber,
    return: null,
  };
  const rowFiber: Fiber = { tag: 5, memoizedProps: {}, return: { tag: 5, return: listFiber } };
  (row as unknown as Fiber)['__reactFiber$test'] = rowFiber;
  return container;
}

const anchors = () => Array.from(document.querySelectorAll<HTMLElement>('[data-gv-thread-anchor]'));

describe('thread mirror (2026-09 virtualised thread)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('writes one positioned anchor per loaded exchange, mounted or not', () => {
    renderVirtualList(
      [K1, K2, K3],
      [0, 280, 900],
      [280, 620, 400],
      [entry(K1, 'first'), entry(K2, 'second', [{ label: 'a.pdf', path: '' }]), entry(K3, 'third')],
    );

    expect(syncThreadMirror()).toBe(3);
    const list = anchors();
    expect(list.map((a) => a.getAttribute('data-gv-thread-anchor'))).toEqual([K1, K2, K3]);
    expect(list.map((a) => a.getAttribute('data-turn-id'))).toEqual([
      `u-${K1}`,
      `u-${K2}`,
      `u-${K3}`,
    ]);
    expect(list.map((a) => a.style.top)).toEqual(['0px', '280px', '900px']);
    expect(list[1].style.height).toBe('620px');
    expect(list[1].getAttribute('data-gv-text')).toBe('second');
    expect(list[1].getAttribute('data-gv-attachments')).toBe('["a.pdf"]');
    expect(list[0].hasAttribute('data-gv-attachments')).toBe(false);
  });

  it('follows re-measurement, paging and branch changes without duplicating anchors', () => {
    const container = renderVirtualList(
      [K2, K3],
      [0, 500],
      [500, 300],
      [entry(K2, 'b'), entry(K3, 'c')],
    );
    syncThreadMirror();
    container.remove();

    // Older history paged in above, K3 dropped (branch switch), K2 re-measured.
    renderVirtualList([K1, K2], [0, 350], [350, 480], [entry(K1, 'a'), entry(K2, 'b')], K2);
    syncThreadMirror();
    const list = anchors();
    expect(list.map((a) => a.getAttribute('data-gv-thread-anchor'))).toEqual([K1, K2]);
    expect(list[1].style.top).toBe('350px');
  });

  it('does nothing when no virtual list can be found', () => {
    const row = document.createElement('div');
    row.setAttribute('data-turn-key', K1);
    document.body.appendChild(row);
    expect(syncThreadMirror()).toBe(0);
    expect(anchors()).toHaveLength(0);
  });
});
