// DOM adapter based on drive_auth_click.js and the 2026-10-20 recorded sample.
// Match the container, not forms with @max-md/approval-card classes.
export const DRIVE_APPROVAL_CARD_SELECTOR = 'div[class~="@container/approval-card"]';
const ALLOW_LABELS = new Set(['始终允许', 'Always allow']);
const normalize = (text: string | null) => (text || '').replace(/\s+/g, ' ').trim();

export function findDriveAlwaysAllowButton(card: Element): HTMLButtonElement | null {
  if (!card.isConnected || card.querySelector(DRIVE_APPROVAL_CARD_SELECTOR)) return null;
  if (card.closest('[hidden], [aria-hidden="true"]')) return null;
  // The provider label lives in the alert above the action form. Do not approve
  // another connector just because its tool description mentions Google Drive.
  const alert = card.querySelector('[role="alert"]');
  if (!alert || !/允许|Allow/i.test(alert.textContent || '')) return null;
  if (
    !Array.from(alert.querySelectorAll('span')).some(
      (label) => normalize(label.textContent) === 'Google Drive',
    )
  )
    return null;

  const buttons = Array.from(card.querySelectorAll<HTMLButtonElement>('form button')).filter(
    (button) => ALLOW_LABELS.has(normalize(button.textContent)),
  );
  if (buttons.length !== 1) return null;
  const button = buttons[0];
  if (
    button.matches(':disabled') ||
    button.getAttribute('aria-disabled') === 'true' ||
    button.closest('[hidden], [aria-hidden="true"]')
  )
    return null;
  return button;
}
