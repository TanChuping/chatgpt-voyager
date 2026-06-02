/* Background service worker for GPT-Voyager. */
import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';
import { isFirefox } from '@/core/utils/browser';
import type { ForkNode, ForkNodesData } from '@/pages/content/fork/forkTypes';
import type { StarredMessage, StarredMessagesData } from '@/pages/content/timeline/starredTypes';

const CUSTOM_CONTENT_SCRIPT_ID = 'gv-custom-content-script';
const CUSTOM_WEBSITE_KEY = StorageKeys.PROMPT_CUSTOM_WEBSITES;

function isStarredMessagesData(value: unknown): value is StarredMessagesData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as { messages?: unknown };
  if (typeof data.messages !== 'object' || data.messages === null) return false;
  const messages = data.messages as Record<string, unknown>;
  return Object.values(messages).every((v) => Array.isArray(v));
}

function isForkNodesData(value: unknown): value is ForkNodesData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as { nodes?: unknown; groups?: unknown };
  return (
    typeof data.nodes === 'object' &&
    data.nodes !== null &&
    typeof data.groups === 'object' &&
    data.groups !== null
  );
}

function patternToDomain(pattern: string | undefined): string | null {
  if (!pattern) return null;
  try {
    const withoutScheme = pattern.replace(/^[^:]+:\/\//, '');
    const hostPart = withoutScheme.replace(/\/.*$/, '').replace(/^\*\./, '');
    return hostPart || null;
  } catch {
    return null;
  }
}

const MANIFEST_DEFAULT_DOMAINS = new Set(
  [
    ...(chrome.runtime.getManifest().host_permissions || []),
    ...(chrome.runtime.getManifest().content_scripts?.flatMap((c) => c.matches || []) || []),
  ]
    .map(patternToDomain)
    .filter((d): d is string => !!d),
);

function toMatchPatterns(domain: string): string[] {
  const normalized = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/^\*\./, '');

  if (!normalized) return [];
  return [`https://*.${normalized}/*`, `http://*.${normalized}/*`];
}

function toRelativeExtensionPath(resource: string): string {
  try {
    const url = new URL(resource);
    if (url.protocol === 'moz-extension:') {
      return url.pathname.replace(/^\/+/, '');
    }
  } catch {
    // Not an absolute extension URL; fall through.
  }

  return resource.replace(/^\/+/, '');
}

function extractDomainsFromOrigins(origins?: string[]): string[] {
  if (!Array.isArray(origins)) return [];
  const domains = origins
    .map(patternToDomain)
    .filter((d): d is string => !!d)
    .filter((d) => !MANIFEST_DEFAULT_DOMAINS.has(d));
  return Array.from(new Set(domains));
}

async function filterGrantedOrigins(patterns: string[]): Promise<string[]> {
  const granted: string[] = [];

  for (const origin of patterns) {
    try {
      const hasPermission = await browser.permissions.contains({ origins: [origin] });
      if (hasPermission) granted.push(origin);
    } catch (error) {
      console.warn('[Background] Failed to check permission for', origin, error);
    }
  }

  return granted;
}

async function syncCustomContentScripts(domains?: string[]): Promise<void> {
  if (!chrome.scripting?.registerContentScripts) return;

  const manifestContentScript = chrome.runtime.getManifest().content_scripts?.[0];
  if (!manifestContentScript) return;

  const domainList =
    domains ??
    (
      await chrome.storage.sync.get({
        [CUSTOM_WEBSITE_KEY]: [],
      })
    )[CUSTOM_WEBSITE_KEY];

  const matchPatterns = Array.from(
    new Set((Array.isArray(domainList) ? domainList : []).flatMap(toMatchPatterns).filter(Boolean)),
  );
  const grantedMatches = await filterGrantedOrigins(matchPatterns);

  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CUSTOM_CONTENT_SCRIPT_ID] });
  } catch {
    // No-op if script was not registered.
  }

  if (!grantedMatches.length) return;

  const runAt =
    manifestContentScript.run_at === 'document_start'
      ? 'document_start'
      : manifestContentScript.run_at === 'document_end'
        ? 'document_end'
        : 'document_idle';

  const jsResources = isFirefox()
    ? (manifestContentScript.js || []).map(toRelativeExtensionPath)
    : manifestContentScript.js || [];
  const cssResources = isFirefox()
    ? manifestContentScript.css?.map(toRelativeExtensionPath)
    : manifestContentScript.css;

  try {
    await chrome.scripting.registerContentScripts([
      {
        id: CUSTOM_CONTENT_SCRIPT_ID,
        js: jsResources,
        css: cssResources,
        matches: grantedMatches,
        allFrames: manifestContentScript.all_frames,
        runAt,
        persistAcrossSessions: true,
      },
    ]);
  } catch (error) {
    console.error('[Background] Failed to register custom content scripts:', error);
  }
}

