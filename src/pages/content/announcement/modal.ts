/** One announcement, one visible translation, with a reading-local language choice. */
import { getCachedLanguage, getTranslationSyncUnsafe } from '@/utils/i18n';
import { APP_LANGUAGES, APP_LANGUAGE_LABELS, type AppLanguage } from '@/utils/language';

import { localizeAnnouncement } from './localization';
import type { RemoteAnnouncement } from './types';

const MODAL_CLASS = 'gv-announcement-modal';
const BACKDROP_CLASS = 'gv-announcement-modal__backdrop';
let activeModal: ModalHandle | null = null;

export interface ModalHandle {
  destroy: () => void;
  refreshLanguage: () => void;
}

export interface OpenModalArgs {
  announcement: RemoteAnnouncement;
  closeLabel: string;
  versionPrefix?: string;
  cached?: boolean;
  onClose: () => void;
}

function text(key: string, fallback: string): string {
  const translated = getTranslationSyncUnsafe(key);
  return translated && translated !== key ? translated : fallback;
}

function formatPublishedAt(input: string | undefined): string {
  if (!input) return '';
  const d = new Date(input);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '';
}

/** A version badge can be hidden with its panel while the reader is open. */
function restoreVisibleFocus(previous: HTMLElement | null): void {
  const candidates = [previous, document.getElementById('gv-pm-trigger')];
  for (const candidate of candidates) {
    if (
      !candidate?.isConnected ||
      candidate === document.body ||
      candidate === document.documentElement ||
      candidate.matches(':disabled')
    )
      continue;
    let visible = true;
    for (let node: HTMLElement | null = candidate; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        node.hidden ||
        node.hasAttribute('inert') ||
        node.getAttribute('aria-hidden') === 'true' ||
        (node.id === 'gv-pm-panel' &&
          (node.classList.contains('gv-pm-closing') ||
            node.classList.contains('gv-hidden') ||
            document.getElementById('gv-pm-trigger')?.getAttribute('aria-expanded') === 'false')) ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse'
      ) {
        visible = false;
        break;
      }
    }
    if (!visible) continue;
    candidate.focus({ preventScroll: true });
    if (document.activeElement === candidate) return;
  }
}

/** Follow the actual prompt panel, then the same page/OS fallback as that panel.
 * Theme is presentation only: do not read or write another preference here. */
function observeModalTheme(card: HTMLElement, backdrop: HTMLElement): () => void {
  const panel = document.getElementById('gv-pm-panel');
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    const panelTheme = panel?.getAttribute('data-gv-theme');
    let theme: 'light' | 'dark';
    if (panelTheme === 'light' || panelTheme === 'dark') {
      theme = panelTheme;
    } else if (
      document.documentElement.getAttribute('data-theme') === 'dark' ||
      document.querySelector('.theme-host.dark-theme') ||
      document.body.classList.contains('dark-theme') ||
      document.documentElement.classList.contains('dark') ||
      document.body.getAttribute('data-theme') === 'dark'
    ) {
      theme = 'dark';
    } else if (
      document.documentElement.getAttribute('data-theme') === 'light' ||
      document.querySelector('.theme-host.light-theme') ||
      document.body.classList.contains('light-theme') ||
      document.documentElement.classList.contains('light') ||
      document.body.getAttribute('data-theme') === 'light'
    ) {
      theme = 'light';
    } else {
      theme = media.matches ? 'dark' : 'light';
    }
    card.dataset.gvTheme = theme;
    backdrop.dataset.gvTheme = theme;
  };
  const observer = new MutationObserver(apply);
  const sources = [
    document.documentElement,
    document.body,
    panel,
    ...document.querySelectorAll('.theme-host'),
  ];
  for (const source of sources) {
    if (source) {
      observer.observe(source, {
        attributes: true,
        attributeFilter: ['class', 'data-theme', 'data-gv-theme'],
      });
    }
  }
  media.addEventListener('change', apply);
  apply();
  return () => {
    observer.disconnect();
    media.removeEventListener('change', apply);
  };
}

