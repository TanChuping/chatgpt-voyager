# v1.8.14 — 适配 ChatGPT 9 月新界面

- 适配 ChatGPT 2026-09 改版（Codex 新外壳）：时间线、文件夹、导出、温和深色、侧边栏宽度、长代码块折叠、Mermaid 渲染、引用回复等功能恢复正常。
- 时间线：打开长对话后往上滚动加载更早的历史，每个提问都会补上节点，点击节点准确跳到对应提问（#20）；附件标记恢复显示。
- 温和深色：改用 ChatGPT 官方主题算法生成整套配色，层次与官方「自定义背景」一致。
- 导出：长对话分页加载时，「整个导出」会先自动加载全部历史，不再漏掉前面的内容。
- 文件夹：面板回到侧边栏顶部；「移动到文件夹」「导出对话」菜单项样式与原生菜单一致。
- 时间线不再盖住 ChatGPT 自己的菜单。

## Verification

- Real Chrome (browser-harness) on the 2026-09 layout: an 18-prompt paginated conversation scrolled to the top grew the timeline 5 → 10 → 15 → 18 nodes; clicking nodes 2/4/10/17/1 landed each prompt at the top of the viewport (0 px error).
- Whole-conversation export with the page cache cleared paged in the full history in ~10 s and exported 18 prompts / 18 replies; selection export, sidebar and header menu items, header buttons, folder panel, code block collapse, Mermaid, quote reply and sidebar width verified live.
- Full vitest run: the failing set is identical to the 1.8.13 baseline (95 pre-existing), 30 new tests pass. TypeScript check and Chrome production build pass.
- Not exercised: paths that require sending a message (live timeline append while streaming, send behavior, completion notification, draft save, temporary-chat exit), fork, canvas export.
