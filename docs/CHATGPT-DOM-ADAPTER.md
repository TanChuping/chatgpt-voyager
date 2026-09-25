# ChatGPT DOM 适配层（2026-09 起）

> 一句话：**插件的功能不直接依赖 ChatGPT 的 DOM，只依赖十几个「原语」；原语全部集中在适配层。**
> ChatGPT 改版时先跑体检 `__gvDomHealth()`，哪个原语失效就只修适配层里对应的那一处，功能层一般不用动。

2026-09-25 ChatGPT 换成 Codex 外壳（Chat/Work 共用一套 app shell），二十多个功能同时失效。
逐个排查后发现功能代码本身几乎都没问题，坏的是它们共用的几条路：侧边栏链接、消息角色、
顶栏 `…` 按钮、回合 DOM、对话数据接口、输入框、代码块、主题标记。把这几条路在适配层补回去，
大部分功能就一次性恢复了。本文档记录这套分层、每个原语当前的真实结构，以及下次改版的排查顺序。

---

## 分层

```
ChatGPT 页面（会变）
 │
 ├─ MAIN world（能读 React 内部状态、能包 fetch）
 │    src/pages/pageWorld/conversationHook.ts   抓 /backend-api/conversation(s) 的响应 → postMessage + sessionStorage
 │    src/pages/pageWorld/threadMirror.ts       读 React 虚拟列表 → 给每个已加载回合写一个不可见锚点
 │    src/pages/pageWorld/fiberReader.ts        2026-07 布局的 fiber 兜底（新布局读不到消息，保留给旧布局）
 │    ⚠ 这个 bundle 里的文件**不能 import 任何与 content script 共享的模块**：一旦产生共享 chunk，
 │      构建会把它改成用 chrome.runtime.getURL 动态加载，而 MAIN world 没有 chrome.runtime，
 │      整个脚本（包括抓包）会静默失效。常量请复制一份并注明要保持同步。
 │
 ├─ Isolated world 适配层（content script）
 │    src/pages/content/shared/domCompat.ts        把新 DOM「翻译」回旧钩子（最优先的修法）
 │    src/pages/content/chatgptDom.ts              所有「找 ChatGPT 元素」的查询函数
 │    src/pages/content/shared/headerActionSlot.ts 顶栏按钮插槽
 │    src/pages/content/timeline/threadAnchors.ts  读 threadMirror 写的锚点
 │    src/pages/content/shared/nativeMenuItemTemplate.ts  克隆原生菜单项（cloneAppShellMenuItem）
 │    src/pages/content/shared/domHealth.ts        一键体检
 │
 └─ 功能层：时间线、文件夹、导出、引用回复、代码块折叠、Mermaid……
      只认上面的稳定钩子（data-gv-*、补回来的 data-testid / data-message-*），不直接写 ChatGPT 的类名
```

---

## 原语对照表（改版后逐行核对）

