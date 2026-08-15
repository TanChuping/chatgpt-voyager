# v1.8.7 — Plain-text composer and popup layout fixes

## 本次更新

- 修复扩展设置面板在后续打开或切换对话后高度失控、滚动到底仍看不到底部内容的问题；标题栏和底栏固定，中间设置区独立滚动。
- 新增默认关闭的“纯文本输入模式”：编辑阶段原样保留 Markdown 字符，发送时再经 ChatGPT 原生输入框提交和渲染。
- 纯文本模式兼容 Enter / Ctrl+Enter、IME、附件、草稿保存、输入框折叠和 Folder Project 指令注入。
- 加固发送与草稿状态机，避免重复发送、旧内容误发、跨对话串稿、编辑器重建丢稿以及关闭功能时丢失未同步文本。
- 降低长文本编辑开销：编辑过程中不再按字符反复重写 ChatGPT 原生编辑器，仅在失焦、发送或安全关闭时同步。

## Verification

- Related regression tests: 60/60 passed
- TypeScript typecheck: passed
- Changed-file ESLint: passed (4 pre-existing console warnings only)
- Chrome production build and no-send browser verification: passed
- Firefox production build: passed

Fixes #12 and #13.
