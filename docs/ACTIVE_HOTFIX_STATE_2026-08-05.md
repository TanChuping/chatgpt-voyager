# Active hotfix state — 2026-08-05

- Repository: `D:\coding\GPT-Voyager\gpt-voyager-main`
- Branch: `main`
- Release status: complete
- Release version / tag: `1.8.1` / `v1.8.1`
- Release commit: `156b38c`
- GitHub Release: <https://github.com/TanChuping/chatgpt-voyager/releases/tag/v1.8.1>
- Chrome package: `store_packages/chatgpt-voyager-1.8.1-chrome.zip`
- Package size: `2,240,071 bytes`
- Package SHA-256: `B398D4C457DB6E571D6C11EAA5B60073303144DF6C7D04ADB34D6AE49E1ABB43`

## Released behavior

- Timeline automatically recovers when ChatGPT replaces a temporary `WEB:` new-chat route and its DOM with the final conversation route and DOM.
- Timeline health checks no longer accept a blank bar as healthy when a live user turn already exists.
- Prompt Manager's floating trigger and panel are reattached if ChatGPT's late hydration removes them.
- Prompt Markdown dependencies initialize in parallel.
- No storage schema, migration, folder data, Timeline data, or user conversation data was changed.

## Verification

- Focused tests: 3 files, 6 tests passed.
- `bun run typecheck`: passed.
- `bun run build:chrome`: passed; the existing chunk-size warning is unchanged and non-blocking.
- Chrome ZIP validation: root manifest present, version `1.8.1`, 187 entries.
- Local and GitHub Release asset sizes and SHA-256 digests match.
- Live fast-send test: the temporary route reached 1 Timeline dot; the final route briefly reached 0, then recovered to 1 without refresh; a second turn updated from 1 to 2 dots.
- Live Prompt Manager test: trigger and panel remained mounted through hydration; forced removal restored both within 100 ms.

## Announcement

- Announcement ID: `2026-08-05-v1.8.1`
- Published to the support repository in commit `e37f07b4995c4ff47cb6ffd6d3b2f83009822bbd`.
- Uses the established bilingual sections: current update, common features, and feedback.
- Current-update sections contain only the two real user-visible reliability improvements.
- Previous `1.8.0` features were moved into both common-features sections.
- Chrome Web Store review estimate: on or before `2026-08-08`.
- Announcement rules are recorded in `docs/ANNOUNCEMENT_RULES.md`.

## Final state

- Main release, tag, GitHub Release, Chrome package, README, release notes, and bilingual announcement are published.
- Watchdog is disabled; active watchdog tags: none.
- No further release action is pending.
