type NativeMenuItemTemplateOptions = {
  menuContent: HTMLElement;
  injectedClassName: string;
  iconName: string;
  label: string;
  tooltip?: string;
  excludedClassNames?: string[];
};

function findTemplateMenuItem(
  menuContent: HTMLElement,
  excludedClassNames: string[],
): HTMLButtonElement | null {
  const directButtons = Array.from(menuContent.children).filter(
    (node): node is HTMLButtonElement =>
      node instanceof HTMLButtonElement && node.classList.contains('mat-mdc-menu-item'),
  );

  const nestedButtons = Array.from(
    menuContent.querySelectorAll<HTMLButtonElement>('button.mat-mdc-menu-item'),
  );
  const candidates: HTMLButtonElement[] = [...directButtons];
  for (const button of nestedButtons) {
    if (!candidates.includes(button)) {
      candidates.push(button);
    }
  }

  return (
    candidates.find(
      (button) => !excludedClassNames.some((className) => button.classList.contains(className)),
    ) ?? null
  );
}

function updateMenuItemLabel(button: HTMLButtonElement, label: string): void {
  const textContainer = button.querySelector('.mat-mdc-menu-item-text') as HTMLElement | null;
  if (!textContainer) return;

  const styledLabel = textContainer.querySelector(
    '.menu-text, .gds-body-m, .gds-label-m, .subtitle',
  );
  if (styledLabel) {
    styledLabel.textContent = label;
    return;
  }

  textContainer.textContent = label;
}

function updateMenuItemIcon(button: HTMLButtonElement, iconName: string): void {
  const icon = button.querySelector('mat-icon') as HTMLElement | null;
  if (!icon) return;

  const usesFontIconAttribute = icon.hasAttribute('fonticon');
  if (usesFontIconAttribute) {
    icon.setAttribute('fonticon', iconName);
  } else {
    icon.removeAttribute('fonticon');
  }
  if (icon.hasAttribute('data-mat-icon-name')) {
    icon.setAttribute('data-mat-icon-name', iconName);
  }
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = usesFontIconAttribute ? '' : iconName;
}

function clearTemplateSpecificAttributes(button: HTMLButtonElement): void {
  const attributesToRemove = [
    'data-test-id',
    'id',
    'jslog',
    'jscontroller',
    'jsaction',
    'jsname',
    'aria-describedby',
    'aria-labelledby',
  ];

  for (const attribute of attributesToRemove) {
    button.removeAttribute(attribute);
  }

  const classesToRemove = [
    'cdk-focused',
    'cdk-keyboard-focused',
    'cdk-program-focused',
    'cdk-mouse-focused',
    'mat-mdc-menu-item-highlighted',
  ];
  for (const className of classesToRemove) {
    button.classList.remove(className);
  }
}

export function createMenuItemFromNativeTemplate({
  menuContent,
  injectedClassName,
  iconName,
  label,
  tooltip,
  excludedClassNames = [],
}: NativeMenuItemTemplateOptions): HTMLButtonElement | null {
  const template = findTemplateMenuItem(menuContent, [injectedClassName, ...excludedClassNames]);
  if (!template) return null;

  const button = template.cloneNode(true) as HTMLButtonElement;
  clearTemplateSpecificAttributes(button);
  button.classList.add(injectedClassName);
  button.setAttribute('role', 'menuitem');
  button.setAttribute('tabindex', '0');
  button.setAttribute('aria-disabled', 'false');
  button.disabled = false;

  const description = tooltip || label;
  button.title = description;
  button.setAttribute('aria-label', description);

  updateMenuItemIcon(button, iconName);
  updateMenuItemLabel(button, label);

  return button;
}

export function updateMenuItemTemplateLabel(
  button: HTMLButtonElement,
  label: string,
  tooltip?: string,
): void {
  const description = tooltip || label;
  button.title = description;
  button.setAttribute('aria-label', description);
  updateMenuItemLabel(button, label);
}

export type AppShellMenuItemOptions = {
  className: string;
  label: string;
  tooltip?: string;
  icon: Element;
  /** Classes of our own injected items, never used as the template. */
  excludedClassNames?: string[];
};

const APP_SHELL_ICON_SLOT_SELECTOR = '[class*="leadingIcon"]';
const APP_SHELL_LABEL_SELECTOR = 'span.truncate';

/**
 * ChatGPT 2026-09 (Codex app shell) Radix menu item:
 *   [role=menuitem] > div(row) > span.flex-1 > span.flex > [span.leadingIcon-*, span.truncate]
 * The row / icon / label layout lives on those inner nodes, so an injected
 * item must deep-clone a plain native item and swap only the icon and label —
 * a shallow clone stacks the icon above the text. Returns null on menus
 * without that structure so callers keep their older strategies.
 */
export function cloneAppShellMenuItem(
  menu: HTMLElement,
  options: AppShellMenuItemOptions,
): HTMLElement | null {
  const excluded = [options.className, ...(options.excludedClassNames ?? [])];
  const template = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) =>
      item.closest('[role="menu"]') === menu &&
      !item.hasAttribute('aria-haspopup') &&
      item.getAttribute('data-testid') !== 'delete-chat-menu-item' &&
      !excluded.some((className) => item.classList.contains(className)) &&
      !!item.querySelector(APP_SHELL_ICON_SLOT_SELECTOR) &&
      !!item.querySelector(APP_SHELL_LABEL_SELECTOR),
  );
  if (!template) return null;

  const item = template.cloneNode(true) as HTMLElement;
  for (const node of [item, ...Array.from(item.querySelectorAll<HTMLElement>('*'))]) {
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name;
      if (
        name === 'id' ||
        name === 'data-testid' ||
        name === 'data-gv-compat-testid' ||
        name === 'data-state' ||
        name.startsWith('data-radix-') ||
        (node === item && name.startsWith('aria-'))
      ) {
        node.removeAttribute(name);
      }
    }
  }
  item.classList.add(options.className);
  item.setAttribute('role', 'menuitem');
  item.setAttribute('tabindex', '0');
  item.setAttribute('aria-label', options.tooltip || options.label);
  item.title = options.tooltip || options.label;

  item.querySelector(APP_SHELL_ICON_SLOT_SELECTOR)?.replaceChildren(options.icon);
  const labels = item.querySelectorAll<HTMLElement>(APP_SHELL_LABEL_SELECTOR);
  const label = labels[labels.length - 1];
  label.textContent = options.label;
  label.setAttribute('data-gv-menu-label', '1');
  return item;
}
