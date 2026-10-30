import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { ChevronLeft, Star, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { buildStarredMessageUrl } from '@/core/utils/starredNavigation';
import { StarredMessagesService } from '@/pages/content/timeline/StarredMessagesService';
import type { StarredMessage } from '@/pages/content/timeline/starredTypes';

interface StarredHistoryProps {
  onClose: () => void;
}

export function StarredHistory({ onClose }: StarredHistoryProps) {
  const { t } = useLanguage();
  const [messages, setMessages] = useState<StarredMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const mainRef = useRef<HTMLDivElement | null>(null);

  // Keep side margins equal when a classic scrollbar takes layout width
  // (same as the settings list; presentation only).
  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return undefined;
    const update = () =>
      el.style.setProperty('--gv-sbw', `${Math.max(0, el.offsetWidth - el.clientWidth)}px`);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [loading, messages.length]);

  useEffect(() => {
    loadStarredMessages();
  }, []);

  const loadStarredMessages = async () => {
    setLoading(true);
    try {
      const allMessages = await StarredMessagesService.getAllStarredMessagesSorted();
      setMessages(allMessages);
    } catch (error) {
      console.error('Failed to load starred messages:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleMessageClick = async (message: StarredMessage) => {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const targetUrl = buildStarredMessageUrl(message.conversationUrl, message.turnId);

    const isChatGPTPage =
      currentTab?.url?.includes('chatgpt.com') || currentTab?.url?.includes('chat.openai.com');

    if (isChatGPTPage && currentTab?.id) {
      // Navigate in the same tab (SPA navigation)
      await chrome.tabs.update(currentTab.id, { url: targetUrl });
      // Close the popup
      window.close();
    } else {
      // Open in new tab if not on ChatGPT
      await chrome.tabs.create({ url: targetUrl });
    }
  };

  const handleDeleteMessage = async (message: StarredMessage, e: React.MouseEvent) => {
    e.stopPropagation();

    try {
      await StarredMessagesService.removeStarredMessage(message.conversationId, message.turnId);
      // Reload messages
      await loadStarredMessages();
    } catch (error) {
      console.error('Failed to delete starred message:', error);
    }
  };

  const formatDate = (timestamp: number): string => {
    const d = new Date(timestamp);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
  };

  const truncateText = (text: string, maxLength: number): string => {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
  };

  return (
    <div className="gv-shell flex h-full min-h-0 w-full flex-col overflow-hidden">
      {/* Header */}
      <header className="gv-header gv-header--sub">
        <div className="flex min-w-0 items-center gap-0.5">
          <Button
            onClick={onClose}
            variant="ghost"
            size="icon"
            aria-label={t('announcementClose')}
            title={t('announcementClose')}
            className="text-fg-2 hover:text-fg h-[30px] w-[30px]"
          >
            <ChevronLeft className="h-[18px] w-[18px]" strokeWidth={2} />
          </Button>
          <h1 className="gv-title">{t('viewStarredHistory')}</h1>
        </div>
        {!loading && messages.length > 0 ? (
          <span className="text-fg-3 pr-1 text-xs tabular-nums">{messages.length}</span>
        ) : null}
      </header>

      {/* Content */}
      <div ref={mainRef} className="gv-main pt-2 pb-4">
        {loading ? (
          <div className="text-fg-3 flex h-full items-center justify-center text-[13px]">
            {t('loading')}
          </div>
        ) : messages.length === 0 ? (
          <div className="gv-push-in flex h-full flex-col items-center justify-center gap-2.5 pb-6">
            <span className="bg-surface text-fg-3 grid h-11 w-11 place-items-center rounded-full shadow-[0_0_0_1px_var(--gv-line)]">
              <Star className="h-5 w-5" strokeWidth={1.8} />
            </span>
            <p className="text-fg-3 text-[13px]">{t('noStarredMessages')}</p>
          </div>
        ) : (
          <div className="gv-group gv-push-in">
            {messages.map((message) => (
              <div
                key={`${message.conversationId}-${message.turnId}`}
                className="gv-row gv-row--action group items-start"
                onClick={() => handleMessageClick(message)}
              >
                <Star
                  className="text-star mt-[3px] h-3.5 w-3.5 shrink-0"
                  fill="currentColor"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />

                {/* Message content */}
                <div className="min-w-0 flex-1">
                  <p className="text-fg line-clamp-2 text-[13px] leading-[1.45] font-medium break-words">
                    {truncateText(message.content, 100)}
                  </p>

                  {/* Conversation info */}
                  <div className="text-fg-3 mt-1 flex min-w-0 items-baseline gap-2 text-xs leading-4">
                    {message.conversationTitle && (
                      <span className="min-w-0 truncate">{message.conversationTitle}</span>
                    )}
                    <span className="shrink-0 tabular-nums">{formatDate(message.starredAt)}</span>
                  </div>
                </div>

                {/* Delete button */}
                <button
                  onClick={(e) => handleDeleteMessage(message, e)}
                  className="gv-btn gv-btn--icon text-fg-3 hover:bg-danger-soft hover:text-danger -mt-0.5 -mr-1 grid h-[26px] w-[26px] shrink-0 cursor-pointer place-items-center rounded-[7px] opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  title={t('removeFromStarred')}
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
