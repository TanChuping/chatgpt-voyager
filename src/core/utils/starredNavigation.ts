const MESSAGE_UUID = /^(?:u-)?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;

/**
 * Ask ChatGPT to load the target message before our timeline scrolls to it.
 * A fragment alone is invisible to ChatGPT's conversation loader: it opens
 * only the latest page, leaving old favorites and intervening turns absent.
 * Preserve the Voyager fragment for our final positioning and legacy IDs.
 */
export function buildStarredMessageUrl(conversationUrl: string, turnId: string): string {
  const url = new URL(conversationUrl, 'https://chatgpt.com');
  const messageId = MESSAGE_UUID.exec(turnId)?.[1];
  url.searchParams.delete('messageId');
  if (
    messageId &&
    ['chatgpt.com', 'chat.openai.com'].includes(url.hostname) &&
    /\/c\/[^/]+\/?$/.test(url.pathname)
  ) {
    url.searchParams.set('messageId', messageId);
  }
  url.hash = `gv-turn-${turnId}`;
  return url.href;
}
