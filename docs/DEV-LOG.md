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
| 公式复制（拖选 / 原生按钮 / 点击） | `src/core/utils/latexFromDom.ts`, `src/features/formulaCopy/`, `src/pages/pageWorld/clipboardLatexFix.ts` | 三条复制路径共用 `recoverMathSource`；2026-08 GPT 去掉了 MathML，见下方条目 + memory `latex-copy-paths` |
| 复制的公式粘不进 Desmos / 计算器 | `src/features/formulaCopy/desmosLatex.ts` | MathQuill 粘贴是全有或全无，`\displaystyle` `\,` 之类会整条丢弃，见 2026-08-08 条目 |
| 文件夹弹窗/菜单里出现字面量 `folder`、`push_pin` 等英文单词 | `src/pages/content/folder/folderIcon.ts` | Gemini 时代的 Material 连字图标在 ChatGPT 上退化成文字，见 2026-08-08 条目 |
| 注入的原生菜单项（移动到文件夹等）不出现 | `src/pages/content/folder/nativeConversationBridge.ts` | Radix 是 `pointerdown` 开菜单，click 时菜单已存在，见 2026-08-08 条目 |
| 文件夹面板 | `src/pages/content/folder/manager.ts` | 8300+ 行 |
| 深色模式 / 布局滑块 | `src/pages/content/gentleDarkMode/`, `chatWidth/`, `chatFontSize/` | 2026-07 改版后 token 选择器有坑 |
| 页面世界（MAIN world）钩子 | `src/pages/pageWorld/conversationHook.ts` | fetch/XHR 抓包 + fiberReader + 剪贴板补丁的总入口 |

### ChatGPT DOM 关键事实（2026-07 改版后，2026-07-29 实测；数学部分 2026-08-08 更新）

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
