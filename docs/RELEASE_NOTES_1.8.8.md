# v1.8.8 — Settings popup reliability hotfix

## 本次更新

- 修复从悬浮球点击“设置”时偶发只显示黑色空框的问题：设置弹窗使用明确的 360 × 600 尺寸，不再依赖尚未建立的弹窗视口高度。
- 修复部分 Chromium/Vivaldi 环境中设置按钮偶发显示红色错误且无法打开的问题：优先打开浏览器原生扩展弹窗；浏览器拒绝时自动改用独立设置窗口，并复用已打开的窗口。
- 版本升级到 1.8.8，以便 Chrome 正确识别并安装本次修复。

## Verification

- Popup and settings-surface regression tests: 5/5 passed
- TypeScript typecheck: passed
- Chrome and Firefox production builds: passed
- Real-browser path `悬浮球 → 设置`: opened a complete 360 × 600 settings popup with visible content and full scrolling
