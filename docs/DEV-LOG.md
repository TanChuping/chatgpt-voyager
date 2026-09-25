# 开发进度 / 索引 (DEV-LOG)

> 给后续开发（人或 agent）用的**索引 + 历史**。目的：不用重读整个代码库就能定位问题。
> 项目总交接文档见 `公式交接.md`；agent 行为约束见 `CLAUDE.md`。
> **新增条目请往「变更历史」顶部加**，并同步更新下面的「子系统索引」。
> **ChatGPT 又改版、一串功能同时失效时**：先看 `docs/CHATGPT-DOM-ADAPTER.md`，在页面上跑 `__gvDomHealth()` 体检，只修适配层。

---

## 子系统索引 — 出问题时先看这里

| 症状 | 入口文件 | 备注 |
| --- | --- | --- |
| **一串功能同时失效（ChatGPT 改版）** | `src/pages/content/shared/domCompat.ts`, `shared/domHealth.ts` | 先跑 `__gvDomHealth()`；分层与原语表见 `docs/CHATGPT-DOM-ADAPTER.md` |
| 右侧时间轴（豆/dots）数量、位置、跳转 | `src/pages/content/timeline/manager.ts` | 6900+ 行，核心是 `findCriticalElements`（选择器选举）+ `recalculateAndRenderMarkers`（每次重建 marker）；有锚点时只用锚点（`queryUserTurns`） |
| 时间轴豆没了 / 只剩几个（2026-09 布局） | `src/pages/pageWorld/threadMirror.ts` + `timeline/threadAnchors.ts` | 读 React 虚拟列表写 `[data-gv-thread-anchor]` 锚点，见 2026-09-25 条目 |
| 时间轴豆没了 / 只剩几个（2026-07 布局） | `src/pages/content/timeline/turnAnchors.ts` | 给 `div[data-turn-id-container]` 打标签，见 2026-07-29 条目 |
| 豆上没文字 / “消息未加载” | 2026-09：锚点的 `data-gv-text`；2026-07：`src/features/cachePrimer/CachePrimer.ts` + `FiberFallback.ts` | 2026-07 文本来源：`/backend-api/conversation` 抓包 → React fiber 兜底 |
| 点豆跳到最底部 / 跳不动 | `timeline/manager.ts` `getScrollBounds()` | 2026-09 滚动容器是 `column-reverse`，scrollTop 为负 |
| 对话文本缓存（跨刷新） | `src/pages/content/timeline/turnTextCache.ts` | localStorage `gptTimelineTurnTextCache:gpt:conv:<uuid>` |
| 导出对话（选择模式、注入勾选框） | `src/pages/content/export/index.ts` | `collectChatPairs()` 从 DOM 配对 user/assistant |
| 整段导出不全 / 「could not safely load the complete conversation」 | `conversationExport/prepareExport.ts` + `historyHydrator.ts` + `features/conversationApi/ConversationCaptureService.ts` | 2026-09 分页：缓存 `complete` 为假时跳到顶部等 ChatGPT 分页加载 |
| 导出内容抽取 / 格式化 | `src/features/export/services/` | `DOMContentExtractor` 里仍有 Gemini 遗留选择器 |
| 公式复制（拖选 / 原生按钮 / 点击） | `src/core/utils/latexFromDom.ts`, `src/features/formulaCopy/`, `src/pages/pageWorld/clipboardLatexFix.ts` | 三条复制路径共用 `recoverMathSource`；2026-08 GPT 去掉了 MathML，见下方条目 + memory `latex-copy-paths` |
| 复制的公式粘不进 Desmos / 计算器 | `src/features/formulaCopy/desmosLatex.ts` | MathQuill 粘贴是全有或全无，`\displaystyle` `\,` 之类会整条丢弃，见 2026-08-08 条目 |
| 文件夹弹窗/菜单里出现字面量 `folder`、`push_pin` 等英文单词 | `src/pages/content/folder/folderIcon.ts` | Gemini 时代的 Material 连字图标在 ChatGPT 上退化成文字，见 2026-08-08 条目 |
| 注入的原生菜单项（移动到文件夹等）不出现 | `src/pages/content/folder/nativeConversationBridge.ts` | Radix 是 `pointerdown` 开菜单，click 时菜单已存在，见 2026-08-08 条目 |
| 往对话顶栏**左侧**注入按钮 | `src/pages/content/shared/headerActionSlot.ts` (`findHeaderLeftSlot`) | 右侧用 `findOptionsButtonRow`；2026-09 左侧是插在 `[data-app-shell-main-titlebar]` 开头的自有 `pointer-events: auto` 包裹层（整条顶栏是 `pointer-events: none`） |
| 图标栏收起按钮（侧边栏头部 ◀） | `src/pages/content/railToggle/index.ts` | 默认开；只在面板展开时收起图标栏；状态存 `chrome.storage.local.gvRailCollapsed` |
| 侧边栏对话拖不进文件夹 | `src/pages/content/folder/appShellRowDrag.ts` + `folder/manager.ts`（`makeConversationDraggable`） | 2026-09 行是 dnd-kit 拖拽项，原生 `dragstart` 被取消；跟着 ChatGPT 的指针拖动在文件夹面板上重放 HTML5 事件 |
| 对话宽度 / 输入框宽度没反应 | `src/pages/content/chatWidth/`, `editInputWidth/`, `chatgptDom.ts`（`THREAD_WIDTH_HOST_SELECTOR`） | 在两个宽度宿主上设 `--thread-content-responsive-max-width`（`cqi`）；popup「输入框宽度」= 底部输入框 |
| 字号 / 代码字号 / 行高 / 段距 | `src/pages/content/chatFontSize/`, `chatSpacing/` | 消息文字字号来自 `--codex-chat-font-size`；新代码块无 `<pre>`；新正文容器 `[data-markdown-text-style]` |
| 侧边栏自动隐藏 / 完全隐藏 | `src/pages/content/sidebarAutoHide/index.ts` | 认 `aside.app-shell-left-panel`，走 ChatGPT 自己的收起 / 展开按钮；完全隐藏要连顶栏 start 插槽和页面卡片一起归零 |
| 页面卡顿、动画掉帧 | 见「本地实测速查」的卡顿排查 | 整页约 2.7 万元素，一次整页样式重算约 200ms；别在 `<html>` 上挂状态、别改 ChatGPT 用 ResizeObserver 监视的尺寸 |
| 发公告 | `announcements.json`（本地，gitignore）+ `scripts/announcement-manager.mjs` | `node scripts/announcement-manager.mjs publish < /dev/null`；格式和冷却规则见本地 `CLAUDE.md`；**别 `require()` 这个脚本**（会启动交互式 CLI 挂住） |
| 新功能要「默认关但开了才加载」 | `src/pages/content/bootstrap/features.ts` | 照 `folder-header-button` / `folder-project` 写 lazy feature，`isEnabled` 为假就不会 `import()` |
| 文件夹面板 | `src/pages/content/folder/manager.ts` | 8300+ 行 |
| 深色模式 | `src/pages/content/gentleDarkMode/` | 2026-09 温和深色 = 官方主题生成函数以 #1f1f1e 算出的 token（见 2026-09-25 条目） |
| 侧边栏宽度 | `src/pages/content/sidebarWidth/index.ts` | 2026-09：**不用 CSS 改宽度**，对 ChatGPT 自带拖动手柄重放拖动；用户拖动写回设置 |
| 页面世界（MAIN world）钩子 | `src/pages/pageWorld/conversationHook.ts` | fetch/XHR 抓包（含 2026-09 分页接口）+ threadMirror + fiberReader + 剪贴板补丁的总入口；**不能 import 共享模块** |

