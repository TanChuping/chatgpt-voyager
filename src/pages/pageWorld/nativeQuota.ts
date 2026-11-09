/** November 2026 rail usage button. Match the icon, not translated labels or CSS hashes. */
export const NATIVE_QUOTA_SELECTOR =
  'nav[data-app-navigation-rail] button[aria-description]:has(use[href*="#codex-icon-usage-"])';

type Fiber = {
  return?: Fiber;
  alternate?: Fiber;
  memoizedProps?: { usage?: unknown; rateLimitStatus?: unknown };
  stateNode?: { current?: Fiber };
};

/** Read only the committed button's ancestors; never search the app's state/tree. */
export function readNativeQuota(button: Element): unknown {
  const key = Object.keys(button).find((key) => key.startsWith('__reactFiber$'));
  if (!key) return null;
  const seed = (button as unknown as Record<string, Fiber>)[key];
  for (const candidate of [seed, seed?.alternate]) {
    if (!candidate) continue;
    let root = candidate;
    let depth = 0;
    // Live Work shell has 224 provider ancestors (2026-11-07). This is a
    // pointer-only root check; quota props are still limited to the first 48.
    while (root.return && depth++ < 512) root = root.return;
    if (root.return || root.stateNode?.current !== root) continue;
    let node: Fiber | undefined = candidate;
    for (let i = 0; node && i < 48; i++, node = node.return) {
      const usage = node.memoizedProps?.usage ?? node.memoizedProps?.rateLimitStatus;
      if (usage && typeof usage === 'object' && 'rate_limit' in usage) return usage;
    }
  }
  return null;
}
