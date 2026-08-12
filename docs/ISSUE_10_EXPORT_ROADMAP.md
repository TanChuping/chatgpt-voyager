# Issue #10 export correctness and responsiveness roadmap

## Problem contract

Issue #10 reports a 23-turn conversation where both whole export and role-based selection stop at turn 18. A separate long conversation freezes when exported as HTML.

The requested behavior is:

- Whole export may use the capture cache first, but it must compare the latest five live messages with the cached tail before trusting it.
- If every comparable tail item disagrees or there is no shared tail anchor, whole export must rebuild by progressively loading history to the top, then refresh the cache.
- If part of the tail still agrees and only a few messages are new or modified, patch only those messages into the cache. Do not load the whole history.
- Selection mode must never scroll the conversation automatically.
- While selection mode is active, messages mounted by the user's own scrolling must gain selectors without losing previous selections.
- Select all, user-only, and assistant-only policies must include subsequently discovered messages.
- Long HTML export must not construct multiple complete copies of one giant HTML string on the main thread.
- Release verification must include a cold-cache run. A fast warm-cache download is not proof of correctness.

## Current root cause

There are two incompatible export assumptions in the current implementation:

1. `src/features/singleConvExport` treats any captured `/backend-api/conversation` payload as complete and immediately exports it.
2. The older DOM export pipeline attempts repeated top-node scrolling/clicking to hydrate history.

New turns created after the initial GET do not necessarily produce another full conversation capture. The first path therefore reuses an 18-turn snapshot even when the live conversation has 23 turns. Both whole and selection export share that stale snapshot. HTML also creates a complete escaped transcript string before creating a Blob, multiplying peak allocations for very large messages.

## Cache reconciliation algorithm

The implementation must expose a pure, testable tail comparison using at most the latest five live user-facing messages:

1. Read the cached linear conversation.
2. Read currently mounted live messages and compute stable identities from message ID and role. Compare normalized content only for modification detection.
3. Inspect the last five live records:
   - `fresh`: every live tail record already exists with equivalent content.
   - `incremental`: at least one stable message-ID anchor exists; merge new or changed records only. A same-ID Markdown/rendered-text difference is treated as a modification, not a new branch.
   - `rebuild`: live tail exists but has no shared message-ID anchor, or the cache is absent.
4. Never allow an older/shorter snapshot to overwrite a newer reconciled snapshot.

Message IDs provide ordering anchors. New records are inserted relative to their nearest known live neighbor; tail additions append. A full rebuild collects current-branch mounted messages while progressively moving to the top and only replaces the user-facing portion when no newer authoritative API capture arrived during hydration.

## Whole-export flow

1. Check cache against the live tail.
2. Export immediately when `fresh`.
3. Apply a bounded incremental patch and export when `incremental`.
4. On `rebuild`, progressively load upward with bounded waits and a visible progress state; collect each newly mounted message; stop at a stable top; refresh the cache; then export.
5. Restore the user's prior scroll position where practical.
6. Refuse a silent partial download if reconciliation cannot establish a usable snapshot.

## Selection-export flow

1. Enter immediately from the best current cache plus mounted live records.
2. Do not call the whole-export hydrator and do not change scroll position.
3. Observe mounted message nodes. Parse and merge newly discovered or modified records, extend the universe, and attach a selector.
4. Preserve `selectedIds` through DOM virtualization/replacement.
5. Track an optional active policy (`all`, `user`, `assistant`). Newly discovered records matching that policy become selected automatically. Manual per-message changes clear the policy.
6. Export from the reconciled snapshot, preserving original order.

## HTML flow

- Escape content with a single replacement pass.
- Split large message bodies into bounded chunks.
- Yield to the event loop between chunks/batches.
- Build a Blob from parts instead of joining the full document into one giant intermediate string.
- Keep existing `toHtml` output compatibility for tests and small callers, while production export uses the chunked path.

## Test matrix

### Unit/integration

- 18 cached messages + 2 new live messages with a shared anchor => incremental patch, no hydrator.
- 18 cached messages + 5 entirely different live-tail messages => rebuild.
- Same message ID with modified content + surrounding unchanged anchors => incremental replacement.
- Older capture arriving after a reconciled snapshot cannot regress the cache.
- Selection observer adds newly mounted messages and preserves prior selections.
- Active all/user/assistant policies include later messages of the matching role.
- Selection mode never invokes the scrolling hydrator.
- Chunked HTML output is equivalent to existing HTML output and yields for large content.

### Real browser, cold cache

1. Remove only Voyager conversation-capture and pending-export state for the repro conversation; clear browser HTTP cache as explicitly requested.
2. Open the repro conversation in a fresh tab.
3. Verify cold whole export reaches the latest visible turn.
4. Reopen selection mode, scroll manually, and verify new selectors appear without losing existing choices.
5. Verify role policies expand as messages mount.
6. Export the supplied long conversation as HTML and confirm the page remains responsive until the download starts.
7. Repeat once with a warm cache to verify the fast path.
8. Close test tabs and stop Browser Harness, leaving one Chrome window.

## Non-goals and safety boundaries

- Do not clear unrelated extension/user storage.
- Do not touch the repository's untracked `tmp/` directory.
- Do not auto-scroll selection mode.
- Do not claim success from a warm-cache-only run.
- Do not ship or publish unless the user separately requests it.

## Acceptance result (2026-08-12)

- Automated matrix: 14 files / 92 tests passed; typecheck, changed-file ESLint, diff check, Chrome build, and Firefox build passed.
- Cold-cache real browser: selection entered with 5 mounted nodes and no scroll; upward user-equivalent scrolling produced 9 selectors without losing the active role policy.
- Cold and warm HTML whole exports each contained all 32 user-facing records (16 user + 16 assistant) and the supplied page stayed responsive.
- Browser test resources were cleaned up; one Chrome window and one conversation tab remain.
