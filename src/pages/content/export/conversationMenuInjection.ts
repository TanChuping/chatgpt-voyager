import {
  findAssistantTurnForElement,
  isConversationOptionsTrigger,
  isSidebarConversationOptionsTrigger,
  resolveChatGptMenuTrigger,
} from '../chatgptDom';
import {
  createMenuItemFromNativeTemplate,
  updateMenuItemTemplateLabel,
} from '../shared/nativeMenuItemTemplate';

export type ConversationMenuExportOptions = {
  label: string;
  tooltip: string;
  onClick: () => void;
};

export type ConversationMenuType = 'top' | 'sidebar';

export type ConversationMenuContext = {
  menuType: ConversationMenuType;
  trigger: HTMLElement | null;
};

export type ResponseMenuContext = {
  trigger: HTMLElement | null;
};

const MENU_BUTTON_CLASS = 'gv-export-conversation-menu-btn';
const RESPONSE_MENU_BUTTON_CLASS = 'gv-export-response-menu-btn';
const LEGACY_MENU_PANEL_SELECTOR = '.mat-mdc-menu-panel[role="menu"]';
const CURRENT_MENU_ITEM_SELECTOR = '[role="menuitem"]';

function isLegacyMenu(menu: HTMLElement): boolean {
  return menu.matches(LEGACY_MENU_PANEL_SELECTOR);
}

function findMenuContent(menu: HTMLElement): HTMLElement | null {
  if (!isLegacyMenu(menu)) return menu.matches('[role="menu"]') ? menu : null;
  return menu.querySelector<HTMLElement>('.mat-mdc-menu-content');
}

function hasDeepResearchReportMarkers(menuContent: HTMLElement): boolean {
  return Boolean(
    menuContent.querySelector('[data-test-id="share-button-tooltip-container"]') ||
      menuContent.querySelector('[data-test-id="export-to-docs-button"]') ||
      menuContent.querySelector('deep-research-immersive-panel'),
  );
}

function legacyConversationMenu(menu: HTMLElement): boolean {
  if (!isLegacyMenu(menu) || menu.classList.contains('gds-mode-switch-menu')) return false;
  if (menu.querySelector('.bard-mode-list-button')) return false;
  const content = findMenuContent(menu);
  if (!content || hasDeepResearchReportMarkers(content)) return false;
  const trigger = resolveChatGptMenuTrigger(menu);
  if (trigger?.getAttribute('data-test-id') !== 'actions-menu-button') return false;
  return Boolean(
    content.querySelector('[data-test-id="pin-button"]') ||
      content.querySelector('[data-test-id="rename-button"]') ||
      content.querySelector('[data-test-id="delete-button"]') ||
      content.querySelector('[data-test-id="share-button"]'),
  );
}

function isCurrentMenu(menu: HTMLElement): boolean {
  return menu.matches('[role="menu"]') && !isLegacyMenu(menu);
}

export function isConversationMenuPanel(menu: HTMLElement): boolean {
  if (legacyConversationMenu(menu)) return true;
  if (!isCurrentMenu(menu)) return false;
  const trigger = resolveChatGptMenuTrigger(menu);
  return Boolean(trigger && isConversationOptionsTrigger(trigger));
}

export function getConversationMenuContext(menu: HTMLElement): ConversationMenuContext | null {
  if (!isConversationMenuPanel(menu)) return null;
  const trigger = resolveChatGptMenuTrigger(menu);
  if (!trigger) return null;
  if (isLegacyMenu(menu)) {
    const sidebar = Boolean(trigger?.closest('[data-test-id="overflow-container"]'));
    return { menuType: sidebar ? 'sidebar' : 'top', trigger };
  }
  return {
    menuType: isSidebarConversationOptionsTrigger(trigger) ? 'sidebar' : 'top',
    trigger,
  };
}