### ChatGPT DOM 关键事实（2026-09 Codex 外壳，2026-09-25 实测）

完整的原语对照表见 `docs/CHATGPT-DOM-ADAPTER.md`，这里只记最容易踩的：

```
.thread-scroll-container            flex-direction: column-reverse（scrollTop 0 = 底部，往上为负）
  └ div.relative.shrink-0[style=height:<总高>]          虚拟列表容器（threadMirror 的锚点层挂在这里）
      └ div.flex.flex-col[style=margin-top:<偏移>]
          └ div[data-turn-key="<用户消息 id>"]            一整轮（问+答）；视口外整轮卸载，不留占位
              ├ [data-chatgpt-search-unit-key$=":user"]      用户消息（气泡 [data-user-message-bubble]）
              └ [data-chatgpt-search-unit-key$=":assistant"] 回答（正文 [data-markdown-text-style=assistant-message]）
```

- 对话数据分页：`/backend-api/conversations/<id>?num_turns=10` + `/messages?before=<id>`，旧的整段接口不再调用。
- React 虚拟列表组件（从任一 `[data-turn-key]` 的 fiber 往上约 5 层）：`props.entries[i].turn.items` 有用户原文 /
  附件（文件名在 `label`）；一个 `useRef` 里是 `{turnKeys, topOffsetsPx, heightsPx}`，与已渲染行逐像素一致。
- 几乎没有 `data-testid`；按钮只有随界面语言变化的 `aria-label`。
- 深色：`<html data-theme="dark">`；主题 token 在 `<style data-codex-app-themes>` 的 `@layer theme` 里。
- 顶栏 `header[data-app-shell-titlebar]` **整条 `pointer-events: none`**，注入的按钮必须放进 `pointer-events: auto` 的容器，否则看得见点不着。
- 侧边栏：`aside.app-shell-left-panel`（宽度 `var(--app-shell-left-panel-width)`，由根节点 `--app-shell-animated-left-panel-width` 驱动）
  → 内容包裹层（内联 `width` = ChatGPT 当前宽度）→ `#app-shell-sidebar` → 图标栏 `nav[data-app-navigation-rail]`（52px）+ 面板；
  拖动手柄 `aside > div > [role=separator]` 只在展开时渲染；ChatGPT 自己限制约 290–520px；收起时只剩图标栏，
  图标栏顶部的「显示侧边栏」按钮和面板头部的「隐藏侧边栏」按钮都带 `aria-controls="app-shell-sidebar"`，用 `aria-expanded` 区分。
- ChatGPT 用 ResizeObserver 把图标栏宽度写进根节点的 `--app-shell-navigation-rail-width`；页面卡片
  `[data-app-shell-workspace-row] > [class*="PageSurface-"]`（空的装饰层）和顶栏 start 插槽都从这些变量取位置。
- 侧边栏对话行是 dnd-kit 拖拽项（拖进项目），按下后 window 上有 `dragstart → preventDefault`。
- 对话栏宽度：转写区和输入框两个宿主 `[class*="[--thread-content-max-width:var(--thread-content-responsive-max-width"]`，默认 48rem；
  消息文字字号 `.text-size-chat { font-size: var(--codex-chat-font-size) }`；代码块 `[data-markdown-copy="code-block"] > div > code`（无 `<pre>`）；
  编辑已发消息时是用户消息块里的 `<form>`（ProseMirror）。
