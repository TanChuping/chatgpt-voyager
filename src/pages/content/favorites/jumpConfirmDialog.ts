/**
 * Modal that warns the user before navigating away to a different ChatGPT
 * conversation. Covers the "temporary chat content will be lost" case and
 * reminds about the draft autosave safety net.
 */
import { getTranslationSyncUnsafe } from '@/utils/i18n';

export const JUMP_CONFIRM_DIALOG_CLASS = 'gv-jump-confirm-dialog';

function t(key: string): string {
  return getTranslationSyncUnsafe(key);
}

export interface JumpConfirmDialogOptions {
  conversationTitle?: string | null;
  contentPreview?: string | null;
}

/**
 * Show the cross-conversation jump confirmation modal. Resolves with `true`
 * when the user confirms, `false` when they cancel or dismiss.
 */
export function showJumpConfirmDialog(options: JumpConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const existing = document.querySelector(`.${JUMP_CONFIRM_DIALOG_CLASS}`);
    if (existing) existing.remove();

    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const overlay = document.createElement('div');
    overlay.className = `${JUMP_CONFIRM_DIALOG_CLASS}__overlay`;

    const dialog = document.createElement('div');
    dialog.className = JUMP_CONFIRM_DIALOG_CLASS;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    const title = document.createElement('div');
    title.className = `${JUMP_CONFIRM_DIALOG_CLASS}__title`;
    title.textContent = t('favoritesJumpDialogTitle');
    dialog.appendChild(title);

    const body = document.createElement('div');
    body.className = `${JUMP_CONFIRM_DIALOG_CLASS}__body`;
    body.textContent = t('favoritesJumpDialogBody');
    dialog.appendChild(body);

    const titleText = (options.conversationTitle ?? '').trim();
    const previewText = (options.contentPreview ?? '').trim();
    if (titleText || previewText) {
      const target = document.createElement('div');
      target.className = `${JUMP_CONFIRM_DIALOG_CLASS}__target`;
      const label = document.createElement('span');
      label.className = `${JUMP_CONFIRM_DIALOG_CLASS}__target-label`;
      label.textContent = t('favoritesJumpDialogTargetLabel');
      target.appendChild(label);

      if (titleText) {
        const value = document.createElement('span');
        value.className = `${JUMP_CONFIRM_DIALOG_CLASS}__target-value`;
        value.textContent = titleText;
        target.appendChild(value);
      }
      if (previewText) {
        const preview = document.createElement('div');
        preview.className = `${JUMP_CONFIRM_DIALOG_CLASS}__target-preview`;
        // Cap the preview so a wall-of-text message doesn't blow up the modal.
        const max = 140;
        preview.textContent =
          previewText.length > max ? `${previewText.slice(0, max).trimEnd()}…` : previewText;
        target.appendChild(preview);
      }

      dialog.appendChild(target);
    }

    const actions = document.createElement('div');
    actions.className = `${JUMP_CONFIRM_DIALOG_CLASS}__actions`;

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = `${JUMP_CONFIRM_DIALOG_CLASS}__btn ${JUMP_CONFIRM_DIALOG_CLASS}__btn--cancel`;
    cancelBtn.textContent = t('favoritesJumpDialogCancel');
    cancelBtn.addEventListener('click', () => settle(false));

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = `${JUMP_CONFIRM_DIALOG_CLASS}__btn ${JUMP_CONFIRM_DIALOG_CLASS}__btn--confirm`;
    confirmBtn.textContent = t('favoritesJumpDialogConfirm');
    confirmBtn.addEventListener('click', () => settle(true));

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);

    overlay.appendChild(dialog);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) settle(false);
    });

    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        settle(false);
      } else if (e.key === 'Enter') {
        // Only treat Enter as confirm if focus is inside the dialog so we
        // don't hijack typing happening elsewhere on the page.
        if (dialog.contains(document.activeElement)) {
          e.preventDefault();
          settle(true);
        }
      }
    };
    document.addEventListener('keydown', onKeydown, true);

    function cleanup() {
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
    }

    document.body.appendChild(overlay);
    // Focus the confirm button so keyboard users can either press Enter to
    // confirm or Tab to reach Cancel.
    requestAnimationFrame(() => {
      confirmBtn.focus();
    });
  });
}
