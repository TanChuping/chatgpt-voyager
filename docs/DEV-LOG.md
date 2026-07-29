# 开发进度 / 索引 (DEV-LOG)

> 给后续开发（人或 agent）用的**索引 + 历史**。目的：不用重读整个代码库就能定位问题。
> 项目总交接文档见 `公式交接.md`；agent 行为约束见 `CLAUDE.md`。
> **新增条目请往「变更历史」顶部加**，并同步更新下面的「子系统索引」。

---

## 子系统索引 — 出问题时先看这里

| 症状 | 入口文件 | 备注 |
| --- | --- | --- |
| 右侧时间轴（豆/dots）数量、位置、跳转 | `src/pages/content/timeline/manager.ts` | 6800+ 行，核心是 `findCriticalElements`（选择器选举）+ `recalculateAndRenderMarkers`（每次重建 marker） |
| 时间轴豆没了 / 只剩几个 | `src/pages/content/timeline/turnAnchors.ts` | ChatGPT 虚拟化补丁，见 2026-07-29 条目 |
| 豆上没文字 / “消息未加载” | `src/features/cachePrimer/CachePrimer.ts` + `FiberFallback.ts` | 文本来源：`/backend-api/conversation` 抓包 → React fiber 兜底 |
| 对话文本缓存（跨刷新） | `src/pages/content/timeline/turnTextCache.ts` | localStorage `gptTimelineTurnTextCache:gpt:conv:<uuid>` |
| 导出对话（选择模式、注入勾选框） | `src/pages/content/export/index.ts` | `collectChatPairs()` 从 DOM 配对 user/assistant |
| 导出内容抽取 / 格式化 | `src/features/export/services/` | `DOMContentExtractor` 里仍有 Gemini 遗留选择器 |
| 公式复制（拖选 / 原生按钮 / 点击） | `src/core/utils/latexFromDom.ts`, `src/features/formulaCopy/`, `src/pages/pageWorld/clipboardLatexFix.ts` | 三条复制路径，见 memory `latex-copy-paths` |
| 文件夹面板 | `src/pages/content/folder/manager.ts` | 8300+ 行 |
| 深色模式 / 布局滑块 | `src/pages/content/gentleDarkMode/`, `chatWidth/`, `chatFontSize/` | 2026-07 改版后 token 选择器有坑 |
| 页面世界（MAIN world）钩子 | `src/pages/pageWorld/conversationHook.ts` | fetch/XHR 抓包 + fiberReader + 剪贴板补丁的总入口 |

### ChatGPT DOM 关键事实（2026-07 改版后，2026-07-29 实测）

```
div[data-turn-id-container="<uuid>"]      ← 每一轮对话一个，**虚拟化时也在**，保留真实高度
  └ section[data-testid="conversation-turn-N"][data-turn="user"|"assistant"]
       └ ...                              ← 只有视口附近的几轮才有；其余整个 section 被卸载
```

- 虚拟化占位符长这样：`class="h-[var(--last-known-height,var(--estimated-turn-height,50vh))] min-h-14"`，
  带 `data-is-intersecting="false"`，**没有** `data-turn` 角色、没有文字。
- **user 轮的 `data-turn-id-container` === 该条消息的 message uuid**，
  和我们的 marker id（`u-<uuid>`，见 `withTurnIdPrefix`）一一对应。
  assistant 轮的 container id 是 turn id，**不等于** message id。
- `<article>` 已彻底消失（旧代码里的 `article[data-...]` 选择器全是死路）。
- 每条 user 消息前有 `<h4 class="sr-only select-none">你说：</h4>`（中文界面）。
- ChatGPT 自带右侧 TOC：`button[data-toc-item-index]`，一条 user prompt 一个，
  **它枚举的是全量**（我们用 `body.gv-timeline-active` 把它隐藏了）。
  可以拿它当“真实 prompt 数”的交叉校验。
