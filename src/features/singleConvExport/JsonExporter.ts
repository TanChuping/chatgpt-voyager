/**
 * Conversation walking + export pipeline.
 * Mapping-walk strategy adapted from pionxzh/chatgpt-exporter (MIT).
 * https://github.com/pionxzh/chatgpt-exporter
 */
import type { LinearConversation } from '../conversationApi/types';

export function toJson(linear: LinearConversation): string {
  return JSON.stringify(linear, null, 2) + '\n';
}
