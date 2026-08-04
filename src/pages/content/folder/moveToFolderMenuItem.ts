import { createMenuItemFromNativeTemplate } from '../shared/nativeMenuItemTemplate';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function createFolderIcon(): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className =
    'relative flex items-center justify-center [opacity:var(--menu-item-icon-opacity,1)] icon';
  wrapper.setAttribute('aria-hidden', 'true');

  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(SVG_NAMESPACE, 'path');
  path.setAttribute(
    'd',
    'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  );
  svg.appendChild(path);
  wrapper.appendChild(svg);
  return wrapper;
}

function makeKeyboardActivatable(menuItem: HTMLElement): void {
  menuItem.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    menuItem.click();
  });
}

function createRadixMenuItem(
  menuContent: HTMLElement,
  label: string,
  tooltip: string,
): HTMLElement | null {
  const template = Array.from(menuContent.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => !item.classList.contains('gv-move-to-folder-btn'),
  );
  if (!template) return null;

  const menuItem = template.cloneNode(false) as HTMLElement;
  for (const attribute of Array.from(menuItem.attributes)) {
    if (
      attribute.name === 'id' ||
      attribute.name === 'data-testid' ||
      attribute.name.startsWith('data-radix-') ||
      attribute.name.startsWith('aria-')
    ) {
      menuItem.removeAttribute(attribute.name);
    }
  }

  menuItem.classList.add('gv-move-to-folder-btn');
  menuItem.setAttribute('role', 'menuitem');
  menuItem.setAttribute('tabindex', '0');
  menuItem.setAttribute('aria-disabled', 'false');
  menuItem.setAttribute('aria-label', tooltip || label);
  menuItem.title = tooltip || label;
  menuItem.replaceChildren(createFolderIcon(), document.createTextNode(label));
  makeKeyboardActivatable(menuItem);
  return menuItem;
}

function createMoveToFolderMenuItemFallback(label: string, tooltip: string): HTMLElement {
  const menuItem = document.createElement('div');
  menuItem.className = 'group __menu-item gap-1.5 gv-move-to-folder-btn';
  menuItem.setAttribute('role', 'menuitem');
  menuItem.setAttribute('tabindex', '0');
  menuItem.setAttribute('aria-disabled', 'false');
  menuItem.setAttribute('aria-label', tooltip || label);
  menuItem.title = tooltip || label;
  menuItem.append(createFolderIcon(), document.createTextNode(label));
  makeKeyboardActivatable(menuItem);
  return menuItem;
}

function createLegacyMaterialMenuItem(
  menuContent: HTMLElement,
  label: string,
  tooltip: string,
): HTMLButtonElement | null {
  const menuItem = createMenuItemFromNativeTemplate({
    menuContent,
    injectedClassName: 'gv-move-to-folder-btn',
    iconName: 'folder_open',
    label,
    tooltip,
    excludedClassNames: ['gv-export-conversation-menu-btn'],
  });
  if (menuItem) return menuItem;

  if (!menuContent.matches('.mat-mdc-menu-content')) return null;

  const fallback = document.createElement('button');
  fallback.className = 'mat-mdc-menu-item mat-focus-indicator gv-move-to-folder-btn';
  fallback.setAttribute('role', 'menuitem');
  fallback.setAttribute('tabindex', '0');
  fallback.setAttribute('aria-disabled', 'false');

  const icon = document.createElement('mat-icon');
  icon.className =
    'mat-icon notranslate gds-icon-l google-symbols mat-ligature-font mat-icon-no-color';
  icon.setAttribute('role', 'img');
  icon.setAttribute('fonticon', 'folder_open');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = 'folder_open';

  const textSpan = document.createElement('span');
  textSpan.className = 'mat-mdc-menu-item-text';
  const innerSpan = document.createElement('span');
  innerSpan.className = 'gds-body-m';
  innerSpan.textContent = label;
  textSpan.appendChild(innerSpan);

  const ripple = document.createElement('div');
  ripple.className = 'mat-ripple mat-mdc-menu-ripple';
  ripple.setAttribute('matripple', '');

  fallback.appendChild(icon);
  fallback.appendChild(textSpan);
  fallback.appendChild(ripple);
  return fallback;
}

export function createMoveToFolderMenuItem(
  menuContent: HTMLElement,
  label: string,
  tooltip: string,
): HTMLElement {
  return (
    createRadixMenuItem(menuContent, label, tooltip) ??
    createLegacyMaterialMenuItem(menuContent, label, tooltip) ??
    createMoveToFolderMenuItemFallback(label, tooltip)
  );
}