void syncCustomContentScripts();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  if (Object.prototype.hasOwnProperty.call(changes, CUSTOM_WEBSITE_KEY)) {
    const newValue = changes[CUSTOM_WEBSITE_KEY]?.newValue;
    const domains = Array.isArray(newValue) ? newValue : [];
    void syncCustomContentScripts(domains);
  }
});

chrome.permissions.onAdded.addListener(({ origins }) => {
  const domains = extractDomainsFromOrigins(origins);
  if (domains.length) {
    void browser.storage.sync
      .get({ [CUSTOM_WEBSITE_KEY]: [] })
      .then((current) => {
        const existing = Array.isArray(current[CUSTOM_WEBSITE_KEY])
          ? current[CUSTOM_WEBSITE_KEY]
          : [];
        const merged = Array.from(new Set([...existing, ...domains]));
        if (merged.length !== existing.length) {
          return browser.storage.sync.set({ [CUSTOM_WEBSITE_KEY]: merged });
        }
      })
      .catch((error) => {
        console.warn('[Background] Failed to persist domains from permissions.onAdded:', error);
      });
  }

  void syncCustomContentScripts();
});

chrome.permissions.onRemoved.addListener(() => {
  void syncCustomContentScripts();
});

class StarredMessagesManager {
  private operationQueue: Promise<unknown> = Promise.resolve();

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const promise = this.operationQueue.then(operation, operation);
    this.operationQueue = promise.catch(() => {});
    return promise;
  }

  private async getFromStorage(): Promise<StarredMessagesData> {
    try {
      const result = await chrome.storage.local.get([StorageKeys.TIMELINE_STARRED_MESSAGES]);
      const starred = result[StorageKeys.TIMELINE_STARRED_MESSAGES];
      return isStarredMessagesData(starred) ? starred : { messages: {} };
    } catch (error) {
      console.error('[Background] Failed to get starred messages:', error);
      return { messages: {} };
    }
  }

  private async saveToStorage(data: StarredMessagesData): Promise<void> {
    await chrome.storage.local.set({ [StorageKeys.TIMELINE_STARRED_MESSAGES]: data });
  }

  async addStarredMessage(message: StarredMessage): Promise<boolean> {
    return this.serialize(async () => {
      const data = await this.getFromStorage();
      if (!data.messages[message.conversationId]) data.messages[message.conversationId] = [];

      const exists = data.messages[message.conversationId].some((m) => m.turnId === message.turnId);
      if (exists) return false;

      const MAX_CONTENT_LENGTH = 60;
      const truncatedMessage: StarredMessage = {
        ...message,
        content:
          message.content.length > MAX_CONTENT_LENGTH
            ? `${message.content.slice(0, MAX_CONTENT_LENGTH)}...`
            : message.content,
      };
      data.messages[message.conversationId].push(truncatedMessage);
      await this.saveToStorage(data);
      return true;
    });
  }

  async removeStarredMessage(conversationId: string, turnId: string): Promise<boolean> {
    return this.serialize(async () => {
      const data = await this.getFromStorage();
      if (!data.messages[conversationId]) return false;

      const initialLength = data.messages[conversationId].length;
      data.messages[conversationId] = data.messages[conversationId].filter(
        (m) => m.turnId !== turnId,
      );

      if (data.messages[conversationId].length === initialLength) return false;
      if (data.messages[conversationId].length === 0) delete data.messages[conversationId];

      await this.saveToStorage(data);
      return true;
    });
  }

  async getAllStarredMessages(): Promise<StarredMessagesData> {
    return this.getFromStorage();
  }

  async getStarredMessagesForConversation(conversationId: string): Promise<StarredMessage[]> {
    const data = await this.getFromStorage();
    return data.messages[conversationId] || [];
  }

  async isMessageStarred(conversationId: string, turnId: string): Promise<boolean> {
    const messages = await this.getStarredMessagesForConversation(conversationId);
    return messages.some((m) => m.turnId === turnId);
  }

  async reconcileConversationIds(
    targetConversationId: string,
    sourceConversationIds: string[],
    conversationUrl?: string,
  ): Promise<StarredMessage[]> {
    return this.serialize(async () => {
      const data = await this.getFromStorage();
      const uniqueConversationIds = Array.from(
        new Set([targetConversationId, ...sourceConversationIds]),
      ).filter(Boolean);
      const mergedMessages = new Map<string, StarredMessage>();

      for (const conversationId of uniqueConversationIds) {
        const messages = data.messages[conversationId] || [];
        for (const message of messages) {
          const normalizedMessage: StarredMessage = {
            ...message,
            conversationId: targetConversationId,
            conversationUrl: conversationUrl || message.conversationUrl,
          };
          const existing = mergedMessages.get(message.turnId);
          if (!existing || normalizedMessage.starredAt >= existing.starredAt) {
            mergedMessages.set(message.turnId, normalizedMessage);
          }
        }
      }

      if (mergedMessages.size > 0) {
        data.messages[targetConversationId] = Array.from(mergedMessages.values());
      } else {
        delete data.messages[targetConversationId];
      }

      for (const conversationId of uniqueConversationIds) {
        if (conversationId !== targetConversationId) delete data.messages[conversationId];
      }

      await this.saveToStorage(data);
      return data.messages[targetConversationId] || [];
    });
  }
}

