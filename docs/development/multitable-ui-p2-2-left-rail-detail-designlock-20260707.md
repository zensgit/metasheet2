# 多维表 UI P2-2 · 左侧导航栏（表→视图树） · 细化设计锁（RATIFIED）

> 状态：**RATIFIED（owner directive 2026-07-11）**。docs-only。
> **RATIFIED — owner directive 2026-07-11**（批 12 把 merge-tree-clean 锁）。header 状态由 owner 决定翻转、Claude 机械执行(非自我批准)。锁内 per-tier owner 子决定(如变体/env-cap/storage opt-in)仍各自留待 owner。
> 前置：**UI-P2 结构锁**（`multitable-ui-p2-structure-designlock-20260706.md` §2 P2-2，RATIFIED #3742）把左侧栏列为**结构性支柱、需自己的细化锁 + Opus 对抗审阅**——本锁即是。UI-P2-1a/1b 共享原语已落；UI-P2-1c MetaToolbar 迁移已闭环。
> 模型分档：设计 = Fable/Opus；实现 = Sonnet；**结构性 → Opus 对抗审阅前置**（这不是 presentation-only）。

## 1. 原则

当前"base → 表 → 视图"挤在一条水平**标签条**（`MetaViewTabBar`）里，表多/视图多时溢出、也看不清层级。数据工作台的心智是**一棵持久可见、可折叠的 表→视图 树**（左侧栏），不是会溢出的一排标签。P2-2 把标签条升级为左侧栏——但这是**布局重构、非换皮**,所以本锁定的是"行为等价 + 对抗审阅 + consumer 平价"的硬约束。

## 2. 现状枚举（grounded，迁移必须逐一等价保留）

`MetaViewTabBar.vue`（134 行）——**唯一 consumer** = `MultitableWorkbench.vue:25`。
- **Props（7）**：`sheets` · `views` · `active-sheet-id` · `active-view-id` · `can-create-sheet` · `personal-views-enabled` · `is-personal-mode`。
- **Emits（4）**：`select-sheet` · `select-view` · `create-sheet` · `toggle-personal`。
- consumer 绑定：`@select-sheet=onSelectSheet` · `@select-view=onSelectView` · `@create-sheet=onCreateSheet` · `@toggle-personal=onTogglePersonalView`。
- 内含：sheet tab（active 态）· "+"新建 sheet（`can-create-sheet` gated）· view tab（active 态 + 视图类型图标 `viewTypeIcon`）· personal-views slice-3 toggle（`is-personal-mode`/`personal-views-enabled` gated）。

> ⚠ impl 时对当前 head 重新核实 props/emits/consumer（并 grep 是否新增 consumer），不得照抄本快照——本文定形状。

## 3. 目标形状

用一个**持久、可折叠的左侧栏**替代水平标签条：
- 顶部 base 名/切换 → 表列表（每表可展开）→ 当前表展开显示其视图（Grid/表单/看板/…，复用 `viewTypeIcon`）→ "+新建表 / +新建视图"就位 → personal-views toggle 保留在视图行。
- 主区让给数据网格（配合 P0 圆角卡片容器）。
- **响应式**：窄屏折叠为抽屉/图标条。

## 4. 硬约束（结构性 → 比 presentation 更严）

1. **emit 平价（逐一）**：`select-sheet` / `select-view` / `create-sheet` / `toggle-personal` —— 事件名 + payload + 触发条件（含 `can-create-sheet`/personal gating）迁移前后**完全等价**；不新增/不丢/不改。
2. **consumer 平价**：`MultitableWorkbench` 的 4 个 handler + 7 props 语义不变；若左侧栏是新组件（`MetaSheetViewRail.vue`），consumer 换挂点但**行为字节等价**。
3. **不碰权限/数据路径**：纯呈现 + 导航；不动 sheet/view 的权限、加载、personal-views 写路径。
4. **消费 UF-1 token**（§8，无新硬编码 hex / 无新 token 词汇）。
5. **键盘/a11y**：树节点可键盘导航（原生 button / 正确 role）——不重蹈 P2-1b 的 "role 名不副实" Medium。
6. **Opus 对抗审阅前置**：P2-2b 布局刀合并前必须过 Opus 审（结构性风险）。

## 5. 门禁（TODO-checklist，分档）

- 🔒 **P2-2a 抽组件 + 行为等价测试**（把 tab 逻辑抽成 `MetaSheetViewRail.vue`——**先不改视觉**、只抽出，consumer 换挂点；runnable 测试断言 4 emit + gating 逐一等价 + 计数守恒）— 待本锁 ratify；Sonnet；Opus 审。
- 🔒 **P2-2b 左侧栏布局**（水平标签 → 垂直树，折叠/展开，UF token）— P2-2a 落稳后；Fable 设计 → Sonnet → **Opus 审**。
- 🔒 **P2-2c 响应式折叠**（窄屏抽屉/图标条）— P2-2b 后。
- 🔒 **不做（各自立项）**：多 base 并列工作区 · 拖拽重排表/视图持久化 · 移动端新页型。

## 6. 验证纪律
每 slice 双 MD；P2-2a 行为等价 golden（4 emit + gating + 计数守恒，mount + 卫生守卫）；键盘导航测试（原生可操作）；证明"不碰权限/数据路径"的 diff；Opus 对抗审阅记录（P2-2b）。

## 7. 一句话
把溢出的水平标签条升级成持久可折叠的 表→视图 左侧栏——但这是**布局重构**：先抽组件 + 4-emit/7-props 行为字节等价（P2-2a），再改视觉（P2-2b，Opus 审），再响应式（P2-2c）。全程消费 UF token、原生键盘可操作、不碰权限/数据路径。
