# GPT-Voyager Phase 2 结案记录

## 结案状态

- 日期：2026-08-04
- 工作区：`D:\coding\GPT-Voyager\gpt-voyager-main`
- 分支 / 基线：`main` / `3f72f4ab5427a607aba3a0f5e4a2afb7711da73e`
- Gemini Voyager 参考：`b5ea58b60bc9a4178e5844e8585eecc0485bbf37`
- 本轮没有提交、暂存、推送、实际执行数据迁移、数据清理或真实扩展重载。
- Phase 2 功能移植到此结束；最终只读审查不干净，当前生产树仍有 2 个 P1
  数据覆盖风险和 1 个 P2 自动迁移风险，不能把本文件理解为“安全发布放行”。
- 2026-08-03 事故后的旧数据键、存储位置、格式和回退顺序本应继续保持权威；
  最终审查确认当前代码仍有违反这一契约的旧路径，见“最终速审”。

## 本轮实际完成

| 项目 | 最终结果 | 加载方式 / 负担 |
| --- | --- | --- |
| Folder / 侧栏视觉与交互 | 完成。加入整区隐藏、搜索框折叠、文件夹展开箭头、四动作工具栏、排序/字号/间距/缩进设置；恢复接近原生对话的 36px 行节奏 | 视觉基础直接加载；非默认字号/间距继续按设置加载 |
| Folder 拖放间距 | 完成。静止时插入区为 0，不撑大列表；拖动时才扩展插入命中区，结束后恢复 | 只在拖动期间增加布局空间 |
| Chat 行高 / 段间距 | 完成。合并为独立 `chatSpacing` 模块，两个设置互不影响 | 默认关闭，按设置动态导入 |
| 长代码块折叠 | 完成。ChatGPT 当前代码块达到 24 行或 520px 后出现折叠控制；Mermaid 排除 | 默认关闭，独立懒加载块 |
| 回复完成系统通知 | 完成。默认开启；明确保存的 `false` 继续关闭。发送后即使切换对话或浏览器标签，也保留原始对话目标 | 内容模块约 6.33 KB raw / 2.65 KB gzip；MAIN bridge 3.42 KB raw |
| 通知 SSE 观察 | 完成。逐块读取后立即丢弃，不再 `arrayBuffer()` 整段缓存 | 只对 ChatGPT 对话 POST 生效；无轮询 |
| 通知 DOM 兜底 | 完成。只在提交/生成期间挂载，完成后卸载；未开始生成时 8 秒退出 | 空闲时无 MutationObserver |
| Folder 导入 / 导出核对 | 完成只读核对。现有 JSON 下载、粘贴/文件导入、合并/覆盖、失败回滚是真实路径 | 保留现有实现；没有执行数据导入 |
| 普通导出增强比较 | 完成评估。GPT-Voyager 已有的 ChatGPT 适配和 JSZip / 图片依赖懒加载更合适 | 不搬 Gemini 导出目录 |
| ChatGPT 用量 / 云入口 | 完成评估并移除实验入口。ChatGPT 没有 Gemini `/usage` 对应的稳定个人消息额度源 | 无遗留模块或工具栏入口 |

## 明确评估后不做

| 项目 | 决定 | 原因 |
| --- | --- | --- |
| Deep Research 最终报告导出 | 不做 | ChatGPT 已原生提供 Markdown、Word、PDF 下载 |
| Deep Research 可见活动记录导出 | 本轮不做 | 只有可见活动/来源有增量价值；不得包装成隐藏思维链 |
| Folder activity / attention view | 不做，Phase 2 在此结案 | 没有继续扩大到 Folder 数据和持久化层 |
| 脱敏诊断报告 | 不做 | Gemini 版本是插件支持包；GPT 版需重新定义精简白名单，用户未批准实现 |
| Storage quota 完整移植 | 不做 | 上游生产实现约 2,034 行 / 68.3 KB 源码，包含后台监听、页面 Toast、权限和清理管理器，明显过重 |
| 仓库旧 `StorageMonitor` | 不启用 | 它使用 `navigator.storage.estimate()`、默认每分钟轮询，不能准确区分扩展 `local` / `sync` 配额 |
| 精简存储用量卡片 | 不做 | 当前实际扩展 local 仅 256.64 KiB / 10 MiB（2.51%），sync 仅 841 B / 100 KiB（0.82%），没有现实压力 |
| Modal 滚动位置通用记忆 | 不做 | 没有复现一个仍会丢失位置的具体弹窗路径 |

