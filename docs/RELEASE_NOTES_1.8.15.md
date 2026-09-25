# v1.8.15 — 修复侧边栏与顶栏交互，新增图标栏收起按钮

- 修复 1.8.14 在 ChatGPT 新界面上把整个侧边栏盖住的问题：侧边栏恢复可点击（切换对话、菜单、文件夹），ChatGPT 自带的拖动调宽和「隐藏侧边栏」恢复正常。
- 侧边栏宽度设置改为通过 ChatGPT 自带的拖动手柄生效；直接拖动侧边栏边缘也会同步到插件设置。ChatGPT 自身把宽度限制在约 290–520px（随窗口大小变化）。
- 修复从 ChatGPT 侧边栏把对话拖进文件夹没反应的问题（新界面的拖动被 ChatGPT 自己接管了，现在跟着它的拖动走，ChatGPT 自带的「拖进项目」也不受影响）。
- 修复对话顶栏的「移动到文件夹」按钮和对话标题跑到右侧且点不了的问题，恢复到左侧；顶栏的「重命名」按钮移除（ChatGPT 自带的「…」菜单里有重命名）。
- 新增：侧边栏「ChatGPT」标题旁的 ◀ 按钮，一键收起左侧新增的图标栏：侧边栏保持原宽度靠左，省出的空间给对话区；再点展开。整个侧边栏收起时图标栏自动回来。按钮可在设置里关闭（默认显示，收不收由你点）。
- 修复新界面上失效的布局设置：对话宽度（对话栏和输入框一起变宽/变窄）、用户消息字号、代码块字号、段落间距、侧边栏自动隐藏 / 完全隐藏；「输入框宽度」现在控制底部输入框（以前只作用于编辑已发消息时的输入框），编辑框同宽。

## Verification

- Real Chrome (browser-harness) on the 2026-09 layout: hit-testing inside the sidebar reaches conversation rows again; a real mouse click switched to another conversation and back; collapse / expand went 290 → 52 → 290 px; a real drag on the native handle resized the panel 290 → 350 px and wrote 350 back to the setting; setting 279 leaves the panel at ChatGPT's own 290 px minimum.
- Real mouse drags from the ChatGPT sidebar into a folder's conversation list (positional insert) and onto a folder header both landed the right conversation; hover highlight shown, dimming and selection restored after release.
- Header folder / rename buttons and title now sit at the left of the thread title bar and pass hit-testing (`elementFromPoint`). Icon rail: fold to 0 px with the panel at x = 0, unfold back to 52 px; with the whole sidebar collapsed the rail comes back; the popup toggle defaults on.
- Icon rail fold runs at display refresh rate (6.2 ms frames, no long tasks, no writes to ChatGPT's root CSS variables); folded, the sidebar is 238 px (panel width kept) and the thread gains 52 px; ChatGPT's drag handle, collapse and expand keep working while folded.
- Layout settings, each set to a test value in the live page and measured, then restored: chat width 44 % → 533 px column / 533 px composer, 70 % → 848 / 849; chat font 130 % scales user and assistant text; code font 130 % scales new code blocks without double-scaling; paragraph spacing 32 → 32 px, 0 → 0; composer width 76 % → 921 px bottom composer (chat width off, column stays 768 px), inline editor same width centred on the column; auto-hide collapses, full-hide zeroes sidebar / title-bar slot / page card, the edge trigger reopens it. Line height, font family and composer collapse were already working.
- New tests: 5 sidebar width, 5 row-drag bridge, 11 rail toggle, 2 header left slot; the header rename shortcut and its 12 tests were removed. The folder test failure set is identical before and after the change. TypeScript check and Chrome production build pass.
