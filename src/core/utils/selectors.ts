/**
 * DOM selector utilities
 * Centralized selectors (was duplicated in multiple files)
 */

/**
 * Get selectors for user query elements
 */
export function getUserTurnSelectors(): string[] {
  return [
    // ChatGPT message roles (primary)
    '[data-message-author-role="user"]',
    'article[data-author="user"]',
    'article[data-turn="user"]',
    // Legacy DOM fallbacks kept for imported backup parsing and older tests
    '.user-query-bubble-with-background',
    '.user-query-bubble-container',
    '.user-query-container',
    'user-query-content .user-query-bubble-with-background',
    'user-query-content',
    'user-query',
    'div[aria-label="User message"]',
    'div[role="listitem"][data-user="true"]',
  ];
}

/**
 * Get selectors for assistant/model response elements
 */
export function getAssistantTurnSelectors(): string[] {
  return [
    // ChatGPT message roles (primary)
    '[data-message-author-role="assistant"]',
    'article[data-author="assistant"]',
    'article[data-turn="assistant"]',
    // Legacy DOM fallbacks kept for imported backup parsing and older tests
    '[data-message-author-role="model"]',
    'article[data-turn="model"]',
    'model-response',
    '.model-response',
    'response-container',
    '.response-container',
    '.presented-response-container',
    'div[role="listitem"]:not([data-user="true"])',
  ];
}

/**
 * Get conversation selectors
 */
export function getConversationSelectors(): string[] {
  return [
    'a[href*="/c/"]',
    '[data-testid^="history-item"]',
    '[data-testid="conversation"]',
    '[data-test-id="conversation"]',
    '[data-test-id^="history-item"]',
    '.conversation-card',
  ];
}

/**
 * Get conversation link selectors
 */
export function getConversationLinkSelectors(): string[] {
  return ['a[href*="/c/"]'];
}

/**
 * Build combined selector string
 */
export function combineSelectors(selectors: string[]): string {
  return selectors.join(', ');
}
