# ChatGPT Voyager

ChatGPT Voyager is a GPL-3.0 browser extension that adapts the Voyager-style chat workflow to ChatGPT.

It is a heavily modified work based on [Gemini Voyager](https://github.com/Nagi-ovo/gemini-voyager). Respect and thanks to the original author and contributors for the foundation, ideas, and GPL-3.0 licensed work that made this project possible.

Repository: [TanChuping/chatgpt-voyager](https://github.com/TanChuping/chatgpt-voyager)

## Features

- ChatGPT conversation timeline with dot navigation, preview, highlighting, and starred positions.
- Timeline text pins for long answers: pin exact spots inside a message, switch pins within the selected timeline dot, select pins from the page, and delete pins with an inline delete control.
- Sidebar folders for organizing conversations locally.
- Prompt Manager with tags, search, prompt import/export, compact/comfortable display modes, and click-to-copy or click-to-insert behavior.
- Input enhancements, including input collapse, draft autosave, quote reply, Vim-style input option, Ctrl+Enter send option, and auto-scroll prevention.
- Markdown, KaTeX/LaTeX, formula copy, and Mermaid rendering support, including mind maps.
- Conversation export and local backup/import for prompts, folders, settings, and timeline hierarchy.
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

### 1.4.17

- Click-jump between timeline dots now uses the browser's native compositor-driven smooth scroll, matching the feel of a real wheel scroll instead of the hand-rolled requestAnimationFrame loop that was sharing the main thread with ChatGPT's own scroll handlers and stuttering on close jumps.
- The scroll listener short-circuits its heavy sync work while a click-jump is in flight; pin badges still track the page so they stay anchored during the animation.

### 1.4.16

- Timeline dots now slide smoothly when the marker list changes — inserts, collapses, and lazy-loaded turns no longer snap into place.
- The active dot now respects scroll direction: while the user scrolls one way, a noisy candidate that points the other way is held back briefly so the highlight no longer flickers backward during fast or sustained scrolling.

### 1.4.15

- Timeline dot IDs now use ChatGPT's native message UUID instead of a numeric sequence, so newly loaded mid-conversation messages no longer create hash-suffixed ghost dots that visually look like "jump-in" entries.

### 1.4.13

- Added a separate code block font-size control for ChatGPT code panes, including the current `cm-content` renderer.
- Chat font-size adjustments no longer force code blocks to follow the body-text scale.

### 1.4.12

- Timeline highlighting now also follows browser scrollbar dragging by switching to the active page scroll source.

### 1.4.11

- Timeline dot highlighting now follows the current scroll position in real time while reading.
- Added a document-level scroll fallback so the timeline keeps syncing if ChatGPT swaps its internal scroll container.

### 1.4.10

- Fixed sidebar folders disappearing after resizing ChatGPT from a narrow layout back to a wide layout.
- Folder visibility now follows the real rendered ChatGPT sidebar instead of only trusting stale side-nav class names.
- Folder icon colors now respect the selected folder color in the embedded sidebar list.

### 1.4.8

- Added timeline text pins for quickly returning to exact positions inside long ChatGPT messages.
- Pin navigation is scoped to the selected timeline dot, so the up/down pin controls do not jump into pins from other messages.
- Clicking a timeline dot now switches the active pin area for that message.
- Clicking an inline pin selects it and reveals a delete button; clicking empty space clears the delete control.
- Added focused tests for pin creation, message ownership, scoped navigation, pin selection, and dot-driven pin focus.

## Privacy Notes

ChatGPT Voyager stores its feature data in the browser extension storage on the user's machine. It does not ship account sync, remote analytics, or remote code loading.

## License And Attribution

This project is distributed under GPL-3.0, following the original license of Gemini Voyager.

- Original project: [Gemini Voyager](https://github.com/Nagi-ovo/gemini-voyager)
- Modified project: [ChatGPT Voyager](https://github.com/TanChuping/chatgpt-voyager)

If you redistribute modified versions, keep the GPL-3.0 license and preserve attribution to the upstream project.
