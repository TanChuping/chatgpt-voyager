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
