# GPT-Voyager Phase 2 state

## Repository

- Worktree: `D:\coding\GPT-Voyager\gpt-voyager-main`
- Branch / HEAD: `main` / `3f72f4ab5427a607aba3a0f5e4a2afb7711da73e`
- No commit, stage, push, issue reply, data migration, or browser reload was performed.
- Preserve the pre-existing dirty set recorded in `ACTIVE_PHASE2_HANDOFF_2026-08-03.md`.

## Closeout index

- Final user-facing completion record: `PHASE2_CLOSEOUT_2026-08-04.md`.
- Source-by-source port decisions: `PHASE2_SOURCE_MAP.md`.
- Post-incident startup and storage contract: `LIGHTWEIGHT-RUNTIME-NOTES.md`.
- Phase 2 feature porting is closed. The final read-only audit found two unresolved P1 data-overwrite
  paths and one P2 automatic-migration path, so this is not a clean release gate. Any follow-up must
  start from the closeout file in a fresh task rather than inheriting this long conversation.

## Completed milestone

- Fetched the separate Gemini Voyager reference again after detecting the old shallow ref;
  current `origin/main` is `b5ea58b60bc9a4178e5844e8585eecc0485bbf37`.
- Added `PHASE2_SOURCE_MAP.md` with the compact source-to-target decision for all ten items.
- Implemented the first independent module: configurable chat line height and paragraph spacing.
- Both controls default off, use new `chrome.storage.sync` keys only, and dynamically import
  `src/pages/content/chatSpacing/index.ts` only while either control is enabled.
- Completed the Folder/sidebar frontend milestone against upstream
  `b5ea58b60bc9a4178e5844e8585eecc0485bbf37`: whole-section collapse/expand, in-memory search
  (including `f:` folder-only mode), a four-action toolbar, and the settings popover for conversation
  order, item font size, folder spacing, and subfolder indentation. The low-value current-user filter
  action remains removed. Gemini Voyager's two visibility levels are now separate: the restored left
  chevron keeps the header and collapses only search/list (`gvFoldersCollapsed`), while the eye hides
  the complete Folder UI behind a 6px keyboard-accessible peek bar (`gvFoldersHidden`). Both are new
  local UI preferences only; this milestone did not add a Folder data migration. The final audit did,
  however, confirm that the preserved production adapter still has an older mirror-first migration
  path capable of overwriting newer host data; see the closeout audit table.
- Matched the default Folder row rhythm to the live ChatGPT sidebar: native conversation rows measured
  36px with 6px vertical padding and zero inter-row gap. Folder headers and contained conversation
  rows now use the same 36px baseline. Reorder hit zones are zero-height and ignore pointer events at
  rest, then expand only for an active Folder/folder-conversation/native-conversation drag and collapse
  again on `dragend`; this preserves both the native visual rhythm and usable insertion targets.
  The existing spacing preference keeps its stored default value `2` and remains lazy-loaded only for
  explicit non-default values.
- Preserved the existing Folder adapter/data/backup/import-export path. New state is limited to
  UI preferences: local `gvFoldersCollapsed`, plus sync sort/font keys. No legacy hidden-state
  migration, folder-data rewrite, cloud-sync service, or upstream activity mode was copied.
- Removed the experimental ChatGPT usage/cloud action and its lazy module after confirming that it
  cannot provide Gemini-equivalent account usage. Gemini Voyager reads a real Gemini `/usage` page
  and its page-internal `jSf9Qc` batchexecute response; ChatGPT has no corresponding stable personal
  message-allowance source, while API Usage is a separate product.
- Traced the existing Folder import/export UI through real behavior: JSON Blob download; file or
  pasted-JSON parsing and validation; merge/overwrite; then the existing verified Folder storage
  adapter path with failure rollback. No data-bearing import was executed during verification.
- Focused export comparison concluded that ordinary upstream export enhancements are already
  present locally; the local lazy dependency loading and ChatGPT compatibility should remain.
