const ACTIVE_GENERATION_SELECTOR = [
  '[data-testid="stop-button"]',
  'button[data-testid*="stop" i]',
  'button[aria-label*="stop generating" i]',
].join(',');

export function isChatGptResponseGenerating(root: ParentNode = document): boolean {
  return root.querySelector(ACTIVE_GENERATION_SELECTOR) !== null;
}