class ForkNodesManager {
  private operationQueue: Promise<unknown> = Promise.resolve();

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const promise = this.operationQueue.then(operation, operation);
    this.operationQueue = promise.catch(() => {});
    return promise;
  }

  private async getFromStorage(): Promise<ForkNodesData> {
    try {
      const result = await chrome.storage.local.get([StorageKeys.FORK_NODES]);
      const forkNodes = result[StorageKeys.FORK_NODES];
      return isForkNodesData(forkNodes) ? forkNodes : { nodes: {}, groups: {} };
    } catch (error) {
      console.error('[Background] Failed to get fork nodes:', error);
      return { nodes: {}, groups: {} };
    }
  }

  private async saveToStorage(data: ForkNodesData): Promise<void> {
    await chrome.storage.local.set({ [StorageKeys.FORK_NODES]: data });
  }

  async addForkNode(node: ForkNode): Promise<boolean> {
    return this.serialize(async () => {
      const data = await this.getFromStorage();
      if (!data.nodes[node.conversationId]) data.nodes[node.conversationId] = [];

      const exists = data.nodes[node.conversationId].some(
        (n) => n.turnId === node.turnId && n.forkGroupId === node.forkGroupId,
      );
      if (exists) return false;

      data.nodes[node.conversationId].push(node);
      if (!data.groups[node.forkGroupId]) data.groups[node.forkGroupId] = [];
      const groupKey = `${node.conversationId}:${node.turnId}`;
      if (!data.groups[node.forkGroupId].includes(groupKey)) {
        data.groups[node.forkGroupId].push(groupKey);
      }

      await this.saveToStorage(data);
      return true;
    });
  }

  async removeForkNode(
    conversationId: string,
    turnId: string,
    forkGroupId: string,
  ): Promise<boolean> {
    return this.serialize(async () => {
      const data = await this.getFromStorage();
      if (!data.nodes[conversationId]) return false;

      const initialLength = data.nodes[conversationId].length;
      data.nodes[conversationId] = data.nodes[conversationId].filter(
        (n) => !(n.turnId === turnId && n.forkGroupId === forkGroupId),
      );

      if (data.nodes[conversationId].length === initialLength) return false;
      if (data.nodes[conversationId].length === 0) delete data.nodes[conversationId];

      if (data.groups[forkGroupId]) {
        const groupKey = `${conversationId}:${turnId}`;
        data.groups[forkGroupId] = data.groups[forkGroupId].filter((k) => k !== groupKey);
        if (data.groups[forkGroupId].length === 0) delete data.groups[forkGroupId];
      }

      await this.saveToStorage(data);
      return true;
    });
  }

  async getAllForkNodes(): Promise<ForkNodesData> {
    return this.getFromStorage();
  }

  async getForConversation(conversationId: string): Promise<ForkNode[]> {
    const data = await this.getFromStorage();
    return data.nodes[conversationId] || [];
  }

  async getGroup(forkGroupId: string): Promise<ForkNode[]> {
    const data = await this.getFromStorage();
    const groupKeys = data.groups[forkGroupId] || [];
    const nodes: ForkNode[] = [];

    for (const key of groupKeys) {
      const [conversationId, turnId] = key.split(':');
      const conversationNodes = data.nodes[conversationId] || [];
      const match = conversationNodes.find(
        (node) => node.turnId === turnId && node.forkGroupId === forkGroupId,
      );
      if (match) nodes.push(match);
    }

    return nodes.sort((a, b) => a.forkIndex - b.forkIndex);
  }
}

