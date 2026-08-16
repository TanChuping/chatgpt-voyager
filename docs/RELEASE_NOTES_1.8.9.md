# v1.8.9 — 输入框与设置弹窗修复

## 本次更新

- 修复纯文本输入模式下的选区、光标与换行异常，避免原生编辑器抢焦点或重复追加正文。
- 纯文本输入模式现在跟随 ChatGPT 自己的“发送消息”快捷键：默认 Enter 发送；设为 Ctrl+Enter 时，Enter 换行、Ctrl+Enter 发送。
- 修复发送后 ChatGPT 重建输入区时纯文本输入框消失的问题。
- 修复从悬浮球打开独立设置窗口后，窗口高度沿用弹出面板固定尺寸导致底部内容被裁切的问题。
- 调整“支持作者”浮层为视口内居中显示，并限制最大宽高，避免在 Chrome 与 Vivaldi 的窄窗口中被截断。

## Verification

- Plain-text input, folder-project bridge, send behavior, and popup layout regression tests: 45/45 passed
- TypeScript typecheck: passed
- Real Chrome: default Enter send, Ctrl+Enter policy, exact multiline text, and post-send input reattachment verified
- Real Chrome floating-ball path: settings window, footer, and support popover verified inside a 387 × 569 viewport
- Chrome and Firefox production builds: passed