- 一个中等长度的对话页约 2.7 万个元素，整页样式重算一次约 200ms。

### ChatGPT DOM 关键事实（2026-07 布局，已被 2026-09 取代；2026-07-29 实测，数学部分 2026-08-08 更新）

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
- **数学（2026-08 起）**：`.katex-mathml` / `<annotation>` / `<math>` 全都没有了，
  TeX 在 `.katex` 的**祖先** `span[role="math"][data-math-source]` 上
  （`aria-label` 同值）；display 公式多一层 `.katex-display`，且外层 wrapper 带
  inline `style="display:block"`。取源必须 `closest()`。

---

## 变更历史

### 2026-09-25 — 布局设置逐项排查：对话宽度 / 字号 / 段距 / 代码字号 / 编辑框宽度 / 侧边栏自动隐藏（1.8.15）

真机逐项设测试值、量计算样式后还原：行高、字体本来就好；以下几项在新布局失效，已修。

- **对话宽度**：新布局由转写区和输入框两个宿主各自定义
  `--thread-content-max-width: var(--thread-content-responsive-max-width, inherit)`，改为在这两个宿主上设
  `--thread-content-responsive-max-width`，值用 `cqi`（相对对话区容器，窗口缩放 / 侧边栏收起自动跟随、不需要 JS、不触发重算）。
  转写区的容器在滚动条槽内（`scrollbar-gutter: stable both-edges`），输入框的不在，输入框减去实测槽宽保持对齐。
  删掉了 Gemini 时代和旧版的像素上限规则——`[data-message-author-role]` 现在也标在新消息块上（domCompat），那些规则会把新布局挤窄。
  **性能**：原来监听整个 `main` 的 DOM 变化、200ms 后无条件重写整张样式表（流式输出时反复全页重匹配），改为内容不变不重写，观察器量到槽宽就断开。
- **对话字号（用户消息）**：新布局消息文字用 `.text-size-chat { font-size: var(--codex-chat-font-size) }`，继承的字号到不了，
  改为对用户消息里的 `.text-size-chat` 按比例放大该变量。
- **代码字号**：新代码块没有 `<pre>`（`[data-markdown-copy="code-block"] > div > code`），加入新结构；助手正文规则排除新代码块，避免二次放大。
- **段落间距**：新正文容器是 `[data-markdown-text-style]`，加入选择器；原生段落有 4px 下边距会和设置值折叠，给相邻块清掉下边距，0 也能生效。
- **输入框宽度**（popup「输入框宽度 / Composer width」，存储键仍是 `gptEditInputWidth`）：代码原来只管「编辑已发消息」时的内联编辑框，和标签对不上，底部输入框从来不受它控制。改为控制底部输入框：在输入框宽度宿主上设 `--thread-content-responsive-max-width`（选择器比「对话宽度」的更具体，开着时输入框跟这个滑块，关着时跟对话宽度），同样用 `cqi` 减滚动条槽宽，百分比相同时与消息对齐；内联编辑框（用户消息块里的 `<form>`，没有 textarea）同宽、以对话栏居中。两个功能共用的宿主选择器和槽宽测量放到 `chatgptDom.ts`。
- **侧边栏自动隐藏 / 完全隐藏**：原来只认 `#stage-slideover-sidebar`。改为认 `aside.app-shell-left-panel`（展开 / 收起都在 DOM 里），
  收起 / 展开走 ChatGPT 自己的按钮（`aria-controls="app-shell-sidebar"` + `aria-expanded`）；完全隐藏时 aside、顶栏 start 插槽、
  页面卡片三处一起归零。状态从 `<html>` 的 class 改为这几个元素上的属性（避免每次切换整页重算）；观察器只响应侧边栏内部和
  根节点 `data-app-shell-sidebar-open` 的变化，不再被流式输出的每个 token 触发。
- **折叠输入框**：原本就能用（靠 domCompat 补的 `#prompt-textarea` / `form[data-type="unified-composer"]`）。

### 2026-09-25 — 顶栏文件夹/重命名/标题跑到右边、点不了；新增图标栏收起按钮（1.8.15）

**症状**：1.8.14 起对话顶栏的「移动到文件夹」「重命名」和对话标题出现在右侧（`…` 后面），而且点不了。

**根因**：新顶栏 `header[data-app-shell-titlebar]` 整条是 `pointer-events: none`，只有 ChatGPT 自己的 `pointer-events-auto` 包裹层能点。
`findHeaderLeftSlot` 找「右侧操作区」时用的 `[data-app-shell-header-obstacle]` 先匹配到侧边栏上方的 start 插槽，
于是把主标题栏当成左侧组、把按钮追加到它末尾——落在 `ms-auto` 右侧组后面，还继承了 `pointer-events: none`。
1.8.14 验收时用的是 DOM `.click()`，绕过了命中测试，所以没发现。

**修法**：新布局下左侧插槽是插在 `[data-app-shell-main-titlebar]` 开头的自有 `div[data-gv-header-left-slot]`（`pointer-events: auto`），
所有用左侧插槽的功能一起恢复。验证改用 `elementFromPoint` 命中测试。
「重命名」按钮删除：它整条流程（展开侧边栏、找菜单、找编辑框、监视提交）都建立在旧布局上，ChatGPT 自己的 `…` 菜单就有重命名（`folderHeaderButton` 1303 → 367 行）。