- 线程滚动容器不是 `document.scrollingElement`，是那个
  `div[class*="scrollbar-gutter"][class*="group/scroll-r..."]`（`overflow-y:auto`）。

---

## 变更历史

### 2026-07-29 — 审计：全仓库 GBK 乱码（含一个线上崩溃）

**怎么发现的**：跑全量测试想确认「时间线修复」没引入回归，发现 88 个红。
用 `git worktree` 拉了 v1.7.3 的基线对比，确认 88 个红是**既有的**、和我的改动无关，
于是顺着查根因。

**根因**：最早那次 `b00984a "Prepare ChatGPT Voyager source release"`（从 Gemini Voyager
导入源码）是在 GBK 环境下做的，**把 UTF-8 字节按 GBK 读了**。全仓库的中/日/韩/俄/阿拉伯语
字符串、制表符、箭头、emoji 全部变成乱码。git 里没有干净版本，所以只能
`gbk-encode → utf8-decode` 逐段还原。

**为什么不只是难看**：UTF-8 是 3 字节、GBK 是 2 字节，落单的那个字节会**和后面一个字符
配对成非法 GBK 序列，把那个字符一起吃掉**——而那个字符通常是**收尾的引号**：

```
'button[aria-label*="ツール"]'   →   'button[aria-label*="銉勩兗銉?]'
```

选择器非法 → `document.querySelectorAll` 抛异常 → `queryHudMountCandidates` 整条
vim 模式 HUD 链路崩。**这一个异常连锁引发了 49 个测试报错**，修掉它测试就从 88 红降到 39 红。

**其余用户可见的**：
- `工具` / `도구` / `更新` 选择器合法但内容garbled，永远匹配不到中文/韩文界面（vimMode、sendBehavior）。
- fork 的删除按钮显示 `脳` 而不是 `×`。
- fork 导出的 markdown 里是 `### 馃懁 User` 而不是 `### 👤 User`。
- Prompt 管理器的设置提示语对中文用户是纯乱码。
- 文件夹管理器日志打 `鈺愨晲…` 而不是 `════…`。

**顺带挖出的真 BUG**：`forkContext.ts` 的 `zh` 模板**和 `en` 一字不差**——应该是当年乱码后
被人拿英文覆盖了。中文用户 fork 对话拿到的是英文指令，`zh` 分支等于死代码。已补真正的翻译。

**测试夹具也是坏的**，而且有 **7 个测试文件因为引号被吃掉根本解析不了**，等于那几个模块
零覆盖。修完夹具后：

| | 失败 | 通过 | 总数 |
| --- | --- | --- | --- |
| v1.7.3 基线 | 88 | 794 | 882 |
| 修完 | 66 | 926 | 992 |

多出来的 110 个测试就是那 7 个原本解析不了的文件。剩下 66 个红**全是过期的 Gemini 时代断言**
（`/app`、`/gem/<id>`、`gemini-chat-*.md`、AI Studio、Gemini 表格规则），不是产品 BUG，
本次未动。

**排查时踩的坑（下次省时间）**：
- 乱码里混着**私用区字符**（U+E632 等），终端里完全看不见 → 按字面量做精确替换会莫名匹配不上。
  一定要先 dump code point。
- **自动还原会误伤**：正确的短 CJK 串也可能 round-trip，`时` → `ʱ`、`全选` → `ȫѡ`。
  所以要么跳过 `src/locales/**`，要么改完扫一遍 `[Ā-ӿ]` 这类拉丁扩展/西里尔区字符找误伤。
- 段中夹 ASCII 的（`锛圕entralized ETC锛夊拰`）**只能整段解，不能逐段解**，自动扫描会漏掉。

### 2026-07-29 — 时间轴只显示 2 个豆（ChatGPT 整轮虚拟化）

**症状**：不管对话多长，右侧时间轴永远只有 2 个豆。导出选择模式同理只能勾到 2 条。