## Timeline 缓存结论

- 当前权威 Timeline 文本缓存仍是 ChatGPT 域 `localStorage` 下的
  `gptTimelineTurnTextCache:<conversationId>`；没有迁移或重命名。
- `src/pages/content/timeline/turnTextCache.ts` 已经设置 `MAX_CONVERSATIONS = 80`。
- 每次 Timeline hydrate 后按对话内最大的 `lastSeenAt` 做 LRU；超过 80 时只淘汰最老的
  `gptTimelineTurnTextCache:*`，不会删除当前对话、Timeline 星标、文字固定、Folder 或 Prompt。
- 用户明确决定保持 80，不改为 50 或 100。
- 2026-08-04 只读实测：ChatGPT 域内 Voyager 数据约 89.47 KiB，其中 Timeline 约
  87.55 KiB、Folder 约 1.93 KiB。没有执行缓存清理。

## 真实存储只读快照

### 扩展 `chrome.storage.local`

| 模块 | 当前占用 |
| --- | ---: |
| Timeline 旧扩展存储缓存 / 星标 / 固定 | 163.30 KiB |
| 当前代码已无读写者的旧诊断记录 | 58.22 KiB |
| 消息时间戳 | 25.82 KiB |
| 公告缓存 | 7.07 KiB |
| 支持目标缓存 | 1.13 KiB |
| Folder 数据与备份镜像 | 0.98 KiB |
| Prompt 位置状态 | 92 B |
| 总计 | 256.64 KiB / 10 MiB（2.51%） |

### 扩展 `chrome.storage.sync`

- 总计 841 B / 100 KiB（0.82%）。
- 主要为 Folder 设置 378 B、布局/字体设置 223 B、Timeline 设置 99 B。
- 检查只统计键和字节数；没有输出具体内容、写入或删除。

## 验证记录

- TypeScript `--noEmit`：通过。
- Locale JSON 解析与中英文 key 对齐：575 / 575，通过。
- Chrome production build：最终 10.95 秒通过。
- `git diff --check` 与 Prettier focused check：通过。
- 长代码块真实授权页面验证：142 行代码块在 2,862px 与 256px 间正确折叠/展开；短块和 Mermaid 未误处理。
- 回复通知真实授权页面验证：更新后的 bridge 收到
  `request-start -> request-complete`，`ok: true`，3,169ms。
- 跨对话验证：同一标签切到另一对话后，原请求仍在 5,144ms 后完成，并保留原始对话 URL。
- 所有临时 DOM、探针和 fetch wrapper 均已移除；真实扩展/Profile 未重载。

## 关键文件索引

| 主题 | 入口 |
| --- | --- |
| Phase 2 详细状态和历史验证 | `docs/ACTIVE_PHASE2_STATE_2026-08-04.md` |
| 上游来源与移植决策 | `docs/PHASE2_SOURCE_MAP.md` |
| 事故恢复后的轻量运行契约 | `docs/LIGHTWEIGHT-RUNTIME-NOTES.md` |
| Folder 主实现 | `src/pages/content/folder/manager.ts` |
| Folder 图标 | `src/core/icons/folderIcons.ts`, `src/core/icons/lucideIcon.ts` |
| Folder 非默认字号 | `src/pages/content/folderItemFontSize/index.ts` |
| Chat 行高 / 段间距 | `src/pages/content/chatSpacing/index.ts` |
| 长代码块折叠 | `src/pages/content/codeBlockCollapse/index.ts` |
| 回复通知内容模块 | `src/pages/content/responseNotification/index.ts` |
| ChatGPT MAIN-world SSE bridge | `public/chatgpt-response-complete-observer.js` |
| 默认/懒加载注册表 | `src/pages/content/bootstrap/features.ts` |
| 后台系统通知与点击路由 | `src/pages/background/index.ts` |

## 结案边界