**新功能**：侧边栏头部「ChatGPT」和搜索之间加 ◀ 按钮（`railToggle`，默认开，popup「图标栏收起按钮」可关），
收起左侧新增的图标栏 `nav[data-app-navigation-rail]`，只剩侧边栏面板；再点展开。位移 / 透明度带回弹曲线，展开时图标依次弹回；收起后侧边栏保持面板原宽度、整体左移，省出的 52px 给对话区（ChatGPT 自身最小 290px，只能对 aside / 内容包裹层 / 顶栏 start 插槽做宽度覆盖，值由 ChatGPT 自己的宽度减图标栏宽度算出，拖动手柄和收起都照常；<768px 的浮层模式不收）；
这就是改版前的体验：展开时只有面板，收起后才出现那条窄条，顶部按钮用来重新打开。
安全条件：只有「用户点了收起 + 面板展开（有拖动手柄）+ 我们的 ▶ 按钮确实在面板里」三者同时成立才收起，否则图标栏原样显示——ChatGPT 改版导致按钮放不进去时，不会出现什么都点不开的情况。锚点必须带 `[aria-expanded="true"]`：面板收起后，图标栏顶部的「显示侧边栏」按钮也带 `aria-controls="app-shell-sidebar"`，第一版没区分，▷ 被插进了图标栏、和主页按钮挤在一起。
按钮用紧凑尺寸：ChatGPT 的面板宽度会被这一行的内容撑大（36px 按钮让侧边栏从 290 变 309）。
**性能坑（第一版卡成幻灯片）**：第一版把状态挂在 `<html>` 属性上、CSS 用 `:has()`、按宽度做动画——每次切换 Chrome 都把整页 27k 个元素标成失效（trace 里 `allDescendantsMightBeInvalid`），而图标栏宽度一变，ChatGPT 的 ResizeObserver 就把它写进根节点的 `--app-shell-navigation-rail-width`，又是整页重算；每次约 200ms，一次动画只画出 4–5 帧。改法：状态挂在图标栏 / 页面卡片 / 按钮自己身上，条件在 JS 判断；图标栏保持 52px 宽、收起时脱离文档流，面板和背后的页面卡片一起用 transform 滑动（FLIP）。实测每帧 6.2ms（刷新率），无长任务，ChatGPT 不再写那个变量。排查方法：CDP `Profiler` 看 JS 占比（几乎为 0，全是 `(program)`）→ `Tracing` 看 `UpdateLayoutTree` 的 elementCount → `invalidationTracking` 看是谁让整页失效 → MutationObserver 记根节点 style 的变化。
顺带：侧边栏宽度的「拖动写回」改成宽度真的变了才写——之前单击一下手柄就会把 ChatGPT 当时显示的宽度（309）写进设置。

### 2026-09-25 — 侧边栏对话拖不进文件夹（1.8.15）

**症状**：从 ChatGPT 侧边栏拖对话到插件文件夹没反应，被拖的行还会变半透明、留下选中状态。

**根因**：新外壳的侧边栏行是 ChatGPT 自己的 dnd-kit 拖拽项（把对话拖进项目）。按下鼠标后 dnd-kit 在 window 上挂
`dragstart → preventDefault`（冒泡阶段，松开后摘掉），插件的 HTML5 拖动一开始就被取消；插件的 `dragstart` 已经把行调暗，
而取消的拖动不会有 `dragend`，所以行一直是半透明。

**修法**：不和 dnd-kit 抢。新布局的行不再设 `draggable`，改由 `folder/appShellRowDrag.ts` 跟着 ChatGPT 自己的指针拖动走
（它本来就画了跟随鼠标的幽灵行）：移动超过 5px 时开始，鼠标在文件夹面板上时，把拖动重放成 HTML5 的 `dragover` /
`dragleave` / `drop` 事件，派发到指针下的面板元素上，带同样的 `application/json` 负载。已有的文件夹、根目录、
文件夹内排序落点都原样处理，ChatGPT 自己的「拖进项目」也照常可用。开始 / 结束的选中、变暗、复原逻辑抽成
`beginConversationRowDrag` / `endConversationRowDrag`，HTML5 路径和桥共用。

**验证**：browser-harness 真实鼠标——拖到文件夹里的对话列表会按位置插入，拖到「测试2」标题上会加进该文件夹，
悬停时文件夹高亮，松开后变暗和选中都复原；用户本人也实际拖动确认。

### 2026-09-25 — 1.8.14 的侧边栏宽度把整个侧边栏盖住、点不了（1.8.15）

**症状**：侧边栏哪里都点不了（切换对话也不行），鼠标移上去中间出现一条拖动线但拖不动；「隐藏侧边栏」也收不起来。

**根因**：1.8.14 用 `aside.app-shell-left-panel > div { width: var(--app-shell-left-panel-width) !important }`
让内层跟随宽度，但 ChatGPT 的拖动手柄 `div.group/panel-resizer`（`absolute z-20 w-4`，内含 `[role=separator]`）
也是 aside 的直接子 div，被一起撑成整条侧边栏宽，盖在所有内容上。另外 `--app-shell-left-panel-width: … !important`
把宽度钉死：ChatGPT 自己的拖动、收起到图标栏（52px）、开合动画全部失效。

**修法**：新布局下不再用 CSS 改宽度。这个面板归 ChatGPT 自己管（拖动手柄、收起、动画、持久化），插件改成：
设置的宽度通过对原生手柄**重放一次拖动**交给 ChatGPT 自己调整——它的拖动相对自己记录的尺寸，而且按下后重渲染
才开始监听移动，所以按下和移动之间要隔一个任务；用户自己拖手柄 / 双击复位后，把新宽度写回设置。
ChatGPT 自身限制约 290–520px（1460px 宽窗口），超出范围时停在边界、不反复重试。
选择器放在 `chatgptDom.ts`（`APP_SHELL_LEFT_PANEL_SELECTOR` / `APP_SHELL_PANEL_RESIZER_SELECTOR`）。

