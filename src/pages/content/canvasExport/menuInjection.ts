import {
  findCanvasActions,
  findCanvasEditableRoot,
  findCanvasSurface,
  resolveChatGptMenuTrigger,
} from '../chatgptDom';
import { createMenuItemFromNativeTemplate } from '../shared/nativeMenuItemTemplate';

const LEGACY_MENU_PANEL_SELECTOR = '.mat-mdc-menu-panel[role="menu"]';
const LEGACY_CANVAS_SHARE_WRAPPER_SELECTOR =
  'share-button[data-test-id="consolidated-share-button"]';
export const CANVAS_MARKDOWN_BUTTON_CLASS = 'gv-canvas-copy-markdown-btn';

export type CanvasMenuInjectionOptions = {
  label: string;
  tooltip: string;
  onClick: () => void;
};

function isLegacyMenu(menu: HTMLElement): boolean {
  return menu.matches(LEGACY_MENU_PANEL_SELECTOR);
}

function menuContent(menu: HTMLElement): HTMLElement | null {
  if (isLegacyMenu(menu)) return menu.querySelector<HTMLElement>('.mat-mdc-menu-content');
  return menu.matches('[role="menu"]') ? menu : null;
}

function buildMarkdownIcon(): SVGSVGElement {
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
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M4 5h16v14H4zM7 15V9l3 3 3-3v6m3-3h2m-1-1v4');
  svg.appendChild(path);
  return svg;
}

function updateCurrentButton(button: HTMLElement, label: string, tooltip: string): void {
  button.setAttribute('aria-label', tooltip || label);
  button.title = tooltip || label;
  const text = button.querySelector<HTMLElement>('[data-gv-canvas-label]');
  if (text) text.textContent = label;
}

function clearClonedActionState(element: HTMLElement): void {
  const formStateAttributes = new Set(['disabled', 'form', 'formaction', 'name', 'value']);
  Array.from(element.attributes).forEach((attribute) => {
    if (
      attribute.name === 'id' ||
      attribute.name.startsWith('aria-') ||
      attribute.name.startsWith('data-') ||
      formStateAttributes.has(attribute.name)
    ) {
      element.removeAttribute(attribute.name);
    }
  });
  if (element instanceof HTMLButtonElement) element.disabled = false;
}