const starredMessagesManager = new StarredMessagesManager();
const forkNodesManager = new ForkNodesManager();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message && message.type && message.type.startsWith('gv.starred.')) {
        switch (message.type) {
          case 'gv.starred.add':
            sendResponse({
              ok: true,
              added: await starredMessagesManager.addStarredMessage(message.payload),
            });
            return;
          case 'gv.starred.remove':
            sendResponse({
              ok: true,
              removed: await starredMessagesManager.removeStarredMessage(
                message.payload.conversationId,
                message.payload.turnId,
              ),
            });
            return;
          case 'gv.starred.getAll':
            sendResponse({ ok: true, data: await starredMessagesManager.getAllStarredMessages() });
            return;
          case 'gv.starred.getForConversation':
            sendResponse({
              ok: true,
              messages: await starredMessagesManager.getStarredMessagesForConversation(
                message.payload.conversationId,
              ),
            });
            return;
          case 'gv.starred.isStarred':
            sendResponse({
              ok: true,
              isStarred: await starredMessagesManager.isMessageStarred(
                message.payload.conversationId,
                message.payload.turnId,
              ),
            });
            return;
          case 'gv.starred.reconcileConversationIds':
            sendResponse({
              ok: true,
              messages: await starredMessagesManager.reconcileConversationIds(
                message.payload.targetConversationId,
                Array.isArray(message.payload.sourceConversationIds)
                  ? message.payload.sourceConversationIds
                  : [],
                typeof message.payload.conversationUrl === 'string'
                  ? message.payload.conversationUrl
                  : undefined,
              ),
            });
            return;
        }
      }

      if (message && message.type && message.type.startsWith('gv.fork.')) {
        switch (message.type) {
          case 'gv.fork.add':
            sendResponse({
              ok: true,
              added: await forkNodesManager.addForkNode(message.payload),
            });
            return;
          case 'gv.fork.remove':
            sendResponse({
              ok: true,
              removed: await forkNodesManager.removeForkNode(
                message.payload.conversationId,
                message.payload.turnId,
                message.payload.forkGroupId,
              ),
            });
            return;
          case 'gv.fork.getAll':
            sendResponse({ ok: true, data: await forkNodesManager.getAllForkNodes() });
            return;
          case 'gv.fork.getForConversation':
            sendResponse({
              ok: true,
              nodes: await forkNodesManager.getForConversation(message.payload.conversationId),
            });
            return;
          case 'gv.fork.getGroup':
            sendResponse({
              ok: true,
              nodes: await forkNodesManager.getGroup(message.payload.forkGroupId),
            });
            return;
        }
      }

      if (message?.type === 'gv.openPopup') {
        try {
          await chrome.action.openPopup();
          sendResponse({ ok: true });
        } catch (error) {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (message?.type === 'gv.fetchImageViaPage') {
        const url = String(message.url || '');
        const tabId = sender?.tab?.id;
        if (!tabId || !/^https?:\/\//i.test(url) || !chrome.scripting?.executeScript) {
          sendResponse({ ok: false, error: 'invalid' });
          return;
        }

        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN' as chrome.scripting.ExecutionWorld,
            func: async (imageUrl: string) => {
              const safeFetch = async (credentials: RequestCredentials) => {
                try {
                  const response = await fetch(imageUrl, { credentials });
                  if (response.ok) return await response.blob();
                } catch {
                  // Try the next credential mode.
                }
                return null;
              };

              const blob = (await safeFetch('include')) || (await safeFetch('omit'));
              if (!blob) return null;

              return new Promise<{ contentType: string; base64: string } | null>((resolve) => {
                const reader = new FileReader();
                reader.onload = () => {
                  const dataUrl = String(reader.result || '');
                  const commaIdx = dataUrl.indexOf(',');
                  if (commaIdx < 0) {
                    resolve(null);
                    return;
                  }
                  resolve({
                    contentType: blob.type || 'application/octet-stream',
                    base64: dataUrl.substring(commaIdx + 1),
                  });
                };
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
              });
            },
            args: [url],
          });
          const result = results?.[0]?.result as { contentType: string; base64: string } | null;
          if (result?.base64) {
            sendResponse({
              ok: true,
              contentType: result.contentType,
              base64: result.base64,
              data: `data:${result.contentType};base64,${result.base64}`,
            });
          } else {
            sendResponse({ ok: false, error: 'page_fetch_failed' });
          }
        } catch (error) {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (message?.type === 'gv.fetchImage') {
        const url = String(message.url || '');
        if (!/^https?:\/\//i.test(url)) {
          sendResponse({ ok: false, error: 'invalid_url' });
          return;
        }

        try {
          const response = await fetch(url, { credentials: 'include', redirect: 'follow' }).catch(
            () => fetch(url, { credentials: 'omit', redirect: 'follow' }),
          );
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const blob = await response.blob();
          const ab = await blob.arrayBuffer();
          const b64 = arrayBufferToBase64(ab);
          const contentType = blob.type || 'image/png';
          sendResponse({
            ok: true,
            data: `data:${contentType};base64,${b64}`,
            contentType,
            base64: b64,
          });
        } catch (error) {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
  return true;
});

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
