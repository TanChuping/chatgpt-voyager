/**
 * Full-screen modal renderer for the current announcement.
 *
 * Opens on:
 *   - megaphone button click
 *   - "查看详情" inside the bubble
 *   - the `1.6.x` version chip in the prompt-manager header
 *
 * Markdown is rendered via `marked` + sanitized through `DOMPurify` —
 * the same pipeline the prompt manager uses for prompt body previews,
 * so we don't add a second markdown sanitizer to the bundle.
 *
 * The modal IS intentionally interrupting (backdrop, focus trap on Esc),
 * unlike the bubble which is deliberately not. The bubble surfaces the
 * announcement; the modal is the user's explicit "read it" gesture.
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';

import type { RemoteAnnouncement } from './types';

const MODAL_CLASS = 'gv-announcement-modal';
const BACKDROP_CLASS = 'gv-announcement-modal__backdrop';

export interface ModalHandle {
  destroy: () => void;
}

export interface OpenModalArgs {
  announcement: RemoteAnnouncement;
  closeLabel: string;
  versionPrefix?: string;
  onClose: () => void;
}

function formatPublishedAt(input: string | undefined): string {
  if (!input) return '';
  const d = new Date(input);
  if (!Number.isFinite(d.getTime())) return '';
  try {
    return d.toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

export function openAnnouncementModal(args: OpenModalArgs): ModalHandle {
  // Close any prior modal first.
  document.querySelectorAll<HTMLElement>(`.${BACKDROP_CLASS}`).forEach((b) => b.remove());

  const backdrop = document.createElement('div');
  backdrop.className = BACKDROP_CLASS;

  const card = document.createElement('div');
  card.className = MODAL_CLASS;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'gv-announcement-modal-title');

  // Header
  const header = document.createElement('header');
  header.className = `${MODAL_CLASS}__header`;

  const titleEl = document.createElement('h2');
  titleEl.id = 'gv-announcement-modal-title';
  titleEl.className = `${MODAL_CLASS}__title`;
  const titlePrefix = args.announcement.version
    ? `${args.versionPrefix ?? 'v'}${args.announcement.version} — `
    : '';
  titleEl.textContent = `${titlePrefix}${args.announcement.title}`;
  header.appendChild(titleEl);

  const dateText = formatPublishedAt(args.announcement.publishedAt);
  if (dateText) {
    const date = document.createElement('div');
    date.className = `${MODAL_CLASS}__date`;
    date.textContent = dateText;
    header.appendChild(date);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = `${MODAL_CLASS}__close`;
  closeBtn.setAttribute('aria-label', args.closeLabel);
  closeBtn.title = args.closeLabel;
  closeBtn.textContent = '×';
  header.appendChild(closeBtn);

  card.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.className = `${MODAL_CLASS}__body`;

  if (args.announcement.primaryImageUrl) {
    const img = document.createElement('img');
    img.className = `${MODAL_CLASS}__hero`;
    img.src = args.announcement.primaryImageUrl;
    img.alt = '';
    img.loading = 'lazy';
    body.appendChild(img);
  }

  const md = document.createElement('div');
  md.className = `${MODAL_CLASS}__markdown gv-md`;
  // `marked.parse` returns sync or async depending on configuration —
  // we treat both shapes and sanitize before injecting.
  try {
    const out = marked.parse(args.announcement.bodyMarkdown);
    if (typeof out === 'string') {
      md.innerHTML = DOMPurify.sanitize(out, { ADD_ATTR: ['target', 'rel'] });
    } else {
      out
        .then((html: string) => {
          md.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });
        })
        .catch(() => {
          md.textContent = args.announcement.bodyMarkdown;
        });
    }
  } catch {
    md.textContent = args.announcement.bodyMarkdown;
  }
  // Open links in a new tab — same pattern as the prompt-manager modal.
  md.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'A') {
      e.preventDefault();
      const href = (target as HTMLAnchorElement).href;
      if (href) window.open(href, '_blank', 'noopener,noreferrer');
    }
  });
  body.appendChild(md);

  card.appendChild(body);

  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  function destroy() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      destroy();
      args.onClose();
    }
  }

  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    destroy();
    args.onClose();
  });
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      destroy();
      args.onClose();
    }
  });
  document.addEventListener('keydown', onKey);

  return { destroy };
}