function closeMenu(menu: HTMLElement): void {
  if (isLegacyMenu(menu)) {
    const backdrops = document.querySelectorAll<HTMLElement>('.cdk-overlay-backdrop');
    const backdrop = backdrops[backdrops.length - 1];
    if (backdrop) backdrop.click();
    else menu.remove();
    return;
  }
  const trigger = resolveChatGptMenuTrigger(menu);
  const actionable = trigger?.matches('button')
    ? trigger
    : trigger?.querySelector<HTMLElement>('button, [role="button"]');
  if (actionable) actionable.click();
  else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

export function isCanvasContext(): boolean {
  return Boolean(findCanvasSurface());
}

function referencesMenu(trigger: HTMLElement, menu: HTMLElement): boolean {
  if (!menu.id) return false;
  return `${trigger.getAttribute('aria-controls') || ''} ${trigger.getAttribute('aria-owns') || ''}`
    .split(/\s+/)
    .includes(menu.id);
}

function hasOwnedMenuTrigger(root: HTMLElement, menu: HTMLElement): boolean {
  const candidates = [
    ...(root.matches('[aria-controls], [aria-owns]') ? [root] : []),
    ...Array.from(root.querySelectorAll<HTMLElement>('[aria-controls], [aria-owns]')),
  ];
  return candidates.some((trigger) => referencesMenu(trigger, menu));
}

/** A narrow pre-hydration check used only to decide whether a failed Canvas
 * menu injection merits a bounded retry. It never guesses from an unrelated
 * open menu elsewhere in the document. */
export function isCanvasShareMenuCandidate(menu: HTMLElement): boolean {
  if (!menu.matches('[role="menu"]') || !menuContent(menu) || !menu.id || !isCanvasContext()) {
    return false;
  }
  if (document.querySelector('deep-research-immersive-panel')) return false;
  if (menu.classList.contains('gds-mode-switch-menu')) return false;
  if (isLegacyMenu(menu)) {
    const wrapper = document.querySelector<HTMLElement>(LEGACY_CANVAS_SHARE_WRAPPER_SELECTOR);
    return Boolean(wrapper && hasOwnedMenuTrigger(wrapper, menu));
  }

  const surface = findCanvasSurface();
  return Boolean(surface && hasOwnedMenuTrigger(surface, menu));
}

export function isCanvasShareMenuPanel(menu: HTMLElement): boolean {
  if (!isCanvasShareMenuCandidate(menu)) return false;
  const trigger = resolveChatGptMenuTrigger(menu);
  if (!trigger) return false;
  if (isLegacyMenu(menu)) {
    return Boolean(trigger.closest(LEGACY_CANVAS_SHARE_WRAPPER_SELECTOR));
  }

  const surface = findCanvasSurface();
  if (!surface) return false;
  return (
    surface.contains(trigger) ||
    Boolean(trigger.closest('[data-testid*="canvas" i], [aria-label*="canvas" i]'))
  );
}

export function findCanvasProseMirrorRoot(): HTMLElement | null {
  return findCanvasEditableRoot();
}

type CurrentMenuTarget = {
  container: HTMLElement;
  template: HTMLElement;
};

const currentButtonActions = new WeakMap<HTMLElement, () => void>();

function isOwnedMenuItem(menu: HTMLElement, item: HTMLElement): boolean {
  return (
    item.closest<HTMLElement>('[role="menu"]') === menu &&
    !item.parentElement?.closest('[role="menuitem"]')
  );
}

function findCurrentMenuTarget(menu: HTMLElement): CurrentMenuTarget | null {
  if (isLegacyMenu(menu)) return null;
  const candidates = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter(
    (item) =>
      isOwnedMenuItem(menu, item) &&
      !item.classList.contains(CANVAS_MARKDOWN_BUTTON_CLASS) &&
      !item.hasAttribute('data-has-submenu') &&
      item.getAttribute('aria-haspopup') !== 'menu' &&
      !item.classList.contains('sm:hidden'),
  );
  const template =
    candidates.find((item) => {
      const group = item.closest<HTMLElement>('[role="group"]');
      return Boolean(group && group.closest<HTMLElement>('[role="menu"]') === menu);
    }) || candidates[0];
  if (!template?.parentElement) return null;

  const container = template.parentElement;
  if (container !== menu && container.closest<HTMLElement>('[role="menu"]') !== menu) return null;
  const group = template.closest<HTMLElement>('[role="group"]');
  if (group && group.closest<HTMLElement>('[role="menu"]') !== menu) return null;
  if (group && container !== group && !group.contains(container)) return null;
  return { container, template };
}

function createPresentationPeer(template: HTMLElement): HTMLElement {
  const element = document.createElement(template.tagName.toLowerCase());
  const className = template.getAttribute('class');
  if (className) element.setAttribute('class', className);
  return element;
}

function createCurrentMenuButton(
  menu: HTMLElement,
  target: CurrentMenuTarget,
  options: CanvasMenuInjectionOptions,
): HTMLElement {
  const button = createPresentationPeer(target.template);
  button.classList.add(CANVAS_MARKDOWN_BUTTON_CLASS);
  button.setAttribute('role', 'menuitem');
  button.setAttribute('tabindex', '-1');
  if (button instanceof HTMLButtonElement) button.type = 'button';

  const nativeIconWrapper = target.template.querySelector('svg')?.parentElement;
  const iconWrapper = nativeIconWrapper
    ? createPresentationPeer(nativeIconWrapper)
    : document.createElement('span');
  iconWrapper.replaceChildren(buildMarkdownIcon());
  const label = document.createElement('span');
  label.setAttribute('data-gv-canvas-label', '1');
  label.textContent = options.label;
  button.replaceChildren(iconWrapper, label);
  updateCurrentButton(button, options.label, options.tooltip);

  const activate = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    currentButtonActions.get(button)?.();
    closeMenu(menu);
  };
  currentButtonActions.set(button, options.onClick);
  button.addEventListener('click', activate);
  if (!(button instanceof HTMLButtonElement)) {
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') activate(event);
    });
  }
  return button;
}

