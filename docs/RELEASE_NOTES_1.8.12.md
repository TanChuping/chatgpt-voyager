# v1.8.12 — 聊天宽度调整修复

- 修复窄窗口、分屏或页面缩放时，聊天宽度滑块在较大数值区间调整没有可见变化的问题（#21）。
- 聊天宽度现在按当前聊天区域的可用宽度计算，保留 ChatGPT 原生居中布局。100% 表示铺满可用区域，较小数值会相应收窄。
- 本版本不包含 #20 时间线历史节点缺失的修复；该问题仍在跟进。

## Verification

- Real Chrome: ChatGPT → floating button → settings → width slider. At the same viewport, 69% produces 872px and 100% produces 1264px, centered with no horizontal overflow.
- Chat-width regression tests and TypeScript check passed.
- Chrome and Firefox production packages built.