**教训**：给 ChatGPT 自己管的布局写覆盖，必须同时验证原生交互（点击穿透、拖动、收起）；
`> div` 这种宽泛子选择器会命中同级的原生控件。

**验证**：browser-harness 真机——侧边栏点击命中对话行，真实鼠标点另一个对话能切过去再切回；
收起 / 展开 290→52→290；真实拖动手柄 290→350，设置写回 350；设置改回 279 后面板停在 ChatGPT 下限 290。

### 2026-09-25 — ChatGPT 换成 Codex 外壳，二十多个功能同时失效（1.8.14）

**症状**：时间轴一个豆都没有、温和深色不生效、文件夹面板挂错位置、顶栏导出按钮和「移动到文件夹」菜单项消失、
长代码块折叠 / Mermaid 不工作、侧边栏宽度无效。插件本身加载正常（`gv-*` 样式和按钮都在）。

**根因**：功能代码没坏，是它们共用的原语全变了——侧边栏对话不再是 `<a href="/c/…">`、消息没有
`data-message-*`、几乎所有 `data-testid` 消失、回合行 `div[data-turn-key]` 视口外整轮卸载不留占位、
滚动容器变成 `column-reverse`、对话数据改为分页接口、输入框没有 `#prompt-textarea`、代码块没有 `<pre>`、
深色标记变成 `data-theme`。

**修法**（全部在适配层，详见 `docs/CHATGPT-DOM-ADAPTER.md`）：
- `shared/domCompat.ts`（新）：把旧钩子补回新 DOM——侧边栏隐藏 `/c/` 链接、消息角色 / id / 正文、
  顶栏与侧边栏 `…` 的 testid、菜单项 testid（按 `aria-labelledby` 归属）、输入框标记、发送 / 停止按钮。
- `pageWorld/threadMirror.ts`（新）：读 React 虚拟列表，为每个已加载回合写不可见的定位锚点；
  时间轴选锚点、读 `data-gv-text` / `data-gv-attachments`，`getScrollBounds()` 支持倒序滚动。
  这同时修掉了 issue #20（滚到第一问后中间节点缺失）：分页加载的每一页都会进锚点。
- `conversationHook` + `ConversationCaptureService`：抓分页接口、按 `before` 游标拼页、维护 `complete`；
  整段导出在缓存不完整时跳到顶部等分页加载（长对话不再因步数上限失败），`CachePrimer` 只在完整时剪枝。
- 温和深色：调用官方主题生成函数（`736644.*.js` 模块 `jbn` 导出的 `f`）以 ChatGPT 主题 + surface=#1f1f1e
  算出整套 token，去掉强调色和主按钮配色后写进样式（未分层样式压过 `@layer theme`）。
- 文件夹挂到面板置顶头部；菜单项用 `cloneAppShellMenuItem` 深克隆；侧边栏宽度改 `--app-shell-left-panel-width`（1.8.15 撤回，见上一条）；
  代码块折叠 / Mermaid / 按需加载探测认 `[data-markdown-copy="code-block"]`；顶栏各功能认 `header[data-app-shell-titlebar]`；
  时间轴常驻元素 z-index 降到 45（低于 ChatGPT 菜单）。
- `shared/domHealth.ts`（新）：`__gvDomHealth()` 体检。

**验证**：browser-harness 真机——18 问的分页长对话滚到顶，节点 5→10→15→18 跟随；点第 2/4/10/17/1 个节点落点偏差 0px；
整段导出清掉缓存后 10s 拿到 18 问 18 答；文件夹、菜单、顶栏按钮、代码块折叠、Mermaid、引用回复、选择导出通过。
全量 vitest 失败集合与改动前逐条一致（95），新增 30 个测试。

**没测到**：需要真的发消息的路径（流式输出中的时间轴追加、发送行为、回复完成通知、草稿、临时聊天退出）、fork、canvas 导出。
侧边栏拖进文件夹当时是坏的，1.8.15 修复（见上）。

### 2026-08-08 — ChatGPT 改了 KaTeX 渲染，三条公式复制路径全断

**症状**：点公式没反应（无 toast、剪贴板不变）；拖选 + Ctrl+C 复制到的是渲染字形
（`f \n′\n (x)`）而不是 `$f'(x)$`；原生「复制消息」按钮的定界符修复也失效。

**根因（browser-harness 实测）**：ChatGPT 的 client-side KaTeX 布局**不再输出任何
MathML**。整页 `annotation` / `.katex-mathml` / `<math>` 全部为 **0**，而所有提取器都只认
`annotation[encoding="application/x-tex"]`。真正的 TeX 搬到了**包在外层**的语义节点上：

```
<span role="math" aria-label="f'(x)" data-math-source="f'(x)" data-client-katex-layout
      [style="display:block"]>          ← display 公式才有 inline style
  [<span class="katex-display">]        ← display 公式才有
    <span class="katex">
      <span class="katex-html" aria-hidden="true">…字形…</span>
```

实测计数（429 个 `.katex`）：`data-math-source` 430、`role=math` 430、`annotation` 0。
**关键点：源在 `.katex` 的祖先上**，所以只能 `closest()`，`querySelector()` 永远找不到。

**修法**（隔壁 gemini-voyager `fef895c7` 只改了点击复制这一条，这里三条都得改）：