| 原语 | 2026-09 真实结构 | 适配方式 | 依赖它的功能 |
| --- | --- | --- | --- |
| 主题标记 | `<html data-theme="dark">`，**没有** `.dark` 类 | 温和深色直接用 `[data-theme="dark"]` 选择器 | 温和深色 |
| 主题色板 | `<style data-codex-app-themes>` 里 `@layer theme` 的 `--app-color-*` / `--codex-base-*`，由官方生成函数从 {surface, ink, accent, contrast} 算出；其它 surface token 都引用它们 | 用**官方生成函数**以 surface=#1f1f1e 算出的值覆盖（未分层样式天然压过 `@layer`，不需要 `!important`）；去掉强调色相关和主按钮配色 | 温和深色 |
| 侧边栏面板 | `#app-shell-sidebar`（图标栏 + 面板）里的 `nav[role="navigation"]`，含置顶头部 + `[data-app-action-sidebar-scroll]` 滚动区 | `chatgptDom.findChatGptSidebar()` 优先返回面板 nav | 文件夹、侧边栏宽度 |
| 侧边栏对话行 | `[data-sidebar-chatgpt-conversation-key="chatgpt:conversation:<uuid>"]`，行内是 `[role=button][aria-label=<标题>]`，**不再是 `<a>`** | `domCompat` 给每行塞隐藏的 `a[data-gv-conv-link][href="/c/<uuid>"][title]`；`getChatGptConversationElement` 优先认行元素 | 文件夹、移动到文件夹、侧边栏导出、批量删除 |
| 侧边栏宽度 | `aside.app-shell-left-panel` 宽 `var(--app-shell-left-panel-width)`，**由 ChatGPT 自己管**：拖动手柄 `aside > div > [role="separator"]`（只在展开时渲染）、收起到图标栏、开合动画；当前尺寸写在内层 div 的内联 `width` | **不要用 CSS 覆盖**（会钉死宽度、收起失效；宽泛选择器还会把手柄撑满、盖住整个侧边栏——1.8.14 的事故）。设置宽度 = 对原生手柄重放一次拖动；用户拖动后写回设置 | 侧边栏宽度 |
| 侧边栏拖动 | 对话行是 ChatGPT 自己的 dnd-kit 拖拽项（拖进项目）：按下后 window 上的 `dragstart` 被 `preventDefault`，HTML5 拖动起不来；拖动时 ChatGPT 画 `position: fixed` 的幽灵行 | 不设 `draggable`；`folder/appShellRowDrag.ts` 跟着 ChatGPT 的指针拖动，在文件夹面板上重放成 HTML5 `dragover` / `drop`（同一份 JSON 负载），已有落点逻辑不用改 | 拖对话进文件夹 |
| 图标栏 | 侧边栏面板左边的 `nav[data-app-navigation-rail]`（52px：主页、历史、库、图片、…、帮助、头像）；面板收起时只剩它；面板头部的按钮行以 ChatGPT 自己的收起按钮 `#app-shell-sidebar button[aria-controls="app-shell-sidebar"][aria-expanded="true"]` 为锚点（文字随语言变，这个属性不变）；**面板收起后，图标栏顶部的「显示侧边栏」按钮带同样的 `aria-controls`，但 `aria-expanded="false"`**，不能当锚点 | `railToggle` 在按钮行开头插紧凑按钮；收起 = 给图标栏和背后的页面卡片（`[data-app-shell-workspace-row] > [class*="PageSurface-"]`，它的左边缘跟着图标栏宽度）打 `data-gv-rail-folded`：图标栏**保持 52px 宽但脱离文档流**；面板保持原宽度左移，整个侧边栏变窄、对话区拿走这 52px——ChatGPT 自己不让面板窄于约 290px，所以只能覆盖：只给读 `--app-shell-left-panel-width` 的三个元素（aside、它的内容包裹层、顶栏 start 插槽）打属性写 `width: calc(var(--app-shell-left-panel-width) - var(--app-shell-navigation-rail-width))`，从 ChatGPT 自己的宽度算，拖动和收起照常；窄于 768px 时 ChatGPT 改成浮层侧边栏、该变量归零，不收；动画只用 transform/opacity（FLIP）；是否允许收起在 JS 里判断——面板展开（有拖动手柄）**并且**我们的 ▶ 按钮真的在面板里，ChatGPT 改版导致按钮放不进去时什么都不收，永远有路回来；按钮用 `data-size="xs"`——ChatGPT 的面板最小宽度会跟这一行的内容走 | 图标栏收起按钮 |
| 顶栏 | `header[data-app-shell-titlebar]`，**整条 `pointer-events: none`**，只有 ChatGPT 自己的 `pointer-events-auto` 包裹层能点；开头是侧边栏上方的 start 插槽（也带 `[data-app-shell-header-obstacle]`），主标题栏 `[data-app-shell-main-titlebar]` 里右侧 `ms-auto` 组放分享和 `…`；`…` 是其中最后一个 `button[aria-haspopup="menu"]` | `domCompat` 在对话页补 `data-testid="conversation-options-button"`（同步打标签）；右侧插槽在 `…` 所在的 `pointer-events-auto` 行里；**左侧插槽**是插在主标题栏开头的自有 `div[data-gv-header-left-slot]`（`pointer-events: auto`）；各功能的 MutationObserver 要认 `header[data-app-shell-titlebar]`（`findHeaderActionsRoot()`） | 导出按钮、公告、顶栏文件夹/重命名/标题 |
| 菜单 | Radix `[role="menu"][aria-labelledby=<触发按钮 id>]`；菜单项内部 `div > span > span > [span.leadingIcon-*, span.truncate]`；没有 testid | `domCompat` 按 `aria-labelledby` 确认归属后，多语言文字匹配补 `delete/share/rename-chat-menu-item`；注入菜单项用 `cloneAppShellMenuItem` 深克隆原生项再换图标和文字 | 移动到文件夹、导出菜单项、批量删除 |
| 回合行 | 每轮问答一个 `div[data-turn-key=<用户消息 id>]`；**视口外整轮卸载、不留占位**；更早的历史滚到顶才分页加载 | `threadMirror` 读 React 虚拟列表 `props.entries` + 布局 ref `{turnKeys, topOffsetsPx, heightsPx}`，在列表容器里写 `div[data-gv-thread-anchor][data-turn-id][data-gv-text][data-gv-attachments]` | 时间线、收藏跳转、附件标记 |
| 消息块 | `[data-chatgpt-search-unit-key$=":user"|":assistant"][data-chatgpt-search-message-ids]`；用户气泡 `[data-user-message-bubble]`；回答正文 `[data-markdown-text-style="assistant-message"]`；回答的消息 id 在 `[data-chatgpt-selection-message-id]` | `domCompat` 补 `data-message-author-role` / `data-message-id` / `data-message-content` | 导出（选择 / 实时采集）、fork、回答图片操作、用户 LaTeX |
| 滚动容器 | `.thread-scroll-container`，`flex-direction: column-reverse`：**scrollTop 0 = 底部，往上是负数** | 时间线 `getScrollBounds()`、导出 hydrator `scrollBounds()` 识别倒序 | 时间线跳转、导出加载历史 |
| 对话数据 | `GET /backend-api/conversations/<id>?num_turns=N`（最新一页），`GET …/<id>/messages?before=<消息 id>`（更早一页）；`messages[]` 按时间排序，带 `page_info.has_previous_page` | `conversationHook` 抓两种接口；`ConversationCaptureService` 拼页并维护 `complete`；缓存不完整时导出先跳到顶部等分页加载完 | 整段导出、时间线文本缓存 |
| 对话栏宽度 | 转写区 `[class*="transcriptContent-"]` 和输入框外层两个宿主各自写 `--thread-content-max-width: var(--thread-content-responsive-max-width, inherit)`，下面所有东西（消息、操作栏、表格列宽、输入框）都用它；默认 48rem；消息文字字号来自 `--codex-chat-font-size`（`.text-size-chat`） | 对话宽度在两个宿主上设 `--thread-content-responsive-max-width`（`cqi`，输入框减滚动条槽宽）；输入框宽度只覆盖输入框宿主（选择器更具体）；宿主选择器和槽宽测量在 `chatgptDom.ts`；字号按比例放大 `--codex-chat-font-size` | 对话宽度、输入框宽度、对话字号、代码字号、段落间距 |
| 输入框 | 主输入表单内 `.ProseMirror[contenteditable][role="textbox"]`；提交按钮 `button[type="submit"]`（生成中变停止） | `domCompat` 给带 `[data-composer-navigation-target]` 的表单补 `data-type="unified-composer"`、编辑器补 `#prompt-textarea`、按钮补 `send-button` / `stop-button` | 提示词插入、引用回复、发送行为、纯文本输入、输入框折叠、草稿 |
| 代码块 | `[data-markdown-copy="code-block"]` > 标题栏 `[data-markdown-copy="exclude"]`（语言名在 `.truncate`）+ 代码区 `div > code`，**没有 `<pre>`**；原生按钮外包 `display: contents` 的 span | 各功能的代码块选择器加上新结构；折叠状态改用 `data-gv-code-collapsed` 属性（React 会重写 className） | 长代码块折叠、Mermaid、按需加载探测 |
| 公式 | `[data-math-source]`（2026-08 起未变） | — | 公式复制 |

