import { findTurnAction, findTurnActionBar, getTurnRole } from '../chatgptDom';

export type ResponseActionCopyImageOptions = {
  label: string;
  tooltip: string;
  onClick: (button: HTMLElement) => void;
};

const CURRENT_COPY_SELECTOR = '[data-testid="copy-turn-action-button"]';
const LEGACY_COPY_SELECTOR = '[data-test-id="copy-button"]';
const COPY_SELECTOR = `${CURRENT_COPY_SELECTOR}, ${LEGACY_COPY_SELECTOR}`;
const COPY_IMAGE_TEST_ID = 'gv-copy-image-button';
const COPY_IMAGE_MARKER = 'data-gv-copy-image-button';

type BoundCopyImageButton = HTMLElement & {
  __gvCopyImageHandler?: (event: Event) => void;
};

function queryIncludingRoot(root: ParentNode, selector: string): HTMLElement[] {
  const result: HTMLElement[] = [];
  if (root instanceof HTMLElement && root.matches(selector)) result.push(root);
  result.push(...Array.from(root.querySelectorAll<HTMLElement>(selector)));
  return result;
}

function buildImageIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');

  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', '3');
  rect.setAttribute('y', '4');
  rect.setAttribute('width', '18');
  rect.setAttribute('height', '16');
  rect.setAttribute('rx', '2');
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '9');
  circle.setAttribute('cy', '10');
  circle.setAttribute('r', '2');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm21 15-5-5L5 20');
  svg.append(rect, circle, path);
  return svg;
}

function updateButtonIcon(button: HTMLElement): void {
  const materialIcon = button.querySelector('mat-icon');
  if (materialIcon instanceof HTMLElement) {
    if (materialIcon.hasAttribute('fonticon')) materialIcon.setAttribute('fonticon', 'image');
    if (materialIcon.hasAttribute('data-mat-icon-name')) {
      materialIcon.setAttribute('data-mat-icon-name', 'image');
    }
    materialIcon.textContent = 'image';
    return;
  }

  const svg = button.querySelector('svg');
  if (svg) svg.replaceWith(buildImageIcon());
  else button.prepend(buildImageIcon());
}

function updateButtonLabel(button: HTMLElement, label: string, tooltip: string): void {
  const accessibleLabel = tooltip || label;
  button.setAttribute('aria-label', accessibleLabel);
  button.title = accessibleLabel;
  button.setAttribute('data-gv-copy-image-label', label);
  button.removeAttribute('aria-describedby');
}

function bindButtonClick(button: HTMLElement, onClick: (button: HTMLElement) => void): void {
  const typed = button as BoundCopyImageButton;
  if (typed.__gvCopyImageHandler) {
    button.removeEventListener('click', typed.__gvCopyImageHandler);
  }
  const handler = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick(button);
  };
  typed.__gvCopyImageHandler = handler;
  button.addEventListener('click', handler);
}

function isAssistantCopyButton(copyButton: HTMLElement): boolean {
  return (
    getTurnRole(copyButton) === 'assistant' ||
    Boolean(
      copyButton.closest(
        '.model-response, model-response, .response-container, response-container, .presented-response-container',
      ),
    )
  );
}

function insertNextToNativeCopy(
  bar: HTMLElement,
  copyButton: HTMLElement,
  copyImageButton: HTMLElement,
): void {
  const legacyMore = findTurnAction(copyButton, 'more');
  if (copyButton.matches(LEGACY_COPY_SELECTOR) && legacyMore?.parentElement) {
    legacyMore.parentElement.insertBefore(copyImageButton, legacyMore);
    return;
  }

  if (copyButton.parentElement) {
    copyButton.parentElement.insertBefore(copyImageButton, copyButton.nextSibling);
  } else if (!bar.contains(copyImageButton)) {
    bar.appendChild(copyImageButton);
  }
}

function injectForCopyButton(
  copyButton: HTMLElement,
  options: ResponseActionCopyImageOptions,
): HTMLElement | null {
  if (!isAssistantCopyButton(copyButton)) return null;
  const bar = findTurnActionBar(copyButton);
  if (!bar) return null;

  const existing = bar.querySelector<HTMLElement>(
    `[${COPY_IMAGE_MARKER}], [data-testid="${COPY_IMAGE_TEST_ID}"], [data-test-id="${COPY_IMAGE_TEST_ID}"]`,
  );
  if (existing) {
    updateButtonLabel(existing, options.label, options.tooltip);
    updateButtonIcon(existing);
    bindButtonClick(existing, options.onClick);
    insertNextToNativeCopy(bar, copyButton, existing);
    return existing;
  }

  const cloned = copyButton.cloneNode(true) as HTMLElement;
  cloned.removeAttribute('id');
  cloned.removeAttribute('data-test-id');
  cloned.removeAttribute('aria-pressed');
  if (copyButton.matches(LEGACY_COPY_SELECTOR)) {
    cloned.removeAttribute('data-testid');
    cloned.setAttribute('data-test-id', COPY_IMAGE_TEST_ID);
  } else {
    cloned.setAttribute('data-testid', COPY_IMAGE_TEST_ID);
  }
  cloned.setAttribute(COPY_IMAGE_MARKER, '1');
  updateButtonLabel(cloned, options.label, options.tooltip);
  updateButtonIcon(cloned);
  bindButtonClick(cloned, options.onClick);
  insertNextToNativeCopy(bar, copyButton, cloned);
  return cloned;
}

export function injectResponseActionCopyImageButtons(
  root: ParentNode,
  options: ResponseActionCopyImageOptions,
): HTMLElement[] {
  const visitedBars = new Set<HTMLElement>();
  const injected: HTMLElement[] = [];
  for (const copyButton of queryIncludingRoot(root, COPY_SELECTOR)) {
    const bar = findTurnActionBar(copyButton);
    if (!bar || visitedBars.has(bar)) continue;
    visitedBars.add(bar);
    const button = injectForCopyButton(copyButton, options);
    if (button) injected.push(button);
  }
  return injected;
}