- The diagnostic report was confirmed as an upstream plugin-support bundle. Its design may be
  useful, but a GPT-specific version requires explicit user approval and must not copy plugin schema.
- Completed the reply-complete system-notification milestone as a default-on ChatGPT module. An absent
  setting key enables it, while an existing explicit `false` remains authoritative; no migration or
  settings rewrite runs. `notifications` is a required extension permission so the default can work
  immediately. When explicitly disabled, neither the response-observer chunk nor its MAIN-world bridge
  executes. When enabled, it freezes the original conversation URL/title/prompt when the user sends and
  observes the real ChatGPT `POST /backend-api/f/conversation` SSE body through an independently injected
  and removable `fetch` wrapper.
- The observer drains a cloned SSE stream incrementally with `ReadableStream.getReader()` and discards
  every chunk instead of retaining the complete response with `arrayBuffer()`. The native DOM fallback
  is idle at rest, attaches only after a submit signal or observed network generation, detaches on a
  terminal outcome, and times out after 8 seconds when a submit does not start generation. A cloned
  stream still has a theoretical short-lived tee queue if either consumer stalls, but the observer
  continuously drains its branch and never retains response contents or touches persistent user data.
- The background bridge rechecks both the setting and permission, rejects non-ChatGPT senders and
  targets, performs a short in-memory duplicate guard, and embeds the target tab/conversation URL in
  the notification id. Clicking a notification focuses the original tab when it still shows that
  conversation; if the tab switched conversations or was closed, it opens the original conversation
  without replacing the user's current one. No conversation data or notification target is persisted.
- Completed a read-only storage-quota assessment and declined implementation. The current extension
  uses 256.64 KiB / 10 MiB local (2.51%) and 841 B / 100 KiB sync (0.82%); the upstream complete
  quota feature is roughly 2,034 production lines and includes background listeners, cleanup actions,
  permission handling, and page toasts. The old local `StorageMonitor` also measures the wrong quota
  surface and polls every minute. Neither implementation was activated.
- Confirmed that Timeline already caps turn-text caches at 80 conversations with LRU eviction. The
  user explicitly chose to retain 80. No Timeline setting, key, cache entry, star, pin, Folder data,
  or Prompt data was changed or removed.

## Phase 2 dirty files

- Added: `docs/PHASE2_SOURCE_MAP.md`
- Added: `docs/ACTIVE_PHASE2_STATE_2026-08-04.md`
- Added: `docs/PHASE2_CLOSEOUT_2026-08-04.md`
- Added: `src/pages/content/chatSpacing/index.ts`
- Added: `src/pages/content/codeBlockCollapse/index.ts`
- Added: `src/pages/content/responseNotification/index.ts`
- Added: `public/chatgpt-response-complete-observer.js`
- Added: `src/core/icons/lucideIcon.ts`
- Added: `src/core/icons/folderIcons.ts`
- Added: `src/pages/content/folderItemFontSize/index.ts`
- Modified within the pre-existing untracked bootstrap: `src/pages/content/bootstrap/features.ts`
- Modified: `src/core/types/common.ts`
- Modified: `src/pages/popup/Popup.tsx`
- Modified: `src/pages/background/index.ts`
- Modified: `manifest.json`
- Modified: `manifest.dev.json`
- Modified: `src/locales/en/messages.json`
- Modified: `src/locales/zh/messages.json`
- Modified: `src/pages/content/folder/manager.ts`
- Modified: `src/pages/content/folder/conversationSort.ts`
- Modified: `public/contentStyle.css`

## Outputs and hashes

- `docs/PHASE2_SOURCE_MAP.md`
  - SHA-256: `0A00D7866633419D6C247BC83B30D4AFE566DA320D3EC4A8EFBBF4BCD0E599A5`
- `docs/PHASE2_CLOSEOUT_2026-08-04.md`
  - SHA-256: `3CA9BB45E1A43E10BFB29F18384A8A9A03B7711F2D696A9783104E923CB384AD`
