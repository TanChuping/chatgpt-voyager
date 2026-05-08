export interface AccountScope {
  accountKey: string;
  accountId?: string;
  routeUserId?: string;
  email?: string;
}

export interface AccountContext {
  routeUserId?: string;
  email?: string;
}

export function detectAccountContextFromDocument(_pageUrl?: string, _doc?: Document): AccountContext {
  return {};
}

export function extractRouteUserIdFromPath(pathname: string): string | null {
  return pathname.match(/^\/u\/(\d+)(?=\/)/)?.[1] ?? null;
}

export function buildScopedFolderStorageKey(_accountKey?: string): string {
  return 'gvFolderData';
}

export const accountIsolationService = {
  async isIsolationEnabled(_options?: unknown): Promise<boolean> {
    return false;
  },

  async resolveAccountScope(_options?: unknown): Promise<AccountScope> {
    return { accountKey: 'local' };
  },
};
