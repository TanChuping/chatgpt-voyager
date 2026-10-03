import { afterEach, describe, expect, it } from 'vitest';

import { findActiveConversationRoot } from '../../chatgptDom';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('active conversation root', () => {
  it('selects the active cached page instead of the first main', () => {
    document.body.innerHTML =
      '<div data-app-shell-active-page="false"><main id="old"></main></div><div data-app-shell-active-page="true"><main id="current"></main></div>';
    expect(findActiveConversationRoot()?.id).toBe('current');
  });
  it('does not fall back to cached pages during a transition', () => {
    document.body.innerHTML = '<div data-app-shell-active-page="false"><main></main></div>';
    expect(findActiveConversationRoot()).toBeNull();
  });
  it('keeps the legacy visible-main path while excluding hidden hosts', () => {
    document.body.innerHTML =
      '<div style="display:none"><main id="old"></main></div><main id="current"></main>';
    expect(findActiveConversationRoot()?.id).toBe('current');
  });
});