- `src/pages/content/chatSpacing/index.ts`
  - SHA-256: `AA351FFB554D6936B58C2274A1960ACEC48CAEB30191841A375C1CE53A1F4D38`
- `src/pages/content/codeBlockCollapse/index.ts`
  - SHA-256: `C0AB5EA71671032A1A409B2D6F91F602E8D3B6733D974AFF1AD92FFC0F468DF6`
- `src/pages/content/responseNotification/index.ts`
  - SHA-256: `E7BF7B90E8706251B93E749B2AA3BAB41D0C14EC7146921CF7146F44DD88772D`
- `public/chatgpt-response-complete-observer.js`
  - SHA-256: `B82D9CA20CC27E6143DDEA6C9ECD5DAE406C04719E680C46AA18DF58FE9483F4`
- `src/pages/background/index.ts`
  - SHA-256: `D9DF31542FB8284406E0D7A965236A784B35112F1B41312B7EB679E2542C448C`

## Verification

- Locale JSON parse: passed.
- `bun run typecheck`: passed.
- `bun run build:chrome`: passed in 18.57 seconds.
- Folder visual milestone `bun run build:chrome`: passed in 21.93 seconds.
- `git diff --check`: passed.
- Final independent `gpt-5.6-sol` read-only audit, rechecked by the main thread: 2 P1 + 1 P2 accepted;
  no P0 and no other evidence-backed P0-P2 finding. No audit fix was applied.
- Post-closeout Service Worker hotfix: guarded the response-notification API before creating a
  notification or registering `notifications.onClicked`. This prevents a missing notification API
  from crashing the worker and cascading into `No SW`, failed dynamic imports, Prompt storage errors,
  and invalidated starred-message requests. Typecheck and the Chrome production build (28.19s) passed;
  the real extension/profile was not reloaded. The accepted 2 P1 + 1 P2 data findings remain unchanged.
- Main content entry: 682.68 KB raw / 190.87 KB gzip.
- New lazy `chatSpacing` chunk: 1,689 bytes raw.
- Existing build warnings about inputCollapse chunking, duplicate emitted icons, and large chunks
  were observed and deliberately left untouched.
- Folder frontend verification: `bun run typecheck` passed; `bun run build` passed in 16.87s;
  locale JSON parse and `git diff --check` passed.
- Lazy build proof: `folderItemFontSize` remains a separate 953-byte raw chunk. There is no usage
  source, CSS, locale key, dynamic import, toolbar entry, or emitted usage chunk.
- Final correction verification: `bun run typecheck` passed; locale JSON parse and
  `git diff --check` passed; latest `bun run build` passed in 11.82 seconds. Existing warnings remained
  unchanged. The removed user-filter button has no remaining source, locale, storage-key reader,
  listener, or filtering path; an old stored value, if present, is ignored rather than migrated.
- `browser-harness` measured the live pre-reload Folder at 269px and confirmed the rejected layout
  had six 32px actions plus the extra title chevron. It then ran and removed a data-free 269px
  isolated preview of the corrected five-action layout: actions 176px, title 57px, no overflow.
- Drag-gap regression proof used an isolated, data-free DOM fixture: idle gaps were 0px/non-interactive
  with a 36px row pitch; drag start expanded them to 8px/interactive with a temporary 46px pitch;
  drag end restored the 0px/36px layout. The final `bun run build` passed in 16.28 seconds; the real
  extension/profile was not reloaded.
- The left header chevron now collapses only the search box; the Folder list remains visible. The eye
  remains the sole whole-section visibility control. The existing local collapsed-state key is reused
  without migration. Typecheck, Bun locale JSON parsing, and `bun run build` (12.47 seconds) passed.
- Completed the long-code-block collapse milestone as a default-off setting and separate lazy chunk.
  The implementation reuses the upstream threshold/interaction pattern but targets ChatGPT's current
  `#code-block-viewer` CodeMirror surface and sticky native toolbar instead of Gemini's `<code-block>`.
  Blocks become eligible at 24 lines or 520px, remain expanded by default, preserve the native copy
  button, and exclude Mermaid. No polling or data migration was added.
