const COLLAPSED_CLASS = 'gv-input-collapsed';
const PLACEHOLDER_CLASS = 'gv-collapse-placeholder';
const EDITOR_SELECTOR =
  '#prompt-textarea, form[data-type="unified-composer"] [contenteditable="true"], [data-testid="composer"] [contenteditable="true"], form[data-type="unified-composer"] textarea, [data-testid="composer"] textarea, form[data-type="unified-composer"] rich-textarea, [data-testid="composer"] rich-textarea';

function findCollapsedComposer(): { container: HTMLElement; editor: HTMLElement } | null {
  if (typeof document === 'undefined') return null;
  const editor = document.querySelector<HTMLElement>(EDITOR_SELECTOR);
  const container = editor?.closest<HTMLElement>(`.${COLLAPSED_CLASS}`);
  return editor && container ? { container, editor } : null;
}

function moveCursorToEnd(element: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element.lastChild || element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function expandCollapsedComposer(moveCursor: boolean): void {
  const match = findCollapsedComposer();
  if (!match) return;

  match.container.classList.remove(COLLAPSED_CLASS);
  match.container
    .querySelector<HTMLElement>(`.${PLACEHOLDER_CLASS}`)
    ?.setAttribute('aria-expanded', 'true');

  window.setTimeout(() => {
    if (!match.editor.isConnected) return;
    match.editor.focus();
    if (moveCursor) moveCursorToEnd(match.editor);
  }, 0);
}

/** Expand an already-collapsed composer without importing the feature runtime. */
export function expandInputCollapseIfNeeded(): void {
  expandCollapsedComposer(false);
}

/** Expand an already-collapsed composer and place the caret at its end. */
export function expandInputWithCursorAtEnd(): void {
  expandCollapsedComposer(true);
}
