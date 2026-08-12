# v1.8.5 — Export cache reconciliation and long-chat stability

## 本次更新

- 修复跨天继续对话后，“整个导出”和“选择导出”仍沿用旧快照、漏掉后续消息的问题。
- “整个导出”现在校验最新五条消息：有共同消息锚点时只增量更新；没有共同锚点时才逐步加载完整历史并重建缓存。
- “选择导出”不会自动滚动；用户自行滚动后，新出现的消息会自动获得勾选入口，之前的选择不会丢失。
- “全选 / 仅你 / 仅 ChatGPT”会持续作用于后来加载出的消息。
- 修复超长公式对话中选择模式观察器反复扫描消息导致页面卡死的问题。
- HTML 导出改为分块转义和 Blob parts，降低超长对话的主线程阻塞与内存峰值。

## Verification

- Export-related tests: 92/92 passed
- TypeScript and changed-file ESLint: passed
- Chrome and Firefox production builds: passed
- Cold- and warm-cache browser verification: 32/32 messages exported (16 user + 16 assistant)

Fixes #10.
