import type { IconNode } from 'lucide-react';

import { createLucideIcon } from './lucideIcon';

const CHEVRON_DOWN = [['path', { d: 'm6 9 6 6 6-6', key: 'down' }]] satisfies IconNode;
const CHEVRON_RIGHT = [['path', { d: 'm9 18 6-6-6-6', key: 'right' }]] satisfies IconNode;
const FOLDER = [
  [
    'path',
    {
      d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
      key: 'folder',
    },
  ],
] satisfies IconNode;
const PLUS = [
  ['path', { d: 'M5 12h14', key: 'horizontal' }],
  ['path', { d: 'M12 5v14', key: 'vertical' }],
] satisfies IconNode;
const SETTINGS = [
  [
    'path',
    {
      d: 'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915',
      key: 'gear',
    },
  ],
  ['circle', { cx: '12', cy: '12', r: '3', key: 'center' }],
] satisfies IconNode;
const EYE = [
  ['path', { d: 'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0', key: 'outline' }],
  ['circle', { cx: '12', cy: '12', r: '3', key: 'pupil' }],
] satisfies IconNode;
const EYE_OFF = [
  ['path', { d: 'M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.8 10.8 0 0 1-1.444 2.49', key: 'eye-a' }],
  ['path', { d: 'M14.084 14.158a3 3 0 0 1-4.242-4.242', key: 'eye-b' }],
  ['path', { d: 'M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143', key: 'eye-c' }],
  ['path', { d: 'm2 2 20 20', key: 'slash' }],
] satisfies IconNode;

export const createChevronDownIcon = (size = 16) =>
  createLucideIcon('chevron-down', CHEVRON_DOWN, size);
export const createChevronRightIcon = (size = 16) =>
  createLucideIcon('chevron-right', CHEVRON_RIGHT, size);
export const createFolderIcon = (size = 16) => createLucideIcon('folder', FOLDER, size);
export const createPlusIcon = (size = 16) => createLucideIcon('plus', PLUS, size);
export const createSettingsIcon = (size = 16) => createLucideIcon('settings', SETTINGS, size);
export const createEyeIcon = (size = 16) => createLucideIcon('eye', EYE, size);
export const createEyeOffIcon = (size = 16) => createLucideIcon('eye-off', EYE_OFF, size);