function legacyResponseMenu(menu: HTMLElement): boolean {
  if (!isLegacyMenu(menu) || menu.classList.contains('gds-mode-switch-menu')) return false;
  const content = findMenuContent(menu);
  if (!content || hasDeepResearchReportMarkers(content)) return false;
  const trigger = resolveChatGptMenuTrigger(menu);
  if (trigger?.getAttribute('data-test-id') === 'more-menu-button') return true;
  const icons = Array.from(content.querySelectorAll('mat-icon')).map(
    (icon) => icon.getAttribute('fonticon') || icon.textContent?.trim(),
  );
  return icons.includes('docs') && (icons.includes('gmail') || icons.includes('flag'));
}

export function isResponseMenuPanel(menu: HTMLElement): boolean {
  if (legacyResponseMenu(menu)) return true;
  if (!isCurrentMenu(menu) || isConversationMenuPanel(menu)) return false;
  const trigger = resolveChatGptMenuTrigger(menu);
  return Boolean(trigger && findAssistantTurnForElement(trigger));
}

export function getResponseMenuContext(menu: HTMLElement): ResponseMenuContext | null {
  if (!isResponseMenuPanel(menu)) return null;
  return { trigger: resolveChatGptMenuTrigger(menu) };
}

function buildDownloadIcon(): SVGSVGElement {
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
  path.setAttribute('d', 'M12 3v12m-5-5 5 5 5-5M5 21h14');
  svg.appendChild(path);
  return svg;
}

function updateCurrentMenuItem(item: HTMLElement, label: string, tooltip: string): void {
  item.setAttribute('aria-label', tooltip || label);
  item.title = tooltip || label;
  const labelElement = item.querySelector<HTMLElement>('[data-gv-menu-label]');
  if (labelElement) labelElement.textContent = label;
}

function createCurrentMenuItem(
  menu: HTMLElement,
  className: string,
  options: ConversationMenuExportOptions,
): HTMLElement | null {
  const template = Array.from(menu.querySelectorAll<HTMLElement>(CURRENT_MENU_ITEM_SELECTOR)).find(
    (item) =>
      !item.hasAttribute('data-color') &&
      !item.hasAttribute('data-has-submenu') &&
      !item.classList.contains('sm:hidden') &&
      !item.classList.contains(MENU_BUTTON_CLASS),
  );
  if (!template) return null;

  const item = template.cloneNode(false) as HTMLElement;
  item.classList.add(className);
  for (const attribute of [
    'id',
    'data-testid',
    'data-state',
    'data-has-submenu',
    'aria-haspopup',
    'aria-expanded',
    'aria-controls',
    'aria-owns',
  ]) {
    item.removeAttribute(attribute);
  }
  item.setAttribute('role', 'menuitem');
  item.setAttribute('tabindex', '0');

  const nativeIconWrapper = template.querySelector('svg')?.parentElement;
  const iconWrapper = nativeIconWrapper
    ? (nativeIconWrapper.cloneNode(false) as HTMLElement)
    : document.createElement('span');
  iconWrapper.replaceChildren(buildDownloadIcon());
  const labelElement = document.createElement('span');
  labelElement.setAttribute('data-gv-menu-label', '1');
  labelElement.textContent = options.label;
  item.replaceChildren(iconWrapper, labelElement);
  updateCurrentMenuItem(item, options.label, options.tooltip);

  const activate = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    options.onClick();
    closeMenu(menu);
  };
  item.addEventListener('click', activate);
  item.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') activate(event);
  });
  return item;
}

