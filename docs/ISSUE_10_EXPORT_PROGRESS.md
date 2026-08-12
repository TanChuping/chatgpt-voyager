# Issue #10 export fix progress

Last updated: 2026-08-12 (Asia/Shanghai)

## Status

- Phase: implementation and cold/warm real-browser verification complete.
- Branch: `main`
- Baseline: `d9e814b` (`v1.8.4`)
- Release: `v1.8.5` (Chrome ZIP + Firefox XPI).
- User-owned worktree state preserved: untracked `tmp/`.

## Confirmed root cause

- The modern whole-export path trusted any captured `/backend-api/conversation/<id>` payload without checking whether its latest visible messages still matched the page.
- Selection mode built its universe once from that same capture. Messages mounted later by ChatGPT virtualization were not reconciled into the export snapshot and did not reliably receive selectors.
- A first implementation of incremental selection observed every body mutation and rescanned/cloned large formula-heavy messages. On the supplied long conversation, KaTeX/internal mutations could drive a hot observer loop and freeze the page.
- HTML production export escaped and joined the entire transcript into one large string before Blob creation, creating avoidable whole-document copies on the main thread.
- This was an existing Voyager export-pipeline consistency/performance defect. It was not caused by copying the Gemini Voyager implementation back wholesale.

## Implemented behavior

- Whole export compares at most the latest five mounted messages against the captured snapshot.
- Stable message IDs are completeness/order anchors. Same-ID API-Markdown versus rendered-DOM differences are treated as incremental modifications, avoiding false full rebuilds on formulas.
- A shared tail ID results in an incremental insert/replace only; no full upward hydration occurs.
- No shared tail ID (or no capture) routes whole export through bounded progressive upward hydration, then refreshes the export-facing snapshot.
- Reconciled snapshots are monotonic: a delayed shorter capture cannot erase later discovered messages.
- Selection mode never invokes the whole-export hydrator or changes scroll position.
- Messages mounted by the user's scrolling gain selectors incrementally; selection IDs survive virtualization/replacement.
- `all`, `user`, and `assistant` policies extend to matching messages discovered later.
- The selection observer only inspects newly added message-containing subtrees, is debounced, and ignores content-only formula/rendering mutations.
- HTML production export emits bounded escaped Blob parts (128 KiB by default) and yields between batches instead of joining a second full document string.

## Automated verification

- Export-related Vitest suites: 14 files, 92 tests passed.
- TypeScript: `tsc --noEmit` passed.
- Changed-file ESLint: passed.
- `git diff --check`: passed.
- Chrome production build: passed.
- Firefox production build: passed.

## Real-browser cold-cache evidence

Target conversation: `https://chatgpt.com/c/6a69da20-4ba8-83ea-bc4b-7a1ec222829e`

1. Rebuilt and reloaded unpacked GPT-Voyager `1.8.4`.
2. Closed the previous stuck target and all unrelated test tabs.
3. Cleared Chrome's HTTP cache, opened the supplied conversation in a fresh tab, and waited for a new conversation capture.
4. At the bottom ChatGPT mounted only 5 message nodes, while the cold API capture already exposed 32 user-facing messages.
5. Entering selection mode did not move the scroll position. `仅你` selected 16 cached user messages.
6. After user-equivalent upward scrolling, mounted nodes grew from 5 to 9; all 9 had selectors. Newly mounted user messages reflected the active `仅你` policy, while the global selected count remained 16 and earlier choices were retained.
7. `全选` selected all 32 user-facing messages, including virtualized records not mounted at once.
8. Cold HTML whole export completed while the page remained responsive. The downloaded file contained 32 message articles: 16 user and 16 assistant, with a valid doctype and closing `</html>`.
9. A second warm-cache HTML export also contained the same 32 messages and completed responsively.

The two temporary verification downloads and screenshot were removed after inspection. The pre-existing user download was left untouched.

## Browser cleanup

- Browser Harness helper processes: 0.
- Chrome windows: 1.
- Remaining test tabs: 0; the supplied ChatGPT conversation is the sole tab and was restored to the bottom.

## Files added for this fix

- `src/features/singleConvExport/liveSnapshot.ts`
- `src/pages/content/conversationExport/historyHydrator.ts`
- `src/pages/content/conversationExport/prepareExport.ts`
- Focused tests for tail reconciliation, hydration, selection incrementality, and chunked HTML.
- This progress document, roadmap, and index.

## Resume commands

```powershell
Set-Location D:\coding\GPT-Voyager\gpt-voyager-main
git status --short
Get-Content docs\ISSUE_10_EXPORT_FIX_INDEX.md
Get-Content docs\ISSUE_10_EXPORT_ROADMAP.md
Get-Content docs\ISSUE_10_EXPORT_PROGRESS.md
```