- A 10-minute read-only Deep Research assessment found that Gemini Voyager has two separate actions:
  multi-format final-report export and visible research-activity Markdown export. ChatGPT already has
  built-in Markdown/Word/PDF report downloads, so the report half should not be ported. Only a future,
  explicitly approved export of visible activity history/sources has incremental value; it must not be
  presented as hidden chain-of-thought.
- Long-code-block verification: typecheck, locale JSON parsing, Prettier check after formatting,
  `git diff --check`, and `bun run build` (12.11 seconds) passed. Vite emitted the feature as a separate
  3,983-byte raw / 1,822-byte gzip chunk. On the user-authorized ChatGPT test conversation, a reversible
  live-DOM fixture matched six current code viewers: the 142-line block collapsed from 2,862px to 256px,
  expanded back to 2,862px, re-collapsed to 256px, retained the native copy button, and enhanced zero
  short blocks. The fixture was removed; the real extension/profile was not reloaded.
- Final default-on reply-notification verification: direct TypeScript `--noEmit`, bridge syntax check,
  locale JSON parsing/key parity, targeted `git diff --check`, and the Chrome production build passed.
  The final build completed in 10.95 seconds. Its manifest includes required `notifications` permission
  and no `optional_permissions`; the MAIN-world bridge is 3,417 bytes and contains `getReader` with no
  `arrayBuffer`. Vite emitted the setting-gated content module as its own 6,329-byte raw / 2,654-byte
  gzip chunk. Because this feature is default-on, that small lazy chunk loads on ChatGPT by default;
  storing explicit `false` prevents both it and the bridge from executing.
- On the user-authorized ChatGPT conversation, the live lifecycle probe confirmed the current native
  selectors: visible `button[data-testid="stop-button"]` during generation, latest assistant under
  `[data-message-author-role="assistant"]`, and completed historical turns with
  `button[data-testid="copy-turn-action-button"]`. The short test reply rendered fully but ChatGPT
  remained in its native stop state for over four minutes and never added the copy action; the module
  correctly treats that as incomplete instead of producing a false notification. The temporary probe
  was disconnected and removed. The real extension/profile was not reloaded.
- A second user-authorized live probe confirmed the current ChatGPT generation transport as
  `POST /backend-api/f/conversation` with a successful `text/event-stream` response. The exact new
  observer file was then injected without reloading the extension: request `msefzddz-1` started on the
  authorized test conversation, the same tab immediately switched to a different conversation, and
  the request completed successfully 5,144 ms later while its frozen start URL still pointed to the
  original conversation. The wrapper and probe were uninstalled and the tab returned to the test
  conversation. No request body, token, or account data was logged.
- After replacing full-response buffering with incremental draining, the exact updated bridge was
  injected once more on the same authorized conversation. Request `msegmted-2` produced
  `request-start` followed by `request-complete`, `ok: true`, in 3,169 ms. The probe recorded only event
  metadata, then both the wrapper and probe were removed. The extension/profile was not reloaded.

## Protected / forbidden

- Legacy data keys, origins, formats, and fallback order remain authoritative.
- No Folder, Timeline, Prompt, favorite, or export storage path may be migrated or rewritten.
- Do not wholesale-copy the reference tree, reload the real Chrome profile, or fix unrelated warnings.

## One next action

No Phase 2 implementation milestone remains authorized. Feature porting is closed, but the current
tree is not release-safe because the final audit confirmed two P1 data-overwrite paths and one P2
automatic-migration path. If the user later authorizes fixes, open a fresh bounded data-safety task
from `PHASE2_CLOSEOUT_2026-08-04.md`; do not reload/migrate data or broaden it into a refactor.

## Watchdog

- Persisted watchdog state is disabled. No active tag was created for this milestone.
