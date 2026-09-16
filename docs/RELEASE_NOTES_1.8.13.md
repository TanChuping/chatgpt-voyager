# v1.8.13 — 收藏跳转与时间线节点修复

- 修复通过收藏打开旧对话时，中间时间线节点缺失、第二个节点实际指向后续提问的问题（#20）。收藏入口现在同时传递 ChatGPT 原生消息定位参数和 Voyager 定位信息，让 ChatGPT 先加载目标所在对话，再定位。
- 在当前对话中点击尚未加载的收藏消息时，改为通过原生定位入口加载；目标已挂载时仍直接在页面内跳转。
- 时间线初始化会回放已经捕获的当前会话数据，避免错过加载期间先到达的数据。
- 保留现有收藏数据和旧式节点 ID，无需重新收藏。

## Verification

- Real Chrome: cold extension cache, ChatGPT → floating button → settings → starred messages → first favorite. All 16 user nodes were present; clicking the second dot selected the actual second message ID.
- Same-conversation favorites: a target absent from the paginated DOM loaded and positioned correctly, with all 16 nodes present. Unsent draft text survived the navigation.
- Focused regression tests: 36 passed. Related integration tests: 153 passed; the existing unrelated cache-eviction test still fails (85 versus 80), as on the pre-change baseline.
- TypeScript check and Chrome/Firefox production builds passed.
