# v1.8.10 — 纯文本输入模式修复

## 本次更新

- 修复纯文本输入框继承浏览器 textarea 默认两行高度的问题。
- 单行内容现在与 ChatGPT 原生输入框保持相同高度和垂直位置，多行内容仍按实际行数自动扩展。
- 修复在文本中间复制、粘贴后继续输入时，ChatGPT 隐藏编辑器抢走焦点并覆盖完整正文的问题。
- 纯文本框有内容时，ChatGPT 原有发送按钮会正确进入可发送状态；发送时仍先精确同步完整正文。
- 去掉聚焦纯文本框时由 ChatGPT 全局样式叠加出的蓝色细线。

## Verification

- Plain-text input regression tests: 30/30 passed
- TypeScript typecheck: passed
- Real Chrome: mid-text selection, copy/paste, continued typing, mid-text editing, active send button, exact sent body, single-line height, and post-send reattachment verified
- Chrome and Firefox production builds: passed
