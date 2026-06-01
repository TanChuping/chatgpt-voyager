# ChatGPT Voyager

ChatGPT Voyager is a GPL-3.0 browser extension that adapts the Voyager-style chat workflow to ChatGPT.

It is a heavily modified work based on [Gemini Voyager](https://github.com/Nagi-ovo/gemini-voyager). Respect and thanks to the original author and contributors for the foundation, ideas, and GPL-3.0 licensed work that made this project possible.

Repository: [TanChuping/chatgpt-voyager](https://github.com/TanChuping/chatgpt-voyager)

## Demo

| 文件夹功能 / Folders | 标签跳转 / Timeline jump |
| :---: | :---: |
| ![Folder feature](docs/media/%E6%96%87%E4%BB%B6%E5%A4%B9%E5%8A%9F%E8%83%BD.gif) | ![Timeline jump](docs/media/%E6%A0%87%E7%AD%BE%E8%B7%B3%E8%BD%AC.gif) |
| **图钉拖拽 / Pin drag** | **收藏夹栏 / Favorites bar** |
| ![Pin drag](docs/media/%E5%9B%BE%E9%92%89%E6%8B%96%E6%8B%BD.gif) | ![Favorites bar](docs/media/%E6%94%B6%E8%97%8F%E5%A4%B9%E6%A0%8F.gif) |

## Features

- ChatGPT conversation timeline with dot navigation, preview, highlighting, and starred positions.
- Timeline text pins for long answers: pin exact spots inside a message, switch pins within the selected timeline dot, select pins from the page, and delete pins with an inline delete control.
- Sidebar folders for organizing conversations locally, with an optional layout that places the folder list below the Projects section (instead of pinned at the top) so it scrolls together with the chat list.
- Undo a temporary chat: from inside a temporary chat, scrape the transcript and build a handoff prompt that continues it in a normal conversation (delivered inline, or auto-attached as a `.txt` for long chats).
- Prompt Manager with tags, search, prompt import/export, compact/comfortable display modes, and click-to-copy or click-to-insert behavior.
- Input enhancements, including input collapse, draft autosave, quote reply, Vim-style input option, Ctrl+Enter send option, and auto-scroll prevention.
- Markdown, KaTeX/LaTeX, formula copy, and Mermaid rendering support, including mind maps.
- Conversation export and local backup/import for prompts, folders, settings, and timeline hierarchy.
- One-click single-conversation export to Markdown or JSON from the chat header (piggybacks ChatGPT's own conversation fetch — no separate API call, no extra permissions). The export button opens a small menu: export the entire conversation, or pick individual messages and export only the selected subset.
- Cross-conversation favorites: star any user message, jump back to it from the favorites panel even after switching conversations.
- Layout controls for chat width, font size, input width, sidebar width, and folder spacing.
- A small support popover with Ko-fi and optional payment QR codes.

## Install Locally

Requirements:

- Node.js 20 or newer.
- npm.
- Chrome or Edge with Developer Mode enabled.

Install dependencies:

```bash
npm install
```

Build the Chrome/Edge extension:

```bash
npm run build:chrome
```

Load the unpacked extension:

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer Mode.
3. Click `Load unpacked`.
4. Select the generated `dist_chrome` folder.
5. Open or refresh `https://chatgpt.com`.

During development, rebuild after code changes and refresh the unpacked extension from the browser extensions page.

## Common Commands

```bash
npm run typecheck
npm run test
npm run build:chrome
```

Other platform build scripts are kept from the upstream project, but the actively maintained target for this fork is Chrome/Edge on ChatGPT.

## Recent Updates

### 1.6.8

- **Partial conversation export.** The top-bar export button now opens a small menu with two choices: *Entire conversation* (the existing one-click export) or *Select & export*. The latter enters a selection mode — tick individual messages (with "Select all" / "Only you" / "Only ChatGPT" helpers) and download only the chosen subset. Selection is keyed off the on-screen `data-message-id`, which maps 1:1 to the captured API messages, so it reuses the exact same exporters and format choice as the full export.
- Hide ChatGPT's native right-edge "prompt table of contents" minimap while the Voyager timeline is active — the two pinned to the same edge and overlapped into a jagged bar. Disabling the timeline brings the native one back.

### 1.6.7

- **Folder placement option.** A new setting (folder section of the popup) moves the sidebar folder list out of its pinned top position to below ChatGPT's "Projects" section and above "Recent", where it scrolls together with the chat list as a same-level section. Off by default — the folder panel keeps its original pinned-at-top behavior unless you opt in.

### 1.6.6

- **Undo temporary chat.** Temporary chats have no export API, so this works by DOM-scraping the on-screen transcript and assembling a handoff prompt that asks the model to continue the conversation in a normal (non-temporary) chat — preserving persona, tone, and context. Short transcripts are placed inline in the composer; longer ones are delivered via a synthetic paste event so ChatGPT auto-converts them to a `.txt` attachment (the prompt tells the model the attachment is Markdown source so replies keep their formatting). You review the result before sending.

### 1.6.1

- **Conversation export now has format choices in the popup.** A new "Conversation export" section in the extension settings lets you pick between five formats: Standard Markdown (the 1.6.0 default, lossless), Simplified Markdown, Standard JSON, Simplified JSON, and HTML.
- **Simplified variants strip the "model thinking" noise** that users were reporting in the standard export. Under the hood, ChatGPT's conversation payload includes a lot more than the final answer — Code Interpreter's Python source (sometimes 30+ KB per turn), the model's pre-tool narration ("I'll build a single-file HTML page..."), tool execution output, and intermediate reasoning blocks. The simplified formats keep only three things: your messages, the model's final reply, and timestamps. The standard formats are unchanged so existing archives keep working.
- **HTML export** produces a single self-contained file with inlined CSS, light/dark auto-adapt, and proper HTML escaping. Double-click to read in any browser, no extension needed.
- **Filter is fail-closed**: unknown assistant content types (anything ChatGPT might add in the future) are dropped from the simplified output by default — better to be missing a new feature than to leak garbled internal blocks into an archive.

### 1.6.0

- **One-click single-conversation export** from a new button in the chat top bar next to ChatGPT's own Share control. Output is Markdown or JSON; filename follows `chatgpt-<slug>-<YYYYMMDD>.{md|json}`. The exporter walks ChatGPT's conversation `mapping` (current_node → parent chain → reverse) so branched / edited threads always export the *currently shown* path, not the full tree.
- **Silent API cache primer.** A page-world fetch/XHR hook (runs in MAIN world via a dedicated content script at `document_start`) listens for ChatGPT's own `/backend-api/conversation/<uuid>` calls, bridges the parsed payload into the extension via `window.postMessage` (+ a sessionStorage fallback for the cold-start case where the content-script hasn't booted yet), and pre-fills the timeline's TurnTextCache for every user turn. Effect: opening a long conversation now shows correct dot tooltips and preview-panel rows immediately, instead of waiting for the user to scroll past each turn to populate it.
- Conversation parser + export skeleton adapted from [pionxzh/chatgpt-exporter](https://github.com/pionxzh/chatgpt-exporter) (MIT). See `THIRD_PARTY_NOTICES.md` for the attribution and the reason we diverged from issuing API calls ourselves.

### 1.5.4

- Persistent turn-text cache. The timeline now persists each user turn's `{summary, attachments, hasGeneratedImage}` snapshot per conversation in localStorage (`gptTimelineTurnTextCache:<conversationId>`), capped at 500 entries per conversation and 80 conversations globally with LRU eviction. ChatGPT aggressively virtualises far-away message bodies, which used to leave the timeline dot tooltips and preview-panel rows blank until the user scrolled past every turn at least once. With the cache populated, the same data survives page reload, route change, and ChatGPT's own virtualisation.
- Edit detection via content fingerprints: each cached entry carries a stable hash of `(summary + attachment names)`. If a turn's live fingerprint diverges from the cached one (user edited, assistant regenerated), the cache invalidates that single entry — no full-cache wipes, no fragile DOM-timing heuristics.
- Click-jump animation now has a spring-overshoot pass so the active dot settles into place visibly instead of snapping.
- Unmounted-turn placeholders: the preview panel shows a soft placeholder row for turns whose body ChatGPT has unmounted, so the panel's vertical scroll position stays stable as virtualisation toggles.

### 1.5.3

- Sticky markers: timeline dots now survive ChatGPT's mid-conversation virtualisation pass. Previously, dots could vanish briefly when ChatGPT unmounted a turn's outer wrapper during fast scroll; now we keep a phantom marker pinned at the last known anchor until either the wrapper re-mounts or the conversation reconciles to confirm the turn is actually gone.

### 1.5.2

- Folder sidebar mounted inside ChatGPT's native sticky nav block, picking up ChatGPT's own design tokens so spacing/colors match the surrounding "New chat" / "Search chats" rows. Side effects: folders now scroll-stick correctly with the rest of the sidebar header, and the "⋯" menu glyph is centered with proper hover affordance instead of nudging on click.

### 1.5.1

- One-click favorites in the preview panel: each row has a star toggle so you can pin a message to your favorites list without long-pressing the dot.
- Timeline dots now layer multiple signals without stepping on each other: the active highlight reads on pin dots, favorites show a gold ★ inside the dot, file attachments paint a thin colored capsule on the left side of the bar (one per attachment, up to two), and a generated image in the reply takes that slot over with a small photo icon.

### 1.5.0

- File-attachment chips in the timeline. Turns that contain a PDF, Word doc, spreadsheet, pasted text blob, image, … now show a small colored pill in front of the body text (red for PDF, blue for Word, green for spreadsheets, gray for plain text, etc.), so the dot tooltip and preview panel no longer confuse the filename with the user's actual question. Dot tooltips use a minimal colored-dot + label variant; the preview panel uses the boxed pill.
- Stripped ChatGPT's own chrome text (the "展开收起" toggle, the "文档"/"Document" tile label) out of every turn summary so the dot aria-label and tooltip read exactly what the user typed.
- Pin text capture now avoids LaTeX source and host-chrome noise — pinning inside or near a KaTeX block records the rendered text rather than `\boxed{…}`.
- Prompt Manager header lets the title stay full-width on narrow panels by wrapping the version pill / language toggle to a second row instead of clipping "GPT-Voyager" to "GPT-Voy…".
- One-shot purge of leftover `geminiTimeline*` localStorage keys carried over from the project's Gemini Voyager ancestry.
- Repainted the timeline left-handle accent in the project's purple so the last bit of ChatGPT-green leaked into the bar is gone.

### 1.4.17

- Click-jump between timeline dots now uses the browser's native compositor-driven smooth scroll, matching the feel of a real wheel scroll instead of a hand-rolled requestAnimationFrame loop. Adjacent-dot clicks went from ~25fps to baseline display refresh.
- Scroll listener short-circuits heavy sync work while a click-jump is in flight; pin badges still track the page so they stay anchored during the animation.

### 1.4.15

- Timeline dot IDs now use ChatGPT's native message UUID instead of a numeric sequence. New turns ChatGPT lazy-loads into the middle of a conversation no longer produce hash-suffixed ghost dots ("u-12-1a6zsk2") that look like jump-in entries.

### 1.4.8

- Timeline text pins: pin exact spots inside a long ChatGPT answer, navigate between them with up/down controls scoped to the selected dot, and delete pins inline. Pin ownership binds to stable turn IDs so they survive scrolling and DOM re-renders.

## Privacy Notes

ChatGPT Voyager stores its feature data in the browser extension storage on the user's machine. It does not ship account sync, remote analytics, or remote code loading.

## License And Attribution

This project is distributed under GPL-3.0, following the original license of Gemini Voyager.

- Original project: [Gemini Voyager](https://github.com/Nagi-ovo/gemini-voyager)
- Modified project: [ChatGPT Voyager](https://github.com/TanChuping/chatgpt-voyager)

If you redistribute modified versions, keep the GPL-3.0 license and preserve attribution to the upstream project.

## Support The Author

ChatGPT Voyager is free and will stay free. If it saved you some time and you feel like buying the author a coffee (or a Sony keyboard), any of these work:

- **Ko-fi** — [ko-fi.com/nekonekomeowmeow](https://ko-fi.com/nekonekomeowmeow)
- **微信 / WeChat** and **支付宝 / Alipay** — scan the QR code below

<p align="center">
  <img src="https://raw.githubusercontent.com/TanChuping/chatgpt-voyager-support/refs/heads/main/support-assets/wechat-qr.png" alt="WeChat QR" width="220" />
  &nbsp;&nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/TanChuping/chatgpt-voyager-support/refs/heads/main/support-assets/alipay-qr.jpg" alt="Alipay QR" width="220" />
</p>

Thanks. Seriously.
