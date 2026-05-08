import { StorageKeys } from '@/core/types/common';

import { type TimelineHierarchyData, normalizeTimelineHierarchyData } from './hierarchyTypes';

export function getTimelineHierarchyStorageKey(_accountKey?: string): string {
  return StorageKeys.TIMELINE_HIERARCHY;
}

export function getTimelineHierarchyStorageKeysToRead(_accountKey?: string): string[] {
  return [StorageKeys.TIMELINE_HIERARCHY];
}

export function filterTimelineHierarchyByRouteScope(
  data: TimelineHierarchyData,
): TimelineHierarchyData {
  return data;
}

export function resolveTimelineHierarchyDataForStorageScope(
  values: Record<string, unknown>,
  _accountKey?: string,
  _routeUserId?: string | null,
): TimelineHierarchyData {
  return normalizeTimelineHierarchyData(values[StorageKeys.TIMELINE_HIERARCHY]);
}
