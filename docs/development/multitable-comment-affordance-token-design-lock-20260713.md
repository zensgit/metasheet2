# Multitable · comment-affordance 专用 token + 9 组件一致性 — 短设计锁（PROPOSED）

- **Status**: **PROPOSED — owner ratify 前零实现授权。** 本锁由 owner 2026-07-13 对 T5 的 OD-T5b=A 裁决**委托创建**（「Comment-affordance：独立短设计锁，定义专用 comment-active token 和 9 组件一致性测试」），但 token **值**与 OD-CA-1..3 仍待 owner 拍板。
- **上游裁决（已定，不在本锁重议）**：comment 按钮从 T5 剥离；**不得拿 `--ms-color-warning` 代替 comment-active 色彩**（owner 明令）。
- **范围**：仅 comment-affordance 的**颜色语义与一致性**。不碰 affordance 的行为逻辑（`comment-affordance.ts` 的 active/idle 判定不变）、不碰权限、不碰计数逻辑。

## §1 面（origin/main `8bc7bbfe4` 逐组件核验）

`resolveCommentAffordanceStateClass`（`utils/comment-affordance.ts:38`）被 **10 个文件**消费：Grid / Kanban / Gallery / Calendar / Timeline / Hierarchy / Form / RecordDrawer + 两个专用组件（`MetaCommentActionChip`、`MetaCommentAffordance`）。每处传自己的 base class ⇒ active 态样式**由各组件自备**——这正是漂移的结构性根源。

## §2 实证发现：系统**已经**漂移（核验过的,不是推测）

| 组件 | comment-active 实际颜色 | 备注 |
|---|---|---|
| MetaRecordDrawer / MetaKanbanView / MetaCalendarView / MetaFormView 等多数 | **琥珀三元组** `border #f59e0b · bg #fff7ed · text #b45309` | 事实上的主流约定 |
| **MetaGridTable**（`meta-grid__comment-action--active`） | **蓝 `color: #1d4ed8`**,无琥珀 | **与主流不一致** —— 同一「有评论」语义在网格里是蓝、在看板/抽屉里是琥珀 |
| MetaCommentActionChip | active/idle **均只有 `opacity: 1`** | 自身无视觉区分,靠**父按钮**的 class 上色（如 drawer 的 `--comment--active`）|

⚠ 注意琥珀三元组与唯一的警告 token `--ms-color-warning: #d97706` **三个都不相等**——这就是 owner 禁止「拿 warning token 代替」的事实基础:那不是 token 化,是**变色**。

## §3 提案

1. **新增专用 token 三元组**（`tokens.css`,全站单一真源 §UF 口径）:
   ```css
   --ms-color-comment-active-border: #f59e0b;
   --ms-color-comment-active-bg:     #fff7ed;
   --ms-color-comment-active-text:   #b45309;
   ```
   **值 = 现行主流琥珀**（采纳时零视觉变）——值本身是 OD-CA-1,owner 可改。
2. **9 组件全部改引 token**,删除各自硬编码琥珀。
3. **一致性守卫测试**:一个 spec 遍历 9 个消费组件的 `--active` 规则,断言:(a) 颜色只来自上述 token(源码扫描:组件内不得再出现裸琥珀 hex);(b) `resolveCommentAffordanceStateClass` 仍是唯一的态派生入口(防止有组件另起炉灶)。**必须带正控**:故意在一个组件里塞回裸 hex → 守卫必红(否则守卫空转)。

## §4 OWNER 决策点

| # | 决策 | 选项 |
|---|---|---|
| **OD-CA-1** | token **值** | (a 荐) 现行琥珀三元组原值(零视觉变) · (b) 归一到别的色阶(变色,须设计确认) |
| **OD-CA-2** | **MetaGridTable 的蓝 `#1d4ed8`** 是 bug 还是有意的场景差异? | (a 荐) **是漂移,收敛到 token**(网格 active 变琥珀=可见变化,需 owner 知情) · (b) 网格有意用蓝,记为**显式豁免**并注释,守卫放行该例外 |
| **OD-CA-3** | drawer 的 comment 按钮此时是否顺带迁 `MtButton`? | (a) 迁,active 用新 token(T5 补完) · (b 荐) 本锁只管颜色/一致性,按钮迁移等 token 落地后单独小 slice(避免一票两事) |

## §5 本文不主张什么

- 不主张任何 token 已存在或任何组件已改——**零 runtime,PROPOSED**。
- 不主张 §2 表覆盖了全部 10 文件的每一条规则——主流琥珀 + Grid 蓝 + Chip 无自样式是**核验过的**;逐组件全量清单在实施 slice 里做。
- 不主张 OD-CA-2 的「(a 荐)」已被采纳——网格变色是**可见变化**,必须 owner 知情后拍。
