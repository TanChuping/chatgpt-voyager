# Lightweight runtime notes

## Scope

This change restores the already-written ChatGPT DOM compatibility fixes for Folder, Timeline,
export, Canvas export, fonts, and input tools, plus the lightweight feature bootstrap. It does not
include the later storage migration, strict import/schema validation, cross-tab locking, or backup
redesign.

## Startup contract

- Default core remains Timeline, Folder, Gentle Dark Mode, and Prompt Manager.
- Settings-driven tools are imported only when their existing v1.7.5 setting enables them.
- Mermaid, formula copy, Markdown repair, export controls, announcement UI, user LaTeX, Canvas
  export, and temporary-chat exit support load only after a matching page signal or interaction.
- One bootstrap router owns the shared page observation. Feature modules expose small start/stop
  hooks so SPA re-entry does not stack duplicate listeners.

## Data compatibility contract

- Folder keeps the original `gvFolderData` flow: ChatGPT-origin `localStorage` remains supported and
  the existing Chrome local-storage mirror behavior is unchanged.
- Timeline keeps the original `gptTimelineTurnTextCache:*`, `gptTimelineTextPins:*`, and
  `gptTimelineStars:*` keys in ChatGPT-origin `localStorage`.
- The file named `timelinePrivateStorage.ts` is only a lifecycle compatibility shim; it reads and
  writes those original `localStorage` keys and performs no migration.
- Prompt storage is unchanged from v1.7.5.
- No storage key is renamed, no existing payload schema is tightened, and no source data is deleted
  after copying to another backend.

## Verification

The intended lightweight gate is one TypeScript check and one Chrome production build. Full test
matrices are not required for this patch.
