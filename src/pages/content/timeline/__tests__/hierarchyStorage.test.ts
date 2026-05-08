import { describe, expect, it } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { TimelineHierarchyData } from '@/pages/content/timeline/hierarchyTypes';

import {
  filterTimelineHierarchyByRouteScope,
  getTimelineHierarchyStorageKey,
  getTimelineHierarchyStorageKeysToRead,
  resolveTimelineHierarchyDataForStorageScope,
} from '../hierarchyStorage';

describe('timeline hierarchy storage helpers', () => {
  it('uses a single local timeline hierarchy key', () => {
    expect(getTimelineHierarchyStorageKey()).toBe(StorageKeys.TIMELINE_HIERARCHY);
    expect(getTimelineHierarchyStorageKeysToRead()).toEqual([StorageKeys.TIMELINE_HIERARCHY]);
  });

  it('resolves hierarchy data from local storage only', () => {
    const data: TimelineHierarchyData = {
      conversations: {
        'chatgpt:conv:test': {
          conversationUrl: 'https://chatgpt.com/c/test',
          levels: { 'turn-1': 2 },
          collapsed: [],
          updatedAt: 1,
        },
      },
    };

    expect(
      resolveTimelineHierarchyDataForStorageScope({
        [StorageKeys.TIMELINE_HIERARCHY]: data,
      }),
    ).toEqual(data);
  });

  it('does not filter by account route scope', () => {
    const data: TimelineHierarchyData = {
      conversations: {
        'chatgpt:conv:test': {
          conversationUrl: 'https://chatgpt.com/c/test',
          levels: { 'turn-1': 2 },
          collapsed: [],
          updatedAt: 1,
        },
      },
    };

    expect(filterTimelineHierarchyByRouteScope(data)).toEqual(data);
  });
});