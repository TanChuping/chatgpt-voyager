import type { StarredMessagesData } from '@/pages/content/timeline/starredTypes';

import type { FolderData } from './folder';

export interface PromptItem {
  id: string;
  text: string;
  tags: string[];
  createdAt: number;
  updatedAt?: number;
}

export interface SyncAccountScope {
  accountKey?: string;
  accountId?: string;
  routeUserId?: string;
  email?: string;
}

export interface FolderExportPayload {
  format: 'gpt-voyager.folders.v1';
  exportedAt: string;
  version: string;
  data: FolderData;
}

export interface PromptExportPayload {
  format: 'gpt-voyager.prompts.v1';
  exportedAt: string;
  version?: string;
  items: PromptItem[];
}

export interface SettingsExportPayload {
  format: 'gpt-voyager.settings.v1';
  exportedAt: string;
  version?: string;
  data: Record<string, unknown>;
}

export interface StarredExportPayload {
  format: 'gpt-voyager.starred.v1';
  exportedAt: string;
  version?: string;
  data: StarredMessagesData;
}

export type {
  StarredMessage as StarredMessageSync,
  StarredMessagesData as StarredMessagesDataSync,
} from '@/pages/content/timeline/starredTypes';

export type {
  ForkNode as ForkNodeSync,
  ForkNodesData as ForkNodesDataSync,
} from '@/pages/content/fork/forkTypes';

export type {
  TimelineHierarchyConversationData as TimelineHierarchyConversationDataSync,
  TimelineHierarchyData as TimelineHierarchyDataSync,
} from '@/pages/content/timeline/hierarchyTypes';

export interface ForkExportPayload {
  format: 'gpt-voyager.forks.v1';
  exportedAt: string;
  version?: string;
  data: import('@/pages/content/fork/forkTypes').ForkNodesData;
}

export interface TimelineHierarchyExportPayload {
  format: 'gpt-voyager.timeline-hierarchy.v1';
  exportedAt: string;
  version?: string;
  data: import('@/pages/content/timeline/hierarchyTypes').TimelineHierarchyData;
}