export function openAnnouncementModal(args: OpenModalArgs): ModalHandle {
  activeModal?.destroy();
  document.querySelectorAll<HTMLElement>(`.${BACKDROP_CLASS}`).forEach((b) => b.remove());
  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let destroyed = false;
  let renderRevision = 0;
  let readingOverride = false;
  let current = args.announcement;

  const backdrop = document.createElement('div');
  backdrop.className = BACKDROP_CLASS;
  const card = document.createElement('div');
  card.className = MODAL_CLASS;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'gv-announcement-modal-title');
  card.dataset.announcementId = args.announcement.id;

  const header = document.createElement('header');
  header.className = `${MODAL_CLASS}__header`;
  const titleEl = document.createElement('h2');
  titleEl.id = 'gv-announcement-modal-title';
  titleEl.className = `${MODAL_CLASS}__title`;
  header.appendChild(titleEl);
  const metadata = document.createElement('div');
  metadata.className = `${MODAL_CLASS}__metadata`;
  if (args.announcement.version) {
    const version = document.createElement('span');
    version.className = `${MODAL_CLASS}__version`;
    version.textContent = `${args.versionPrefix ?? 'v'}${args.announcement.version}`;
    metadata.appendChild(version);
  }
  const dateText = formatPublishedAt(args.announcement.publishedAt);
  if (dateText) {
    const date = document.createElement('time');
    date.className = `${MODAL_CLASS}__date`;
    date.dateTime = args.announcement.publishedAt!;
    date.textContent = dateText;
    metadata.appendChild(date);
  }
  if (metadata.childElementCount) header.appendChild(metadata);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = `${MODAL_CLASS}__close`;
  closeBtn.setAttribute('aria-label', args.closeLabel);
  closeBtn.title = args.closeLabel;
  closeBtn.textContent = '×';
  header.appendChild(closeBtn);
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = `${MODAL_CLASS}__body`;
  const controls = document.createElement('div');
  controls.className = `${MODAL_CLASS}__languages`;
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', text('language', 'Language'));
  const languageButtons = new Map<AppLanguage, HTMLButtonElement>();
  if (args.announcement.locales) {
    for (const language of APP_LANGUAGES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `${MODAL_CLASS}__language`;
      button.dataset.language = language;
      button.lang = language;
      button.textContent = APP_LANGUAGE_LABELS[language];
      button.addEventListener('click', () => {
        readingOverride = true;
        // Deliberately no setLanguage, storage write, or read/dedupe action.
        const selected = localizeAnnouncement(
          { ...args.announcement, locales: args.announcement.locales! },
          language,
        );
        if (selected) render(selected);
      });
      languageButtons.set(language, button);
      controls.appendChild(button);
    }
    body.appendChild(controls);
  }

  if (args.cached) {
    const cached = document.createElement('p');
    cached.className = `${MODAL_CLASS}__cached`;
    cached.setAttribute('role', 'status');
    cached.textContent = text(
      'announcementCached',
      'Showing the last saved announcement. The latest version could not be loaded.',
    );
    body.appendChild(cached);
  }
  const fallback = document.createElement('p');
  fallback.className = `${MODAL_CLASS}__fallback`;
  fallback.setAttribute('role', 'status');
  fallback.hidden = true;
  body.appendChild(fallback);

  const summary = document.createElement('p');
  summary.className = `${MODAL_CLASS}__summary`;
  body.appendChild(summary);
  if (args.announcement.primaryImageUrl) {
    const img = document.createElement('img');
    img.className = `${MODAL_CLASS}__hero`;
    img.src = args.announcement.primaryImageUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.remove(), { once: true });
    body.appendChild(img);
  }

  const md = document.createElement('div');
  md.className = `${MODAL_CLASS}__markdown gv-md`;
  md.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a') : null;
    if (!link || !md.contains(link)) return;
    event.preventDefault();
    if (link.href && /^(https?:|mailto:)/i.test(link.href)) {
      window.open(link.href, '_blank', 'noopener,noreferrer');
    }
  });
  body.appendChild(md);
  card.appendChild(body);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  const stopObservingTheme = observeModalTheme(card, backdrop);

  function render(announcement: RemoteAnnouncement): void {
    current = announcement;
    const revision = ++renderRevision;
    const requested = announcement.requestedLanguage ?? announcement.language;
    card.lang = announcement.language ?? '';
    card.dataset.language = announcement.language ?? '';
    card.dataset.requestedLanguage = requested ?? '';
    titleEl.textContent = announcement.title;
    summary.textContent = announcement.summary;
    summary.hidden = !announcement.summary;
    for (const [language, button] of languageButtons) {
      const selected = language === requested;
      button.setAttribute('aria-pressed', String(selected));
    }
    const usingFallback = !!announcement.language && announcement.language !== requested;
    fallback.hidden = !usingFallback;
    fallback.textContent = usingFallback
      ? text(
          'announcementTranslationFallback',
          'This translation is unavailable. Showing {language}.',
        ).replace('{language}', APP_LANGUAGE_LABELS[announcement.language!])
      : '';
    const markdown = announcement.bodyMarkdown;
    // Text is immediately usable even if the optional Markdown chunk fails.
    md.textContent = markdown;
    void (async () => {
      try {
        const [{ marked }, { default: DOMPurify }] = await Promise.all([
          import('marked'),
          import('dompurify'),
        ]);
        const html = await marked.parse(markdown);
        if (destroyed || revision !== renderRevision) return;
        md.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });
      } catch {
        if (!destroyed && revision === renderRevision) md.textContent = markdown;
      }
    })();
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    renderRevision++;
    stopObservingTheme();
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (activeModal === handle) activeModal = null;
    restoreVisibleFocus(previousFocus);
    if (previousFocus?.closest('#gv-pm-panel')) {
      // Escape reaches the panel's window listener after this document listener.
      // Reconcile once in the next task, after propagation and before its exit
      // animation hides the badge (native events may checkpoint microtasks sooner).
      // Do not steal focus from a new modal or another onClose destination.
      window.setTimeout(() => {
        if (
          !activeModal &&
          (document.activeElement === previousFocus || document.activeElement === document.body)
        )
          restoreVisibleFocus(previousFocus);
      }, 0);
    }
  }
  function close(): void {
    destroy();
    args.onClose();
  }
  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      card.querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]'),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  closeBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  function refreshLanguage(): void {
    if (destroyed) return;
    controls.setAttribute('aria-label', text('language', 'Language'));
    const closeLabel = text('announcementClose', args.closeLabel);
    closeBtn.setAttribute('aria-label', closeLabel);
    closeBtn.title = closeLabel;
    const cached = body.querySelector<HTMLElement>(`.${MODAL_CLASS}__cached`);
    if (cached)
      cached.textContent = text(
        'announcementCached',
        'Showing the last saved announcement. The latest version could not be loaded.',
      );
    if (!readingOverride && args.announcement.locales) {
      const localized = localizeAnnouncement(
        { ...args.announcement, locales: args.announcement.locales },
        getCachedLanguage(),
      );
      if (localized) current = localized;
    }
    render(current);
  }
  const handle = { destroy, refreshLanguage };
  activeModal = handle;
  render(args.announcement);
  closeBtn.focus();
  return handle;
}

/** Global preference updates UI chrome; an explicit reading override stays local. */
export function refreshOpenAnnouncementModalLanguage(): void {
  activeModal?.refreshLanguage();
}
