# v1.8.10 — 纯文本输入框布局修复

## 本次更新

- 修复纯文本输入框继承浏览器 textarea 默认两行高度的问题。
- 单行内容现在与 ChatGPT 原生输入框保持相同高度和垂直位置，多行内容仍按实际行数自动扩展。

## Verification

- Plain-text input regression tests: 28/28 passed
- TypeScript typecheck: passed
- Real Chrome: single-line height, mouse selection and replacement, exact newline count, Ctrl+Enter send, and post-send input reattachment verified
- Chrome and Firefox production builds: passed
