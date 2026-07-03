/**
 * Build the className for a top-bar button we inject by cloning a native
 * ChatGPT button's styling (Share, temp-chat toggle, …).
 *
 * ChatGPT renders some of these reference buttons in a DISABLED visual state at
 * the moment we clone them — early in load, or while a conversation isn't
 * shareable yet — marking them with `opacity-50 cursor-not-allowed` (and
 * sometimes `pointer-events-none`). ChatGPT later flips the reference button
 * back to enabled, but our clone keeps the stale classes, so our button renders
 * permanently dimmed with a red not-allowed cursor even though it works.
 *
 * Our injected buttons are always functional, so strip those state classes
 * while keeping everything else (padding, rounding, hover, focus rings) so we
 * still match native styling.
 */
const DISABLED_STATE_CLASSES = new Set([
  'opacity-50',
  'cursor-not-allowed',
  'pointer-events-none',
  'disabled',
]);

export function buildClonedButtonClassName(
  sourceClassName: string | null | undefined,
  ...extraClasses: Array<string | false | null | undefined>
): string {
  const kept = (sourceClassName || '')
    .split(/\s+/)
    .filter((cls) => cls && !DISABLED_STATE_CLASSES.has(cls));
  const extras = extraClasses.filter((cls): cls is string => Boolean(cls));
  return [...kept, ...extras].join(' ').trim();
}