---

## 改版后的排查顺序

1. **体检**：在 ChatGPT 对话页打开 DevTools，把 console 的执行上下文切到「GPT-Voyager」，运行 `__gvDomHealth()`。
   （browser-harness：`Runtime.enable` 拿到扩展的 isolated context，在里面 evaluate `__gvDomHealth()`。）
   输出表里 `ok: false` 的就是要修的原语，`features` 列是受影响的功能。
2. **只修适配层**，按优先级：
   1. 能把旧钩子补回去的，改 `domCompat.ts`（一处修好，整串功能恢复）；
   2. 结构或行为真的变了（比如倒序滚动、虚拟化不留占位、接口分页），改对应的适配文件
      （`chatgptDom.ts` / `threadMirror.ts` / `conversationHook.ts` / `headerActionSlot.ts`）；
   3. 功能层只在「功能自己直接写了 ChatGPT 类名 / testid」时才动，并顺手把那个查询挪进适配层。
3. **验证**：
   - `npx vitest run src/pages/content/shared src/pages/pageWorld src/features/conversationApi src/pages/content/timeline`
   - 真机 browser-harness 回归：时间线（滚到顶后节点数 = 提问数、点节点落点）、文件夹面板位置和菜单项、顶栏按钮、整段导出、代码块折叠，
     以及**原生交互没被挡住**：侧边栏能点（`elementFromPoint` 命中对话行）、能切换对话、能拖宽、能收起、能把对话拖进文件夹。