| 路径 | 文件 | 改动 |
| --- | --- | --- |
| 点击公式 | `src/features/formulaCopy/FormulaCopyService.ts` | `extractLatexSource` 改为委托给共享的 `recoverMathSource`；`findMathElement` 增加 `[role="math"]` 兜底；`isDisplayMode` 双向找 `.katex-display` |
| 拖选 / 引用回复 | `src/core/utils/latexFromDom.ts` | `recoverMathSource` 新增 `data-math-source`（self / closest / 后代）；`MATH_CONTAINER_SELECTORS` 把 `[data-math-source]`、`[role="math"]` 排在最前（外层优先，整块塌成一个 `$$…$$`）；`isDisplayMath` 增加「后代有 `.katex-display`」判断 |
| 原生复制按钮 | `src/pages/pageWorld/clipboardLatexFix.ts` | `collectSources()` 增加 `[data-math-source]`，否则源集合为空 → 直接放行未修复的载荷 |

**抗下次改版的兜底**（`recoverSourceHeuristically`）：ChatGPT 已经搬过两次源，所以最后
加了一层**按值的形状而不是属性名**来找源的启发式——在 node 自身 + 最多 4 层 inline 祖先
（遇到块级元素就停，绝不去读外层 `<p>` 的属性）上，取第一个满足下列之一的属性值：
含 TeX 特征字符 `[\\^_{}]`，或与同元素 `aria-label` **完全一致**（名/值互证）。
`aria-label` 单独作为源时**必须**含 TeX 特征字符——MathJax 之类会把 `aria-label` 写成朗读
文本（"f prime of x"），加这道闸才不会把散文当公式复制。`data-start` / `data-end` /
`data-state` 等记账属性在忽略名单里。宁可返回 null（表现同今天：点了没反应），
也不要**静默复制错的东西**。

**实测**（`browser-harness`，真实系统剪贴板 + 真 Ctrl+C）：
- 拖选 → `…求 $f'(x)$ 的 series、再用 geometric 求 $f'(1/6)$。`
- 点公式 → `$$a_n=(-1)^n 2^{1/n}$$`
- 原生按钮：在补丁**上面**再包一层 spy 拿到 ChatGPT 的原始载荷，`(f'(x))` / `[\boxed{…}]`
  → 落到剪贴板是 `$f'(x)$` / `$$\boxed{…}$$`，证明是我们修的，不是 GPT 自己改好了。

**已知遗留**：单字符公式（源是 `0`、`1`、`N` 这种纯字母数字）在原生按钮路径仍保持
`(0)` 不修——这是 `looksLikeMath` 故意的取舍，否则散文里的 `O(N)` 会被改成 `O$N$`。
拖选和点击这两条路不受影响（它们替换的是真实 DOM 节点，不做文本匹配）。

**测试**：`bunx vitest run src/core/utils/ src/features/formulaCopy/ src/pages/pageWorld/`。
全量 `bunx vitest run` 是 98 红，**改动前后逐条 diff 完全一致**（都是过期的 Gemini 时代断言）。

### 2026-08-08 — issue #8：顶栏「加入文件夹」按钮（默认关闭 + 按需加载）

**背景**：1.7.4 及更早版本在对话顶栏**最左侧**有一个文件夹按钮，点一下就能把当前对话
归到文件夹里。2026-07 的顶栏改版把它弄没了，反馈者退回 1.7.4 也没能恢复。
（正是因为这个入口早就不在了，issue #7 那个弹窗才「几乎没人见过」。）

**做法**：单独一个模块 `src/pages/content/folderHeaderButton/index.ts`，
生命周期照抄 `conversationExport/topBarButton.ts`（generation 计数 + 防抖 +
只盯 header 的 MutationObserver，路由切换后重新注入）。

- **默认关闭**，开关 `gvFolderHeaderButtonEnabled`，弹窗「文件夹」分区里。
- **关闭时整份模块不下载**：注册成 `bootstrap/features.ts` 里的 lazy feature，
  `isEnabled` 为假就不会走到那句 `import()`。实测关闭状态下
  `performance.getEntriesByType('resource')` 里根本没有那个 chunk；打开后
  **0.8 秒内**注入，无需刷新页面。
- 点击调用新增的公开入口 `FolderManager.openMoveToFolderDialogForCurrentConversation()`
  （模块不碰 manager 私有成员），弹出的就是 #7 里美化过的那个框。
- 不在对话页（`/`、`/library` 等）时按钮自行移除，避免打开一个没有对话可归的框。

**顶栏左侧锚点**（`shared/headerActionSlot.ts` 新增 `findHeaderLeftSlot()`，实测 2026-08）：

```
header#page-header                     flex, justify-between
  ├ div.absolute.start-1/2 …           居中的「聊天/工作」切换器（position:absolute）
  ├ div.flex.flex-1.items-center       ← 左侧组
  │   └ div.translucent-surface…       GPT 自己的左侧按钮簇（边栏展开时为空）
  └ div[data-testid="thread-header-right-actions-container"]
```

按 `position !== 'absolute'` 跳过居中切换器（而不是去匹配它的类名），
然后**追加在** GPT 自己那簇按钮之后——这样边栏收起时它自己的按钮位置不变。
左侧展开状态下没有按钮可以抄样式，所以 `styleSource` 回落到右侧的「…」按钮
（同一个顶栏、同样的 36×36 图标按钮规格）。

**实测**：关闭→无按钮且无 chunk 请求；打开→0.8s 注入、位置在 header 最左
（rect 左边缘 70，header 左边缘 62）、图标是 SVG、`aria-label` 为「移动到文件夹」；
点击弹出的框标题「移动到文件夹」、图标是 SVG、`mat-icon` 0 个。
单测 `src/pages/content/folderHeaderButton/__tests__/`（7 条）。

