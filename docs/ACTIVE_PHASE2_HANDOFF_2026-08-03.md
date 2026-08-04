# GPT-Voyager Phase 2 clean-task handoff

## Repository

- Working tree: `D:\coding\GPT-Voyager\gpt-voyager-main`
- Branch / baseline: `main` at `3f72f4ab5427a607aba3a0f5e4a2afb7711da73e` (`v1.7.5`), with uncommitted selective restoration work.
- Full failed Phase 1 reference: `D:\coding\GPT-Voyager\phase1-reference`
- Safety snapshot: `D:\coding\GPT-Voyager\rollback-safety-20260803-issue6`
- No commit, stage, push, issue reply, or browser reload has been performed for the current worktree.

## Completed and currently dirty

- Restored existing ChatGPT compatibility fixes for Folder, Timeline, export, Canvas, fonts, input behavior, and related UI modules.
- Added the lightweight bootstrap under `src/pages/content/bootstrap/` and wired it in `src/pages/content/index.tsx`.
- Kept old Folder and Timeline storage keys/locations authoritative; no storage migration is active.
- Fixed lazy-start reachability for announcements, first quote selection, all export-menu entry points, and temporary-chat pending handoff recovery.
- Formula click-copy and selection-copy now load synchronously as the first core feature; the lazy formula registry and demand detector were removed.
- Main modified groups: `public/contentStyle.css`, `src/pages/content/index.tsx`, `src/pages/content/bootstrap/*`, Folder, Timeline, export, Canvas export, chat font/width/input tools, quote reply, Mermaid, and small shared compatibility bridges.
- New files include `docs/LIGHTWEIGHT-RUNTIME-NOTES.md`, `src/pages/content/bootstrap/*`, `src/features/folder/utils/conversationUrlSecurity.ts`, `src/pages/content/folder/nativeConversationBridge.ts`, `src/pages/content/shared/inputCollapseBridge.ts`, and `src/pages/content/timeline/timelinePrivateStorage.ts`.
- Run `git status --short` before editing; preserve every existing dirty file and do not overwrite the tree from another worktree.

## Verification already completed

- `bun run typecheck`: passed after the latest formula eager-load change.
- `bun run build:chrome`: passed after the latest formula eager-load change.
- `git diff --check`: passed.
- Current main content JS: about `682.35 KB` raw / `190.82 KB` gzip.
- Initial injected payload including loader, two CSS files, and MAIN-world hook: about `1.01 MB` raw / `251 KB` gzip.
- Formula eager loading accounts for roughly `+216 KB` raw / `+63 KB` gzip versus the prior demand-loaded build and is explicitly authorized by the user.

## Phase 2 objective

Fetch the latest Gemini Voyager reference and implement these requested features/UI ideas as independent, lightweight modules. Reuse upstream code when adaptation is cheaper; write a small local implementation when adaptation costs more than rewriting.

1. ChatGPT Deep Research export.
2. Activity / attention view.
3. Reply-complete system notification.
4. Long code-block collapse.
5. Configurable line height and paragraph spacing.
6. Modal scroll-position memory.
7. Storage-quota warning.
8. Export enhancements not already present.
9. Redacted diagnostic report.
10. Folder/sidebar visual refinement inspired by current Gemini Voyager, recolored to GPT-Voyager purple and dark gray.

## Protected contracts

- Existing user data, legacy keys, origins, formats, and fallback order are immutable product contracts.
- Do not migrate Folder, Timeline, Prompt, favorites, or export state to a new backend.
- Never treat an empty destination as authoritative and never delete a legacy source.
- Keep default behavior visually close to v1.7.5. Formula is now explicitly eager; other new Phase 2 features should be setting-, route-, or interaction-loaded.
- Preserve current purple / dark-gray theme; do not copy Gemini green.

## Forbidden repeats

- No broad storage redesign, stricter schema framework, cross-tab lock system, or generalized backup rewrite.
- No speculative fixes to inherited Gemini code without a reproduced user-visible defect.
- No wholesale folder moves, whole-tree copy, or overlapping rewrites of persistence code.
- No full test matrix after each module. Use one typecheck and one Chrome build per clean milestone, plus one focused browser path when needed.
- Do not reload the user's real Chrome profile automatically.

## One next action

In a fresh task, read this handoff and `$fuck-you-codex`, inspect Git remotes/sibling upstream directories, fetch the latest Gemini Voyager into a separate reference location, and produce a compact source-to-target feature map before editing. Then implement the smallest low-dependency module first. Do not fork or clone the current critical task history.

## Watchdog

- User reports watchdog is globally disabled. No watchdog tag is active. Thread-health `critical` is a separate context-size condition, not watchdog state.