4. 在本文件对照表里更新「真实结构」列，在 `docs/DEV-LOG.md` 变更历史加一条。

---

## 垫片为什么是安全的

- **只加属性和自己的子元素**：React 不管理它不认识的属性，重渲染不会清掉；`className` 归 React 管，
  所以插件状态一律不用 class，用 `data-gv-*`。被重建的节点在下一轮同步里重新打标签。
- **归属靠结构，不靠文字**：菜单归属看 `aria-labelledby`，文字匹配只用于给已确认归属的菜单项打标签；
  输入框只认带 `[data-composer-navigation-target]` 的表单，编辑消息的内联编辑器不会被误认。
- **同步时机**：Radix 在 `pointerdown` 打开菜单、功能在随后的 `click` 里检查，所以菜单和顶栏 `…`
  在 MutationObserver 回调里**同步**打标签；其余走 60ms 防抖。只监听元素插入和 ChatGPT 自己的
  id / 标题属性，自己写的属性不会触发自己。
- **别触发整页样式重算**：页面约 2.7 万个元素，整页重算一次约 200ms。插件状态不要挂在 `<html>` / `<body>` 的属性上（配合 `:has()` 时 Chrome 直接把整页标成失效）；也不要改变 ChatGPT 用 ResizeObserver 监视的元素尺寸——图标栏的宽度会被写进根节点的继承变量 `--app-shell-navigation-rail-width`，每写一次整页重算。动画一律 transform / opacity。（1.8.15 第一版图标栏收起按宽度做动画，帧间隔 200ms+，改成 FLIP 后回到刷新率。）
- **往 ChatGPT 顶栏里放东西要自带 `pointer-events: auto`**：新顶栏整条是 `pointer-events: none`，
  继承下来的按钮看得见、点不着（1.8.14 的顶栏文件夹/重命名就是这样，DOM `.click()` 测不出来，要用 `elementFromPoint` 或真实鼠标验证）。
- **不和 ChatGPT 抢它自己管的状态**：像侧边栏宽度这种 ChatGPT 有原生交互（拖动、收起、动画）的布局，
  不写 `!important` 覆盖，而是通过它自己的控件设置。
- **不改 ChatGPT 的行为**：`threadMirror` 只读 React 状态；锚点放在列表容器里，`visibility: hidden`、
  `pointer-events: none`，不影响布局和选择。
- 旧布局（2026-07）上新钩子都不存在，所有新增逻辑自动不生效，旧路径照常工作。

---

## 已知限制

- 从未渲染过的回合，位置用的是 ChatGPT 自己的估算高度（280px）；跳转后 ChatGPT 实测高度、
  锚点随之更新，时间线的收敛校正会把落点对准（实测 0px 偏差）。
- 更早的分页在用户滚到顶之前 ChatGPT 自己也没加载，时间线不会显示这部分节点；滚到顶后自动补齐。
- 窗口在后台或被完全遮挡时，Chrome 停止渲染并节流定时器：分页加载、锚点同步会推迟到切回前台，
  真实鼠标事件和截图也会卡住。浏览器实测时要让被测窗口可见。