**根因**：2026-07 改版把「只清空 section 内部」改成了「**整个 section 卸载**」。
旧代码注释里写死的假设——“ChatGPT 会保留 `section[data-testid^=conversation-turn]` 外壳”——不再成立。
DOM 里只剩视口附近 2~3 轮，时间轴自然只能建 2 个 marker。

**修法**（`src/pages/content/timeline/turnAnchors.ts` 新增）：
1. 从已有的对话数据（API 抓包 / fiber 兜底 → `turnTextCache`）拿到全部 user turn id；
2. 把 `u-<uuid>` 还原成 uuid，找到 `div[data-turn-id-container="<uuid>"]`，
   打上 `data-gv-user-turn="1"` + 镜像 `data-turn-id="u-<uuid>"`；
3. `userTurnSelector` 统一并上 `div[data-gv-user-turn="1"]`（`withUserTurnAnchors`）。
   `filterTopLevel` 会自动丢掉嵌套的 section，所以已挂载的轮也走外层 wrapper——
   这本来就是 marker 代码期望的元素（外层几何稳定）。

**配套改动**：
- `countUnresolvedTurnContainers()` → 并入 `hasUnmountedMiss`。
  原来的判据是“marker 内容为空”，但整轮卸载后**根本不会生成 marker**，
  老判据看不见，fiber 兜底永远不触发。
- `installCachePrimerForManager` 加 `onPrimed` 回调 → API 抓包落地后主动重算
  （全量 hydrate 的线程可能不再产生 DOM mutation，等不到重算）。
- `TurnTextCache.turnIds()` 新增。
- `detectGeneratedImageAfterTurn` 加 `querySelector` 分支
  （marker 元素变成外层 wrapper 后，section 是**后代**不是祖先）。
- `hasVisuallyHiddenClass` 认 `sr-only`（精确匹配，避开 Tailwind 的 `not-sr-only`）。
  顺带修掉豆标题里的 “你说：” 前缀——原来只认 Gemini 的 `visually-hidden`。

**实测结果**（`browser-harness`，10 轮对话 / 5 条 prompt，只有 2 轮挂载）：
豆 2 → 5，与 ChatGPT 原生 TOC 的 5 条 prompt 完全一致；
未挂载轮的标题从缓存正确填充；点豆跳转正常（滚动容器 5997 → 52）。

**测试**：`bunx vitest run src/pages/content/timeline/ src/features/cachePrimer/` → 118 passed。

**还没修**：导出对话（`src/pages/content/export/index.ts`）同样只认已挂载的轮。
勾选框数量可以用同样的 anchor 修，但**导出内容**需要 assistant 正文，
虚拟化后 DOM 里没有——要么走 API 抓包重建正文，要么先滚动把全部轮挂载。

---

### 2026-07-29 — 顶栏「导出此对话」按钮换行（**两个独立原因，都要修**）

**症状**：注入的导出按钮整个掉到第二行，且文字也换行，很丑（用户截图）。

**原因 1 — 文字撑破按钮**：按钮通过 `buildClonedButtonClassName` 克隆 Share 的 class。
2026-07 改版后这些 header 按钮是**固定 36×36 纯图标**
（`flex h-9 w-9 items-center justify-center`）。克隆这套 class 再塞 70px 宽的文字
`<span>` 就撑破 36px 盒子，文字掉到图标下面。CSS 的 `white-space: nowrap` 挡不住
——宽度被 `w-9` 钉死了。

**原因 2 — 插错了容器（「整个按钮掉下一行」的真凶，公告按钮同病）**：
`thread-header-right-actions` 里**不是一排**，而是两组：

```
div#conversation-header-actions            (flex row, gap-2)
  ├ div.-me-2                              ← div > div > span[data-state]（Radix tooltip）
  │    └ span  display:inline              ← **inline**！里面塞第二个 button 会变成
  │         └ button[share-chat-button]       匿名块盒 → 纵向堆叠 → 双双溢出 52px 的 header
  └ div.flex.items-center                  ← 真正的横排
       ├ span > button（朗读）
       └ div.relative > button[conversation-options-button]  ("…")
```