### 2026-08-08 — 新增「Desmos / 计算器」复制格式（复制的公式粘不进 Desmos）

**症状**：公式复制修好之后，复制出来的东西**粘不进 Desmos**，把「不带美元符号」开关打开也没用。

**实测**（desmos.com，真 Ctrl+V，逐条隔离）：MathQuill 的粘贴是**全有或全无**——
整串里只要有一个它不认识的命令，**整条粘贴直接丢弃，输入框一片空白**。

| 结果 | 命令 |
| --- | --- |
| 整条被拒 | `\displaystyle` `\qquad` `\;` `\!` `\limits` `\boxed{}` `\text{}` `\nabla` `\begin{…}` `\cap` |
| **粘进去但是错的** | `\,` → 变成一个**逗号**（`\int_0^1 x^2\,dx` 落地成 `x^{2},dx`） |
| 正常 | `\frac \sqrt \left \right \cdot \to \sum \int \infty \mid \Gamma \operatorname \mathbf` 和 `\ `（反斜杠空格） |

`$` 也一定进不去（Desmos 直接报「无法理解"$"符号」），所以默认的 `latex` 格式天然就不行。

**修法**：新增第五种复制格式 `desmos`（`src/features/formulaCopy/desmosLatex.ts`），
在 `no-dollar` 的基础上再去掉**纯排版、不带任何数学含义**的命令：间距类
（`\, \; \: \! \ \quad \qquad \hspace{}` …）、样式类（`\displaystyle \limits` …），
并把 `\boxed{X}` 拆成 `X`（花括号配平扫描，不配平就原样返回，绝不截断）。

**故意不做**：`\text{}`、`\nabla`、矩阵、`\begin{aligned}` 一律不动。它们是真正的数学内容，
Desmos 没有对应写法，硬编一个替代品等于**悄悄改了公式**——让它粘不进去才是诚实的结果。

**实测结果**：同一批 ChatGPT 公式，转换前 16 条里 9 条被拒；转换后抽出的 10 条
**全部粘贴成功**（含之前完全进不去的 `\displaystyle …` 和 `\boxed{\displaystyle …}`），
且 `\,` 不再变成逗号。端到端也验过：切到 desmos 格式后点公式，剪贴板里就是可直接粘的串。

### 2026-08-08 — issue #7：「移动到文件夹」弹窗里每行都印着紫色的 "folder"

**根因**：弹窗行的图标是 Gemini 时代遗留的 Material 连字
（`<mat-icon class="google-symbols">folder</mat-icon>`）。Gemini 页面自带那套图标字体，
ChatGPT 没有，于是连字退化成**字面量 "folder"**；而 CSS 又给它钉死了 16px 宽却没有
`overflow:hidden`，文字就横着压到文件夹名上。
侧边栏没这个问题是因为 `.gv-folder-container mat-icon { display:none }` 把连字藏了——
**而这个弹窗是挂到 `document.body` 的，不在那个作用域里**。

**修法**：
- 新增 `src/pages/content/folder/folderIcon.ts`（`createFolderSvgIcon`），
  `moveToFolderMenuItem.ts` 里原有的那份 SVG 抽出来共用；弹窗行改用真 SVG。
- `contentStyle.css`：`.gv-folder-dialog-item mat-icon` 换成 `.gv-folder-dialog-item-icon`
  （含深/浅色 token），并补一条 `.gv-folder-dialog mat-icon, .gv-folder-dialog .google-symbols
  { display:none !important }` 作为其它遗留连字的安全网。
- `src/locales/zh/messages.json`：这一段 folder 相关的 key 一直是英文原文，
  中文界面上弹窗标题显示 "Move to folder"。补了 `移动到文件夹` 等 7 条翻译。

**实测**：在真实页面上按新代码的结构挂了一遍弹窗——图标 15×15、`rgb(167,139,250)`、
图标右边缘 377 < 文字左边缘 387（不再重叠），故意塞的遗留 `mat-icon` 行 `display:none`。

### 2026-08-08 — 「移动到文件夹」菜单项在当前 ChatGPT 上根本注入不出来

**症状**：侧边栏和顶栏的「…」菜单里都没有「移动到文件夹」
（`.gv-move-to-folder-btn` 计数 10 秒内一直是 0），而**同一个菜单**里我们注入的
「Export chat」是在的。所以上面那个弹窗几乎没有入口。

**排查**：在页面里镜像了一遍 `isOwnedNativeConversationMenu` 的每一项判据，在菜单被插入
的那一刻打快照——`isElementOpen` ✓、markers 2 ✓、`aria-labelledby` === trigger.id ✓、
`aria-expanded="true"` ✓，唯独 **`data-gv-native-menu-token` 是 `null`**。

**根因**：ChatGPT 的 Radix 菜单是 **`pointerdown` 就打开**的，而我们的监视是挂在
`click`（capture）上的。等 click 派发时菜单**早就挂上 DOM 了**，于是它落进
`createNativeMenuOwnershipSnapshot` 的 `existingMenus` 快照里，
`isOwnedNativeConversationMenu` 第一行 `existingMenus.has(menu)` 直接判它"不是我们的"
——**永远拿不到那个菜单**。而且插入之后只剩一条 `style` 属性变更，
`inspectCandidates` 再也不会被触发，只能干等超时。