- 本轮没有把旧诊断记录、旧 Timeline 扩展存储镜像或任何其他现存键当成“垃圾”清理。
- 本轮没有主动执行 Folder、Timeline、Prompt、收藏、导出或草稿数据迁移。
- 但是当前生产代码仍包含会在扩展重新加载后触发的数据覆盖/迁移路径；在单独修复并验证前，
  不应把“本轮没执行”误写成“代码里不存在”。
- 不继续移植 Activity、诊断、配额管理器或 Deep Research 活动导出。
- Phase 2 功能范围在此结案。若要处理审查风险，应从本文件开始单独的新任务；不要继承本次
  长会话历史，也不要把修复扩成新一轮重构或数据迁移。

## 最终速审

- 审查者：独立 `gpt-5.6-sol` 子代理；主线程逐项复核。
- 方式：只读速审；没有编辑代码、执行数据操作、重载扩展或运行长测试。
- 口径：P0 只用于广泛且不可逆的数据灾难/安全事故；P1 用于可重复的数据丢失或核心功能破坏；
  P2 用于影响范围有限但路径确定的真实缺陷。代码味道、旧注释、理论竞态和测试噪声不入表。

| 等级 | 确认问题 | 确定触发与影响 | 证据 |
| --- | --- | --- | --- |
| P1 | Folder 启动时可用空/旧 `chrome.storage.local` 镜像覆盖较新的 ChatGPT 域 `localStorage` | 两边同时有 `gvFolderData`，Chrome 侧为 truthy 的空/旧 payload 时，默认启动跳过从 host 复制，随后优先读取 Chrome 并直接写回 host；较新或唯一的 Folder 记录会被稳定覆盖 | `src/pages/content/folder/storage/FolderStorageAdapter.ts:82-107`；默认调用 `src/pages/content/folder/manager.ts:357-376` |
| P1 | Timeline 初始化会用空的共享星标集合清空旧对话星标 | `gptTimelineStars:<conversationId>` 非空，而 `chrome.storage.local.gptTimelineStarredMessages` 缺失或没有该对话时，先载入旧星标，随后同步空集合并把旧键写成 `[]` | `src/pages/content/timeline/manager.ts:451-453,817-827,864-893,5293-5297` |
| P2 | Timeline 层级仍自动迁移到扩展聚合存储并删除旧键 | 旧 marker-level/collapsed 键存在时，打开对话即可触发；验证扩展写入后执行 `removeItem()`。旧版本、回滚或仍读旧键的路径会失去数据；新旧冲突时扩展数据获胜 | `src/pages/content/timeline/manager.ts:451-455,5375-5444,5487-5524` |

没有发现其他达到 P0-P2 门槛且有明确触发证据的问题。通知、权限、导出、懒加载和生命周期
审查中没有出现新的中高风险结论。此次按用户要求不修改代码，因此以上 3 项保持未解决。

## 最终结论

- **Phase 2 功能移植可以结案。** 已批准的功能和评估项不再继续扩展。
- **当前代码不能作为“零阻断、可放心重载/发布”的结案。** 两个 P1 是确定性旧数据覆盖路径，
  不是需要忽略的小问题；本轮只记录，不修复。

## 结案后 Service Worker 启动热修

- 用户决定不处理上表 3 条数据风险；本次没有改动 Folder、Timeline、Prompt 数据路径。
- 根因：回复通知在 Service Worker 顶层无条件访问 `browser.notifications.onClicked`。当前运行中的
  扩展上下文尚未提供通知 API 时，Worker 启动直接抛错；`No SW`、导出懒加载失败、Prompt 写入
  失败和星标 `Extension context invalidated` 是后续连锁错误。
- 最小修复：`src/pages/background/index.ts:104-105,136-137` 在创建通知和注册点击监听前检查
  API 是否存在；不可用时只返回 `notification_api_unavailable`，不再让 Worker 崩溃。
- 验证：TypeScript `--noEmit` 通过；Chrome production build 28.19 秒通过；构建产物确认保留
  `notifications` 权限，并包含条件注册代码。
- 未执行：没有重载真实扩展或刷新 ChatGPT 页面。该热修要生效仍需以后重载扩展；在上表两个
  P1 未处理的情况下，不把这次源码修复描述成安全重载授权。
