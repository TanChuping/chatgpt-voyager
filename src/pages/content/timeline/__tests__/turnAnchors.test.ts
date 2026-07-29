import { beforeEach, describe, expect, it } from 'vitest';

import {
  USER_TURN_ANCHOR_SELECTOR,
  listTurnContainers,
  messageIdFromTurnId,
  syncUserTurnAnchors,
  withUserTurnAnchors,
} from '../turnAnchors';

const USER_A = '7560b589-9625-4a08-adf9-3c9d270d6e33';
const ASSISTANT_A = '8ad2deb8-1eb8-43a7-9d0d-f0adbc186558';
const USER_B = '6563b5fc-5437-42d4-88dc-5fc80902bdfe';
const ASSISTANT_B = 'd4bda8bb-e9a3-4498-9611-c7e13a78cbbc';

/** Virtualised turn: wrapper only, height preserved, no section, no text. */
function placeholder(id: string): HTMLElement {
  const div = document.createElement('div');
  div.setAttribute('data-turn-id-container', id);
  div.setAttribute('data-is-intersecting', 'false');
  return div;
}

/** Mounted turn: wrapper + inner `<section>` carrying the role. */
function mounted(id: string, role: 'user' | 'assistant', index: number): HTMLElement {
  const div = placeholder(id);
  div.setAttribute('data-is-intersecting', 'true');
  const section = document.createElement('section');
  section.setAttribute('data-testid', `conversation-turn-${index}`);
  section.setAttribute('data-turn', role);
  section.setAttribute('data-turn-id', role === 'user' ? `u-${id}` : id);
  // ChatGPT repeats the container attribute on the inner section.
  section.setAttribute('data-turn-id-container', id);
  section.textContent = `${role} ${index}`;
  div.appendChild(section);
  return div;
}

function buildThread(): void {
  const root = document.createElement('div');
  const clientRoot = document.createElement('div');
  clientRoot.setAttribute('data-turn-id-container', 'client-created-root');
  root.append(
    clientRoot,
    placeholder(USER_A),
    placeholder(ASSISTANT_A),
    mounted(USER_B, 'user', 7),
    mounted(ASSISTANT_B, 'assistant', 8),
  );
  document.body.appendChild(root);
}

describe('messageIdFromTurnId', () => {
  it('strips the u- prefix from a real message id', () => {
    expect(messageIdFromTurnId(`u-${USER_A}`)).toBe(USER_A);
  });

  it('accepts a bare uuid', () => {
    expect(messageIdFromTurnId(USER_A)).toBe(USER_A);
  });

  it('rejects synthesised index-based ids (they can never match a wrapper)', () => {
    expect(messageIdFromTurnId('u-3-1f4b9c')).toBeNull();
    expect(messageIdFromTurnId('')).toBeNull();
    expect(messageIdFromTurnId(null)).toBeNull();
  });
});

describe('listTurnContainers', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    buildThread();
  });

  it('returns one wrapper per real turn, skipping the client-created root', () => {
    const ids = listTurnContainers().map((el) => el.getAttribute('data-turn-id-container'));
    expect(ids).toEqual([USER_A, ASSISTANT_A, USER_B, ASSISTANT_B]);
  });

  it('never returns the inner section that repeats the container attribute', () => {
    expect(listTurnContainers().every((el) => el.tagName === 'DIV')).toBe(true);
  });
});

describe('syncUserTurnAnchors', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    buildThread();
  });

  it('tags the wrapper of a virtualised user turn so it becomes selectable', () => {
    expect(document.querySelectorAll(USER_TURN_ANCHOR_SELECTOR)).toHaveLength(0);

    const { tagged } = syncUserTurnAnchors([`u-${USER_A}`, `u-${USER_B}`]);

    expect(tagged).toBe(2);
    const anchored = Array.from(document.querySelectorAll(USER_TURN_ANCHOR_SELECTOR));
    expect(anchored.map((el) => el.getAttribute('data-turn-id-container'))).toEqual([
      USER_A,
      USER_B,
    ]);
  });

  it('mirrors the marker id onto data-turn-id so cached pins/stars keep matching', () => {
    syncUserTurnAnchors([`u-${USER_A}`]);
    const wrapper = document.querySelector<HTMLElement>(`div[data-turn-id-container="${USER_A}"]`);
    expect(wrapper?.dataset.turnId).toBe(`u-${USER_A}`);
  });

  it('never tags an assistant wrapper', () => {
    syncUserTurnAnchors([`u-${USER_A}`, `u-${USER_B}`]);
    const assistant = document.querySelector<HTMLElement>(
      `div[data-turn-id-container="${ASSISTANT_A}"]`,
    );
    expect(assistant?.hasAttribute('data-gv-user-turn')).toBe(false);
  });

  it('untags a wrapper that is no longer a user turn (edit/branch churn)', () => {
    syncUserTurnAnchors([`u-${USER_A}`, `u-${USER_B}`]);
    expect(document.querySelectorAll(USER_TURN_ANCHOR_SELECTOR)).toHaveLength(2);

    syncUserTurnAnchors([`u-${USER_B}`]);
    expect(
      Array.from(document.querySelectorAll(USER_TURN_ANCHOR_SELECTOR)).map((el) =>
        el.getAttribute('data-turn-id-container'),
      ),
    ).toEqual([USER_B]);
  });

  it('ignores ids with no wrapper in the DOM', () => {
    expect(syncUserTurnAnchors(['u-00000000-0000-4000-8000-000000000000']).tagged).toBe(0);
  });
});

describe('syncUserTurnAnchors — unresolved count', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    buildThread();
  });

  it('counts virtualised wrappers we cannot classify yet', () => {
    // Both placeholders are unidentified until the conversation data lands.
    expect(syncUserTurnAnchors([]).unresolved).toBe(2);
  });

  it('stops counting a placeholder once it is tagged as a user turn', () => {
    expect(syncUserTurnAnchors([`u-${USER_A}`]).unresolved).toBe(1);
  });

  it('never counts a mounted turn — its role is readable from the DOM', () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.append(mounted(USER_B, 'user', 7), mounted(ASSISTANT_B, 'assistant', 8));
    document.body.appendChild(root);
    expect(syncUserTurnAnchors([]).unresolved).toBe(0);
  });

  it('reports zero unresolved once every wrapper is classified', () => {
    expect(syncUserTurnAnchors([`u-${USER_A}`, `u-${ASSISTANT_A}`]).unresolved).toBe(0);
  });
});

describe('withUserTurnAnchors', () => {
  it('prepends the anchor selector', () => {
    expect(withUserTurnAnchors('.foo')).toBe(`${USER_TURN_ANCHOR_SELECTOR},.foo`);
  });

  it('is idempotent', () => {
    const once = withUserTurnAnchors('.foo');
    expect(withUserTurnAnchors(once)).toBe(once);
  });

  it('handles an empty selector', () => {
    expect(withUserTurnAnchors('')).toBe(USER_TURN_ANCHOR_SELECTOR);
  });
});
