// DOM adapter based on drive_auth_click.js and the 2026-10-20 recorded sample.
// Match the container, not forms with @max-md/approval-card classes.
export const DRIVE_APPROVAL_CARD_SELECTOR = 'div[class~="@container/approval-card"]';
export const APPROVAL_IGNORED_SELECTOR =
  'pre, code, [data-markdown-copy="code-block"], [contenteditable]:not([contenteditable="false"])';
const ALLOW_LABELS = new Set(['始终允许', 'Always allow']);
const normalize = (text: string | null) => (text || '').replace(/\s+/g, ' ').trim();

function findDriveActionButton(card: Element): HTMLButtonElement | null {
  if (!card.matches(DRIVE_APPROVAL_CARD_SELECTOR) || card.closest(APPROVAL_IGNORED_SELECTOR))
    return null;
  if (!card.isConnected || card.querySelector(DRIVE_APPROVAL_CARD_SELECTOR)) return null;
  if (card.closest('[hidden], [aria-hidden="true"]')) return null;
  // The first span after the icon is the provider title in the recorded alert.
  // Descriptions and details may contain other provider names; never search them.
  const alert = card.querySelector('[role="alert"]');
  if (!alert || !/允许|Allow/i.test(alert.textContent || '')) return null;
  if (normalize(alert.querySelector('span')?.textContent ?? null) !== 'Google Drive') return null;

  const buttons = Array.from(card.querySelectorAll<HTMLButtonElement>('form button')).filter(
    (button) => ALLOW_LABELS.has(normalize(button.textContent)),
  );
  if (buttons.length !== 1) return null;
  const button = buttons[0];
  if (button !== card.querySelector('form button')) return null;
  if (button.closest('[hidden], [aria-hidden="true"]')) return null;
  return button;
}

export function findDriveApprovalRequest(card: Element) {
  const button = findDriveActionButton(card);
  if (!button) return null;
  // Only the named tool participates in identity, never the whole card's text.
  const text = normalize(card.textContent);
  const match =
    text.match(/ChatGPT\s*将调用\s*Google Drive\s*的\s*(.{1,120}?)\s*工具/) ??
    text.match(/ChatGPT will (?:call|use) Google Drive['’]s\s+(.{1,120}?)\s+tool\b/i);
  const tool = normalize(match?.[1] ?? null);
  if (!tool) return null;
  return {
    button,
    tool,
    signature: JSON.stringify(['Google Drive', tool]),
    enabled: !button.matches(':disabled') && button.getAttribute('aria-disabled') !== 'true',
  };
}
