# v1.8.6 — Page lifecycle cleanup hardening

## 本次更新

- 修正内容脚本把 `beforeunload` 误当作页面已经退出的问题，避免未完成或最终变成下载的导航提前拆除时间线及其他页面功能。
- 仅在文档确定离开且不会进入往返缓存时执行破坏性清理；从往返缓存恢复时保留插件状态。
- 增加页面生命周期和时间线回归测试。

## Verification

- Page-lifecycle and timeline regression tests: 6/6 passed
- Announcement cooldown tests: 25/25 passed
- TypeScript typecheck: passed
- Chrome production build: passed

Related to #11. The reporter's exact failure could not be reproduced locally, so the issue remains open for confirmation on v1.8.6.