**修法**（两处，都必须）：
- `nativeConversationBridge.ts`：`existingMenus.has(menu)` 不再单独否决，
  改成 `existingMenus.has(menu) && !isNativeConversationMenuBoundToTrigger(menu, trigger)`。
  绑定校验要求 trigger 当前是展开的、并且 `aria-controls`/`aria-labelledby` 明确指向这个
  菜单，比"它是新出现的"更强，所以放宽这一条不会误抓别的菜单。
- `manager.ts` `startOwnedNativeMenuWatch`：装完 observer 后**立刻把当前已开的会话菜单
  塞进 candidates 并跑一次 `inspectCandidates()`**——菜单可能在 click 之前就开好了，
  后面不会再有任何 mutation。

**实测**：热重载后走顶栏「…」→ `.gv-move-to-folder-btn` **0.6 秒内注入**，文案「移动到文件夹」、
图标是 SVG；点进去弹窗标题「移动到文件夹」、2 行文件夹、`mat-icon` 0 个、图标与文字不重叠、
按钮「取消」。回归测试 `src/pages/content/folder/__tests__/nativeMenuOwnership.test.ts`（4 条）。

**注意**：合成的完整 click（mousePressed+mouseReleased）在 Radix 上会「开了又关」，
因为 pointerdown 开、click 再 toggle 一次。验证时用 JS 直接 dispatch
`pointerdown/mousedown/pointerup/mouseup/click` 更稳。

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
- **被测窗口必须可见**（2026-09-25）：Windows 上 Chrome 窗口被完全遮挡 / 最小化时 `visibilityState=hidden`，
  停止渲染：`Input.dispatchMouseEvent`、`Page.captureScreenshot` 会一直挂到 IPC 超时，IntersectionObserver
  不触发（ChatGPT 不分页加载），隐藏超过 5 分钟后定时器被压到约每分钟一次。用 CDP 把窗口先最小化再还原即可
  提到前台；不要用系统级置顶。读 DOM / 派发 DOM 事件在后台照常可用（Radix 触发按钮要派发 `pointerdown`，
  插件自己的按钮用 `.click()`）。
- 页面弹出 `alert()` 时所有 `Runtime.evaluate` 都会挂住：`Page.enable` 后监听 `Page.javascriptDialogOpening`，
  用 `Page.handleJavaScriptDialog` 关掉。
- 测导出不落盘：`Browser.setDownloadBehavior(deny)`，在扩展的 isolated context（`Runtime.executionContextCreated`
  里 `auxData.type=isolated` 且 origin 是扩展）hook `URL.createObjectURL` 读 Blob 文本，测完恢复 `default`。
- 在 Windows 上用 Python 改源码要 `open(..., newline="\n")`，否则写出 CRLF。
- 稍复杂的页面脚本写进文件再 `js(open(path, encoding="utf-8").read())`，别塞在 `-c '...'` 里（引号 / 反斜杠层层转义，经常语法错）；
  单次 `js()` 超过约 5 秒会 IPC 超时（页面里的脚本还会接着跑完），长流程拆成几次调用。
- `chrome.runtime.reload()` 之后至少等 4 秒再刷新页面；太快会出现「样式注入了但功能没启动」的半启动状态，别当成 bug 追。
- **验证注入的 UI 用命中测试**：`document.elementFromPoint(中心点)` 是否命中按钮本身，或用 CDP 真实鼠标
  （`Input.dispatchMouseEvent`，窗口要在前台）。DOM `.click()` 绕过命中测试，1.8.14 的顶栏按钮、侧边栏手柄就是这样漏测的。
- 拖动：dnd-kit / 普通指针拖动可以用 CDP 真实鼠标逐步 `mouseMoved`；ChatGPT 的侧边栏拖动手柄可用合成 `PointerEvent`
  驱动（按下 → `setTimeout 0` → 移动 / 松开，同步连发不生效）。
- **卡顿排查**（1.8.15 图标栏动画卡成幻灯片就是这样查的）：
  1. 页内 rAF 记帧间隔 + `PerformanceObserver('longtask')`；
  2. CDP `Profiler` 按 URL 汇总 self time，看 JS（扩展 / ChatGPT）占比——几乎全是 `(program)` 说明是渲染管线；
  3. `Tracing`（`devtools.timeline`）看 `UpdateLayoutTree` 的 `elementCount` 和耗时，上万个元素 = 整页重算；
  4. 加 `disabled-by-default-devtools.timeline.invalidationTracking` 看是谁让整页失效（`allDescendantsMightBeInvalid`）；
  5. MutationObserver 记根节点 `style` 的变化，看 ChatGPT 有没有被触发去改继承变量。
- 测设置类功能：在扩展 options 页 target 里读 `chrome.storage.sync` 存快照 → 逐项写测试值 → 量计算样式 → 按快照还原，
  **快照里没有的键要 `remove`**（不能写回默认值）。popup 能否渲染：把 popup 页开成后台 target 读 DOM。
- 发公告：`node scripts/announcement-manager.mjs publish < /dev/null`，发完用
  `gh api repos/TanChuping/chatgpt-voyager-support/contents/announcements.json` 取回比对；**同一个 id 改内容不会重新弹**，
  适合补链接 / 改错字。别 `require()` 这个脚本（会启动交互式 CLI 挂住）。
- 出版本：`bun run build:chrome` + `node scripts/pack-chrome.cjs`（→ `store_packages/`），`bun run build:firefox` +
  `node scripts/pack-firefox.cjs`（→ `firefox_release/`）；GitHub Release 两个包都挂上（`gh release create vX.Y.Z ... <zip> <xpi>`）。