export function injectCanvasCopyMarkdownButton(
  menu: HTMLElement,
  options: CanvasMenuInjectionOptions,
): HTMLElement | null {
  if (!isCanvasShareMenuPanel(menu)) return null;
  const content = menuContent(menu);
  if (!content) return null;
  const existingButtons = Array.from(
    content.querySelectorAll<HTMLElement>(`.${CANVAS_MARKDOWN_BUTTON_CLASS}`),
  ).filter((button) => isLegacyMenu(menu) || button.closest('[role="menu"]') === menu);
  const existing = existingButtons.shift();
  existingButtons.forEach((button) => button.remove());
  if (existing) {
    if (isLegacyMenu(menu)) {
      existing.title = options.tooltip || options.label;
      existing.setAttribute('aria-label', options.tooltip || options.label);
      const text = existing.querySelector<HTMLElement>('.mat-mdc-menu-item-text');
      if (text) text.textContent = options.label;
    } else {
      const target = findCurrentMenuTarget(menu);
      if (!target) {
        existing.remove();
        return null;
      }
      if (existing.parentElement !== target.container) target.container.appendChild(existing);
      currentButtonActions.set(existing, options.onClick);
      updateCurrentButton(existing, options.label, options.tooltip);
    }
    return existing;
  }

  if (!isLegacyMenu(menu)) {
    const target = findCurrentMenuTarget(menu);
    if (!target) return null;
    const button = createCurrentMenuButton(menu, target, options);
    target.container.appendChild(button);
    return button;
  }

  const button = createMenuItemFromNativeTemplate({
    menuContent: content,
    injectedClassName: CANVAS_MARKDOWN_BUTTON_CLASS,
    iconName: 'content_copy',
    label: options.label,
    tooltip: options.tooltip,
    excludedClassNames: [CANVAS_MARKDOWN_BUTTON_CLASS, 'share-button'],
  });
  if (!button) return null;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    options.onClick();
    closeMenu(menu);
  });
  content.appendChild(button);
  return button;
}

/** A semantic toolbar fallback for Canvas variants whose Share button does not
 * expose a menu. This is intentionally tiny; markdown conversion remains lazy
 * until the user activates it. */
export function injectCanvasToolbarButton(options: CanvasMenuInjectionOptions): HTMLElement | null {
  const actions = findCanvasActions();
  if (!actions) return null;
  const existing = actions.querySelector<HTMLElement>(`.${CANVAS_MARKDOWN_BUTTON_CLASS}`);
  if (existing) {
    updateCurrentButton(existing, options.label, options.tooltip);
    return existing;
  }

  const template = actions.querySelector<HTMLElement>('button, [role="button"]');
  const button = template
    ? (template.cloneNode(false) as HTMLElement)
    : document.createElement('button');
  button.classList.add(CANVAS_MARKDOWN_BUTTON_CLASS);
  clearClonedActionState(button);
  button.setAttribute('type', 'button');
  button.setAttribute('data-gv-canvas-toolbar-button', '1');
  const label = document.createElement('span');
  label.setAttribute('data-gv-canvas-label', '1');
  label.className = 'sr-only';
  label.textContent = options.label;
  button.replaceChildren(buildMarkdownIcon(), label);
  updateCurrentButton(button, options.label, options.tooltip);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    options.onClick();
  });
  actions.appendChild(button);
  return button;
}