function closeMenu(menu: HTMLElement): void {
  if (isLegacyMenu(menu)) {
    const backdrops = document.querySelectorAll<HTMLElement>('.cdk-overlay-backdrop');
    const backdrop = backdrops[backdrops.length - 1];
    if (backdrop) {
      backdrop.click();
      return;
    }
    menu.remove();
    return;
  }

  const trigger = resolveChatGptMenuTrigger(menu);
  const actionable = trigger?.matches('button')
    ? trigger
    : trigger?.querySelector<HTMLElement>('button, [role="button"]');
  if (actionable) {
    actionable.click();
    return;
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

function injectLegacyItem(
  menu: HTMLElement,
  className: string,
  excludedClassNames: string[],
  options: ConversationMenuExportOptions,
): HTMLButtonElement | null {
  const content = findMenuContent(menu);
  if (!content) return null;
  const existing = content.querySelector<HTMLButtonElement>(`.${className}`);
  if (existing) {
    updateMenuItemTemplateLabel(existing, options.label, options.tooltip);
    return existing;
  }
  const button = createMenuItemFromNativeTemplate({
    menuContent: content,
    injectedClassName: className,
    iconName: 'download',
    label: options.label,
    tooltip: options.tooltip,
    excludedClassNames,
  });
  if (!button) return null;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    options.onClick();
    closeMenu(menu);
  });
  return button;
}

function findLegacyMenuItemByIcon(content: HTMLElement, iconName: string): HTMLElement | null {
  return (
    Array.from(content.querySelectorAll<HTMLElement>('button.mat-mdc-menu-item')).find((button) => {
      const icon = button.querySelector('mat-icon');
      return (
        icon?.getAttribute('fonticon') === iconName ||
        icon?.getAttribute('data-mat-icon-name') === iconName ||
        icon?.textContent?.trim() === iconName
      );
    }) || null
  );
}

export function injectConversationMenuExportButton(
  menu: HTMLElement,
  options: ConversationMenuExportOptions,
): HTMLElement | null {
  if (!isConversationMenuPanel(menu)) return null;
  const content = findMenuContent(menu);
  if (!content) return null;
  const existing = content.querySelector<HTMLElement>(`.${MENU_BUTTON_CLASS}`);
  if (existing) {
    if (isLegacyMenu(menu)) {
      updateMenuItemTemplateLabel(existing as HTMLButtonElement, options.label, options.tooltip);
    } else updateCurrentMenuItem(existing, options.label, options.tooltip);
    return existing;
  }

  if (isLegacyMenu(menu)) {
    const button = injectLegacyItem(
      menu,
      MENU_BUTTON_CLASS,
      ['gv-move-to-folder-btn', RESPONSE_MENU_BUTTON_CLASS],
      options,
    );
    if (!button) return null;
    const pin = content.querySelector('[data-test-id="pin-button"]');
    if (pin?.parentElement === content) pin.after(button);
    else content.prepend(button);
    return button;
  }

  const item = createCurrentMenuItem(menu, MENU_BUTTON_CLASS, options);
  if (!item) return null;
  const deleteItem = content.querySelector('[data-testid="delete-chat-menu-item"]');
  if (deleteItem?.parentElement) deleteItem.parentElement.insertBefore(item, deleteItem);
  else content.appendChild(item);
  return item;
}

export function injectResponseMenuExportButton(
  menu: HTMLElement,
  options: ConversationMenuExportOptions,
): HTMLElement | null {
  if (!isResponseMenuPanel(menu)) return null;
  const content = findMenuContent(menu);
  if (!content) return null;
  const existing = content.querySelector<HTMLElement>(`.${RESPONSE_MENU_BUTTON_CLASS}`);
  if (existing) {
    if (isLegacyMenu(menu)) {
      updateMenuItemTemplateLabel(existing as HTMLButtonElement, options.label, options.tooltip);
    } else updateCurrentMenuItem(existing, options.label, options.tooltip);
    return existing;
  }

  if (isLegacyMenu(menu)) {
    const button = injectLegacyItem(
      menu,
      RESPONSE_MENU_BUTTON_CLASS,
      [MENU_BUTTON_CLASS, 'gv-move-to-folder-btn'],
      options,
    );
    if (!button) return null;
    const docs = findLegacyMenuItemByIcon(content, 'docs');
    if (docs?.parentElement === content) docs.after(button);
    else content.appendChild(button);
    return button;
  }

  const item = createCurrentMenuItem(menu, RESPONSE_MENU_BUTTON_CLASS, options);
  if (!item) return null;
  content.appendChild(item);
  return item;
}
