import {
  DRIVE_APPROVAL_CARD_SELECTOR as CARD_SELECTOR,
  findDriveAlwaysAllowButton,
} from '../shared/driveApprovalCard';

let cleanup: (() => void) | null = null;

export function startDriveAutoAllow(): () => void {
  if (cleanup) return cleanup;
  const clicked = new WeakSet<HTMLButtonElement>();

  const checkCard = (card: Element) => {
    const button = findDriveAlwaysAllowButton(card);
    if (!button || clicked.has(button)) return;

    // Mark before dispatch: a click can itself cause DOM mutations.
    clicked.add(button);
    button.click();
  };

  const collectCards = (root: Element, cards: Set<Element>) => {
    const parent = root.closest(CARD_SELECTOR);
    if (parent) cards.add(parent);
    root.querySelectorAll(CARD_SELECTOR).forEach((card) => cards.add(card));
  };

  const observer = new MutationObserver((records) => {
    const cards = new Set<Element>();
    const added = new Set<Element>();
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      const card = target?.closest(CARD_SELECTOR);
      if (card) cards.add(card);
      if (target && record.type === 'attributes' && !card) added.add(target);
      for (const node of record.addedNodes) {
        if (node instanceof Element) added.add(node);
      }
    }
    // Inspect only newly inserted subtrees, once per delivered mutation batch.
    // Streaming text outside a card never causes a document-wide query.
    for (const root of added) {
      let parent = root.parentElement;
      while (parent && !added.has(parent)) parent = parent.parentElement;
      if (!parent) collectCards(root, cards);
    }
    cards.forEach(checkCard);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['disabled', 'aria-disabled', 'hidden', 'aria-hidden'],
  });
  const initialCards = new Set<Element>();
  collectCards(document.body, initialCards);
  initialCards.forEach(checkCard);

  // No interval, requestAnimationFrame, focus or visibility gate: background
  // tabs work while the browser still runs JS and ChatGPT renders the card.
  cleanup = () => {
    observer.disconnect();
    cleanup = null;
  };
  return cleanup;
}

export function stopDriveAutoAllow(): void {
  cleanup?.();
}