我们的**公告按钮**和**导出按钮**原来都插在 `share.parentElement`（就是那个 inline span）里
→ 和 share 纵向堆叠 → 公告被裁到 header 上方、share 被裁到下方。
用户截图里"左上一个喇叭、左下一个上传箭头"就是这个。

**修法**：新增 `src/pages/content/shared/headerActionSlot.ts`，两个特性共用：
- `findOptionsButtonRow()` —— 锚定 `[data-testid="conversation-options-button"]`，
  插到它的 wrapper **之前**（即真正的横排里），克隆**它**的 class。
- `findShareButtonSlot()` / `findHorizontalRowAncestor()` —— 退路，会向上爬出所有
  会造成堆叠的 wrapper。**`wouldStackVertically` 原来把 `display:inline` 判为「安全」是错的**
  （inline 容器里的块级子元素照样堆叠），已修正。
- `isIconOnly(reference)`（导出按钮）：直接读参照按钮有没有可见文字，没有就不渲染 label。
  不写死 class 名，ChatGPT 以后改回带文字的按钮会自动跟回去。

**实测**：`#conversation-header-actions` = `1266,8 180x36`，五个按钮全在 y=8 一排：
分享 / 朗读 / 公告 / 导出 / "…"。首页 `/`（临时对话那条路径）也复测过,公告按钮仍是单排 36×36。

**注意**：时间轴的豆本身有**自己的虚拟化**（`updateVirtualRangeAndRender` + `visibleRange`）。
123 条 prompt 的对话里 DOM 只有 48 个 `.timeline-dot`，轨道内容高 2960px、可视 574px
——这是正常的窗口渲染，**不要当成漏豆**。判断豆全不全要看
`div[data-gv-user-turn]` 的数量对不对（实测 123 == 原生 TOC 123）。

---

### 早于 2026-07-29

细节都在 agent memory（`C:\Users\Administrator\.claude\projects\D--coding-GPT-Voyager\memory\`）：

| memory | 内容 |
| --- | --- |
| `chatgpt-2026-07-redesign` | Chat/Work 拆分、深色模式 token 选择器被 `html.dark :not(...)` 覆盖、`/library` 重渲染孤儿化文件夹 observer |
| `latex-copy-paths` | 三条公式复制路径 + 原生复制按钮的定界符/等号串损坏修复 |
| `perf-fixes-2026-07` | 1.7.0 打包拆分、mermaid 懒加载、原生滚动 pin |
| `timeline-nav-precision` | 点豆跳转 off-by-1~2 的收敛式再校正 |
| `fiber-timeline-unmounted` | React fiber 读未挂载轮的方案来源 |
| `browser-harness-testing` | 浏览器实测的坑（扩展热重载等） |
| `mermaid-detection-and-render` | mermaid 检测硬化 |
| `codex-adaptation` | Codex 页面适配 |

---

## 本地实测速查（browser-harness）

```bash
browser-harness -c "$(cat probe.py)"
```

- `cdp()` 的会话参数叫 **`session_id`**，不是 `sessionId`；传错会静默打到当前页去。
- **热重载扩展**（改完代码必须做，否则页面上跑的还是旧 bundle）：
  开 `chrome-extension://<id>/src/pages/options/index.html` 这个 target，
  在它的 session 里 `chrome.runtime.reload()`，然后刷新 ChatGPT 页面。
  `chrome://extensions` 的 DOM / `chrome.developerPrivate` 在 CDP 里够不到。
- 量滚动一定要**高频采样**（50ms），别只测前后两个点——
  平滑滚动 + 容器高度随挂载变化，两点采样会得出“没动”的错误结论。
