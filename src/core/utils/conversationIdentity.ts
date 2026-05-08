import { hashString } from './hash';

const DEFAULT_BASE_URL = 'https://chatgpt.com';

function getBaseUrl(): string {
  try {
    return globalThis.location?.origin || DEFAULT_BASE_URL;
  } catch {
    return DEFAULT_BASE_URL;
  }
}

function parseUrl(input: string): URL | null {
  try {
    return new URL(input, getBaseUrl());
  } catch {
    return null;
  }
}

function normalizePathname(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed) return '/';

  const normalized = trimmed.replace(/\/+$/, '');
  return normalized || '/';
}

function stripLocalePrefix(pathname: string): string {
  return pathname.replace(/^\/[a-z]{2}(?:-[A-Z]{2})?(?=\/)/, '');
}

export function extractConversationIdFromUrl(input: string): string | null {
  const parsed = parseUrl(input);
  const pathname = parsed ? parsed.pathname : String(input || '');
  const normalizedPath = stripLocalePrefix(normalizePathname(pathname));

  const chatMatch = normalizedPath.match(/(?:^|\/)c\/([^/?#]+)/);
  if (chatMatch?.[1]) return chatMatch[1];

  const shareMatch = normalizedPath.match(/^\/share\/([^/?#]+)/);
  return shareMatch?.[1] || null;
}

export function normalizeConversationUrl(input: string): string {
  const parsed = parseUrl(input);
  if (!parsed) {
    const raw = stripLocalePrefix(
      String(input || '')
        .split('#')[0]
        .split('?')[0]
        .trim(),
    );
    return raw || '/';
  }

  return `${parsed.origin}${stripLocalePrefix(normalizePathname(parsed.pathname))}`;
}

export function isSameConversationRoute(left: string, right: string): boolean {
  return normalizeConversationUrl(left) === normalizeConversationUrl(right);
}

export function buildRouteConversationIdFromUrl(input: string): string {
  const parsed = parseUrl(input);
  if (!parsed) {
    return `gpt:${hashString(normalizeConversationUrl(input))}`;
  }

  return `gpt:${hashString(`${parsed.host}${normalizeConversationUrl(input)}`)}`;
}

export function buildConversationIdFromUrl(input: string): string {
  const conversationId = extractConversationIdFromUrl(input);
  if (conversationId) {
    return `gpt:conv:${conversationId}`;
  }

  return buildRouteConversationIdFromUrl(input);
}

export function buildLegacyConversationIdFromUrl(input: string): string {
  const parsed = parseUrl(input);
  if (!parsed) {
    return `gpt:${hashString(String(input || ''))}`;
  }

  return `gpt:${hashString(`${parsed.host}${parsed.pathname}${parsed.search}`)}`;
}