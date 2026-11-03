const active = new WeakMap<HTMLElement, { animation: Animation; opening: boolean }>();

/** Change layout only at the endpoints. A second click reverses the same animation. */
export function setFolderDisclosure(
  element: HTMLElement,
  opening: boolean,
  setVisible: (visible: boolean) => void,
  animate = true,
): void {
  const running = active.get(element);
  if (!animate || !element.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    running?.animation.cancel();
    active.delete(element);
    setVisible(opening);
    return;
  }

  if (opening) setVisible(true);
  const folded = { opacity: 0, transform: 'translateY(-5px) scaleY(0.94)' };
  const shown = { opacity: 1, transform: 'none' };
  const animation = running?.animation ?? element.animate(opening ? [folded, shown] : [shown, folded], {
    duration: opening ? 300 : 160,
    easing: opening ? 'cubic-bezier(0.34, 1.25, 0.64, 1)' : 'cubic-bezier(0.6, 0, 0.2, 1)',
  });
  if (running && running.opening !== opening) animation.reverse();
  active.set(element, { animation, opening });
  animation.onfinish = () => {
    if (active.get(element)?.animation !== animation) return;
    active.delete(element);
    if (!opening) setVisible(false);
  };
}
