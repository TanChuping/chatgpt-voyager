const DEFAULT_CHATGPT_ORIGIN = 'https://chatgpt.com';
const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);

const LOCALE_SEGMENT = '[a-z]{2}(?:-[a-z]{2})?';
const SAFE_ROUTE_SEGMENT = '[a-z0-9_-]{1,256}';
const CONVERSATION_PATH = new RegExp(
  `^/(?:${LOCALE_SEGMENT}/)?(?:(?:u/\\d{1,20}|g/${SAFE_ROUTE_SEGMENT})/)?c/(${SAFE_ROUTE_SEGMENT})/?$`,
  'i',
);

export interface SafeFolderConversationUrl {
  conversationId: string;
  url: string;
}

function resolveExpectedOrigin(explicitOrigin?: string): string | null {
  const candidate = explicitOrigin || globalThis.location?.origin || DEFAULT_CHATGPT_ORIGIN;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || !CHATGPT_HOSTS.has(parsed.hostname.toLowerCase())) {
      return explicitOrigin ? null : DEFAULT_CHATGPT_ORIGIN;
    }
    return parsed.origin;
  } catch {
    return explicitOrigin ? null : DEFAULT_CHATGPT_ORIGIN;
  }
}

/**
 * Accept only a same-origin ChatGPT conversation route. Query strings and
 * fragments are intentionally removed so imported data cannot smuggle a
 * second navigation target or tracking material into a stored link.
 */
export function sanitizeFolderConversationUrl(
  input: unknown,
  explicitOrigin?: string,
): SafeFolderConversationUrl | null {
  if (typeof input !== 'string' || !input.trim()) return null;

  const expectedOrigin = resolveExpectedOrigin(explicitOrigin);
  if (!expectedOrigin) return null;

  try {
    const parsed = new URL(input, `${expectedOrigin}/`);
    if (
      parsed.protocol !== 'https:' ||
      !CHATGPT_HOSTS.has(parsed.hostname.toLowerCase()) ||
      parsed.port !== '' ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }

    const match = parsed.pathname.match(CONVERSATION_PATH);
    const conversationId = match?.[1];
    if (!conversationId) return null;

    const normalizedPath = parsed.pathname.replace(/\/$/, '');
    return {
      conversationId,
      url: `${expectedOrigin}${normalizedPath}`,
    };
  } catch {
    return null;
  }
}
