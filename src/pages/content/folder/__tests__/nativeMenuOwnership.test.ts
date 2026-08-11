import { afterEach, describe, expect, it } from 'vitest';

import {
  createNativeMenuOwnershipSnapshot,
  findRenameConversationMenuItem,
  isOwnedNativeConversationMenu,
} from '../nativeConversationBridge';

const CONVERSATION_ID = '69ecf9a2-d5b4-83ea-a03c-80b3b2514998';

/** ChatGPT's header "…" button: a Radix trigger that names the menu it owns. */
function mountTrigger(id: string, controls: string): HTMLElement {
  const trigger = document.createElement('button');
  trigger.setAttribute('data-testid', 'conversation-options-button');
  trigger.id = id;
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'true');
  trigger.setAttribute('aria-controls', controls);
  document.body.appendChild(trigger);
  return trigger;
}

/** A portalled conversation menu, complete with the markers we key off. */
function mountMenu(id: string, labelledBy: string): HTMLElement {
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  menu.id = id;
  menu.setAttribute('aria-labelledby', labelledBy);
  menu.setAttribute('data-state', 'open');

  const del = document.createElement('div');
  del.setAttribute('role', 'menuitem');
  del.setAttribute('data-testid', 'delete-chat-menu-item');
  menu.appendChild(del);

  document.body.appendChild(menu);
  return menu;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('isOwnedNativeConversationMenu', () => {
  // Regression (2026-08-08): ChatGPT's Radix menus open on *pointerdown*, so by
  // the time the click that arms the ownership watch fires, the menu is already
  // mounted. Treating "already on screen" as disqualifying rejected the very
  // menu we were waiting for, and "Move to folder" stopped being injected.
  it('accepts a menu that was already open when the snapshot was taken, if it is bound to the trigger', () => {
    const trigger = mountTrigger('radix-trigger', 'radix-menu');
    const menu = mountMenu('radix-menu', 'radix-trigger');

    const snapshot = createNativeMenuOwnershipSnapshot(
      trigger,
      CONVERSATION_ID,
      'token-1',
      document,
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot!.existingMenus.has(menu)).toBe(true); // it really did pre-exist
    expect(isOwnedNativeConversationMenu(menu, snapshot!)).toBe(true);
  });

  it('still rejects a pre-existing menu that belongs to a different trigger', () => {
    const trigger = mountTrigger('radix-trigger', 'radix-menu');
    mountMenu('radix-menu', 'radix-trigger');
    const foreignMenu = mountMenu('other-menu', 'other-trigger');

    const snapshot = createNativeMenuOwnershipSnapshot(
      trigger,
      CONVERSATION_ID,
      'token-1',
      document,
    );

    expect(isOwnedNativeConversationMenu(foreignMenu, snapshot!)).toBe(false);
  });

  it('rejects a menu once the trigger no longer claims it', () => {
    const trigger = mountTrigger('radix-trigger', 'radix-menu');
    const menu = mountMenu('radix-menu', 'radix-trigger');
    const snapshot = createNativeMenuOwnershipSnapshot(
      trigger,
      CONVERSATION_ID,
      'token-1',
      document,
    );

    trigger.setAttribute('aria-expanded', 'false');

    expect(isOwnedNativeConversationMenu(menu, snapshot!)).toBe(false);
  });

  it('rejects a menu when the ownership token was reissued (a newer watch owns it)', () => {
    const trigger = mountTrigger('radix-trigger', 'radix-menu');
    const menu = mountMenu('radix-menu', 'radix-trigger');
    const stale = createNativeMenuOwnershipSnapshot(trigger, CONVERSATION_ID, 'token-1', document);
    createNativeMenuOwnershipSnapshot(trigger, CONVERSATION_ID, 'token-2', document);

    expect(isOwnedNativeConversationMenu(menu, stale!)).toBe(false);
  });

  it('finds current, legacy, and localized native rename menu items', () => {
    const menu = mountMenu('rename-menu', 'rename-trigger');

    const current = document.createElement('button');
    current.setAttribute('role', 'menuitem');
    current.setAttribute('data-testid', 'rename-chat-menu-item');
    menu.appendChild(current);
    expect(findRenameConversationMenuItem(menu)).toBe(current);

    current.remove();
    const localized = document.createElement('button');
    localized.setAttribute('role', 'menuitem');
    localized.textContent = '重命名';
    menu.appendChild(localized);
    expect(findRenameConversationMenuItem(menu)).toBe(localized);
  });
});
