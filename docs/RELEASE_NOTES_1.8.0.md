# GPT-Voyager 1.8.0

发布日期：2026-08-04

## 主要更新

- **Folder / 侧栏重新整理**：加入整区收起、搜索框折叠、文件夹展开箭头、文件夹与对话搜索
  （支持 `f:` 仅搜索文件夹）、手动/最近打开排序，以及字号、文件夹间距和子文件夹缩进设置。
- **拖放体验优化**：Folder 平时保持接近 ChatGPT 原生对话的紧凑行距；只有开始拖动时才展开
  插入命中区，结束后自动恢复。
- **回复完成通知**：默认开启系统通知；发送后即使切换对话或浏览器标签页，也能收到完成提醒，
  点击通知可回到原对话。补上通知 API 不可用时的 Service Worker 安全保护。
- **长代码块折叠**：可选开启；长代码默认完整显示，用户需要时可一键折叠/展开，短代码和
  Mermaid 不受影响。
- **聊天排版设置**：新增独立的行高和段落间距控制，默认关闭并按需加载。

## 修复与兼容性

- 修复 [#6](https://github.com/TanChuping/chatgpt-voyager/issues/6)：调整聊天宽度后，输入框不再偏向左侧。
- 恢复并加固当前 ChatGPT 页面下的 Folder、Timeline、Canvas、导出按钮、选择导出、字体和
  输入行为兼容性。
- 可选功能继续按设置、页面信号或用户交互动态加载；默认核心仍保持轻量。
- Folder 导入/导出继续使用现有 JSON 流程；本版没有加入云同步、用量面板、Deep Research
  导出、诊断报告或存储配额管理器。

## 安装

下载 `chatgpt-voyager-1.8.0-chrome.zip`，解压后在 `chrome://extensions` 打开开发者模式，选择
“加载已解压的扩展程序”。建议升级前先使用 Folder 的导出功能保存一份本地 JSON 备份。

Chrome / Edge 商店版预计在 **2026 年 8 月 8 日前**通过审核；审核期间可先使用 GitHub 版本。

---

## English summary

Version 1.8.0 refreshes the Folder/sidebar experience, adds optional long-code collapsing and chat
spacing controls, introduces default-on reply-complete system notifications, fixes composer centering
when chat width is changed (#6), and restores compatibility across Timeline, export, Canvas, fonts,
and input tools. Optional features remain demand-loaded. The Chrome/Edge store update is expected to
pass review before August 8, 2026.
