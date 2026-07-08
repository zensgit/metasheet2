# 多维表 — 手动排序基座 设计锁（DESIGN LOCK）

状态：PROPOSED — 待 owner ratify
类型：设计锁（docs-only，零 runtime）。**⚠ 本锁未经独立对抗门禁**——起草它的子代理死于每周限额（Jul 12 重置），门禁流水线暂停，故本锁由主循环 verify-first 写就。owner ratify 前请对其载重声明（§2 现状、§4 primitive 叉口）比对已门禁的 #3928/#3931/#3940 更严格审。

- **Baseline**: `origin/main` @ `7e7798a34`（引用行号会随 `[MUTEX:BE]` 流量漂移；实现前须按当时 HEAD 重核）。
- **Provenance**: 目标池 B 簇「排序基座」。对标基线能力：用户可手动拖拽决定记录顺序。当前不存在。

---

## §1 问题 — 逐条对代码验证（含两处对上游 brief 的收窄）

对标线要求「用户可手动排序」跨三个面。verify-first 发现三者**成熟度天差地别**，不可一锅端：

1. **手动行序 = 完整缺口，零基座。** `meta_records` 的读取一律 `ORDER BY created_at ASC, id ASC`（`univer-meta.ts` 多处：`:4688`/`:5045`/`:5101`/`:5117`/`:5521`，及 `/view` 主读路径）。`meta_records` 上**没有** `order_index`/`position`/`row_order` 列（迁移目录无此列）。用户无法把某行拖到另一行前面并持久化。**这是本锁的核心。**
2. **看板卡片序 = 收窄。** 跨列拖拽**已工作**：`MetaKanbanView.vue` 有 `draggable="true"` / `onDragStart` / `onDrop`，而 `onDrop`（`:407-411`）= `emit('patch-cell', dragRecordId, groupField.value.id, targetValue, dragVersion)` —— 它改的是**分组字段的值**（把卡片移到另一列 = 改该行的字段值），已持久化。缺的**只是列内顺序**（同一列内的卡片仍按 `created_at` 显示）。这是**小 rider**，不是「看板无排序」。
3. **仪表盘 widget 布局 = 基本已解决。** 面板已带整数 `order`：`MetaDashboardView.vue:746` `[...panels].sort((a,b)=>a.order-b.order)`，新面板追加于 `order: panels.length`（`:1014`/`:1071`）。线性重排基座**已存在**；只有 2D 自由布局（x/y/w/h）才是增量，且很可能超出对标范围。**本锁将仪表盘排除**（§6）。

**已存在的字段/列重排（复用其词汇，不重造）**：字段实体带 sheet-global 整数 `order` 列，重排走 **shift-on-insert**（T9-R1，`univer-meta.ts:~10814`「a reorder shifts the fields BETWEEN old and new position」；`recordFieldOrderShifts`），另有个人视图的 id-array 覆盖层 `fieldOrder?: string[]`（`:434`，`applyPersonalViewOverlay`）。字段数少（<100/表），整数-shift 每次移动重写 old↔new 之间的行**可接受**。**对行不可接受**（见 §4）。

---

## §2 本锁不主张什么（防过度声称）

- **不主张**看板跨列拖拽是缺口——它已工作（`patch-cell` 改分组值）。
- **不主张**仪表盘无排序——线性 `order` 已存在。
- **不主张**已有任何行序数据被丢弃或损坏——今天根本没有行序输入面，无数据可丢。
- **不主张**字段整数-shift 有 bug——对字段规模它是对的；只是**不能照搬到行**。

---

## §3 排序语义的三个决定（owner ratify 时需拍板）

- **D1 作用域**：行序是 **sheet-global（所有视图共享一份顺序）** 还是 **per-view（每视图独立顺序）**？字段已有两者共存的先例（global `order` + per-view `fieldOrder` 覆盖）。行序若 per-view，存储成本随视图数×行数增长。**推荐**：sheet-global 一份「手动序」为默认，per-view 覆盖留作独立 gated rider（不在本锁首环）。
- **D2 与排序规则的关系**：当视图配了字段排序（sortBy）时，手动序如何共存？**推荐**：手动序是一种**互斥的排序模式**（「手动」vs「按字段」），切到字段排序即隐藏手动序、不销毁它；切回即恢复。禁止两者叠加产生歧义。
- **D3 与分组的关系（seam → #3928）**：手动序是**组内**有效还是**全表**有效？跨页/服务端分组的真源是 #3928。**本锁 DEFER 给 #3928**：手动序在分组视图下的组内/跨组语义，须与 #3928 的 `mode` 判别式一致，本锁不自造词汇。

---

## §4 载重叉口 — 整数-shift vs 分数/有理索引（不许糊弄）

行是**协同编辑**对象且数量以千计。排序 primitive 有三条路，本锁**不预先裁定**，交由 R1 环后的 owner/实现裁断，但把权衡钉死：

| 方案 | 插入成本 | 协同安全 | 代价 |
|---|---|---|---|
| **整数位置 + shift**（字段现方案） | **O(n)** 每次拖拽重写 between 区间所有行 | **差**：并发拖拽 → 大范围行版本冲突 | 简单、无精度问题 |
| **分数/有理索引**（插入 = 取中点） | **O(1)** 只写被移动的那一行 | **好**：只碰一行 | 需 rebalance story（浮点精度耗尽 / 字符串键增长）；键生成须确定性 |
| **view-config id-array**（整张顺序存视图配置） | O(n) 存储/写 每视图 | 中 | 行数大时配置膨胀；与增量加载/跨页分组冲突 |

**本锁的硬约束**：行序 primitive **必须 O(1)-插入且协同安全** → 指向分数/有理索引。整数-shift **禁止**用于行（其 O(n) 写会与 #3931 的无限滚动、#3928 的分组游标正面冲突）。rebalance 策略（何时、如何、是否需要一次全表重排迁移）是 R1 环内必须给出的子设计，**其缺失即环不完整**。

---

## §5 分级阶梯（每环带 unblockedBy · 模型档 · 命名验证 · 必红 mutation）

> 全部 runtime 环 = **开 PR，绝不自合**（红线④）。仅本设计锁是 docs。

- **R0（契约 · sonnet 实现 / opus 审）** unblockedBy: 本锁 ratify。定义 wire 契约：`view.orderMode: 'manual' | 'field'`（默认 `field`，保持现状 `created_at`）+ 手动序读出形状。**验证**：契约测试断言 `orderMode` 缺省 → 现有 `created_at` 顺序字节不变。**必红 mutation**：把默认改成 `manual` 但无手动序数据 → 现有顺序快照测试 RED（证明默认零漂移）。
- **R1（数据模型 + 迁移 · sonnet / opus，`[MUTEX:BE]`）** unblockedBy: R0。加 `meta_records.manual_order`（有理索引，确定性键生成 + rebalance 子设计），**default-off flag** `MULTITABLE_ENABLE_MANUAL_ROW_ORDER`。**验证**：插入 A、B 之间只写 1 行（不写 A/B）。**必红 mutation**：把有理中点算法换成整数-shift → 「只写 1 行」断言 RED（证明 O(1) 是载重的，不是摆设）。
- **R2（重排写端点 · sonnet / opus，`[MUTEX:BE]`）** unblockedBy: R1。`PATCH …/records/reorder`，权限按 §7 引用既有闸。**验证**：不可写某行的 actor 重排该行 → fail-closed。**必红 mutation**：删掉 `ensureRecordWriteAllowed` 调用 → 越权重排 golden RED。
- **R3（读路径消费 · sonnet / opus，`[MUTEX:BE]` + grid mutex）** unblockedBy: R1。`/view` 在 `orderMode==='manual'` 时 `ORDER BY manual_order`。**验证**：手动序在跨页分页下稳定（不跳行、不重复）。**必红 mutation**：把 `ORDER BY manual_order` 退回 `created_at` → 手动序 golden RED。
- **R4（网格拖拽 UI · sonnet / opus，grid mutex + `[MUTEX:WB]`）** unblockedBy: R2/R3。`MetaGridTable.vue` 行拖拽把手 + 乐观更新。**验证**：拖拽 emit 的 payload = (rowId, beforeId/afterId, version)。**必红 mutation**：断开 `@drop` handler → 拖拽交互测试 RED。
- **R5（看板列内序 rider · sonnet / opus）** unblockedBy: R1，**且渲染 DEFER 给 #3931**（看板卡片序属其簇）。列内手动序复用 R1 的有理索引，按 (lane,column) 作用域。**验证**：同列内拖拽持久化顺序，跨列拖拽仍走既有 `patch-cell`（不回归）。**必红 mutation**：让列内拖拽误发 `patch-cell` 改分组值 → 「跨列改值、列内改序」区分测试 RED。
- **R6（个人视图行序覆盖 · sonnet / opus，可选）** unblockedBy: R3。per-view 覆盖层，镜像字段的 `fieldOrder` id-array 先例。default-off。**验证**：A 用户的行序覆盖不影响 B 用户。**必红 mutation**：把覆盖写成 sheet-global → 用户隔离 golden RED。

---

## §6 显式 OUT（各为独立 gated opt-in 或非缺口）

- 仪表盘 2D 自由布局（x/y/w/h）—— 线性 `order` 已存在；2D 是独立增量，未验证属对标必需，不在本锁。
- 看板跨列拖拽 —— 已工作（`patch-cell`），非缺口。
- 分组视图下的组内/跨组手动序语义 —— 真源是 #3928，本锁 DEFER。
- 排序规则（sortBy 字段排序）本身 —— 已存在，本锁只定义它与手动序的互斥（D2）。

---

## §7 权限平价（按引用，绝不新造 · 绝不碰中央 rbac/auth = K3）

重排写记录/视图配置 → 复用既有写闸，按 file:line 引用（实现前重核 HEAD 行号）：
- `ensureRecordWriteAllowed`（记录写主闸）· `isFieldWriteForbidden` / `isFieldAlwaysReadOnly`（字段写闸，若手动序落在字段上）· `loadRowLevelReadDenyEnabled` + `loadDeniedRecordIds`（行读否决）。
- **必备 golden**：(a) 不可写某行的 actor 不能重排它（fail-closed）；(b) 行读否决启用时，被否决记录**不得**经 `manual_order` 枚举暴露存在性（顺序键不得泄漏否决行的相对位置）——此条与 [[finding_multitable_permission_bypass_20260708]] 的 G5 同源（分页元数据须在否决**之后**成形），实现须遵之。

---

## §8 互斥类台账

| 类 | 文件 | 与谁冲突 |
|---|---|---|
| `[MUTEX:BE]` | `univer-meta.ts` · `aggregation-helpers.ts` · `api/client.ts` | #3928 A/B · #3931 后端环 · 本锁 R1/R2/R3。baseline-first，同文件不得两个在飞 PR，后者 rebase + 逐条重核行号 |
| grid mutex | `MetaGridTable.vue` · `useMultitableGrid.ts` | #3928 C/D · #3931 网格环 · 本锁 R3/R4 |
| `[MUTEX:WB]` | `views/MultitableWorkbench.vue` | #3928 E · #3931 · 本锁 R4 |
| kanban | `MetaKanbanView.vue` | #3931 看板环 · 本锁 R5（R5 渲染 DEFER 给 #3931，避免双占） |

---

## §9 本锁不主张什么（收束）

- 不主张已获 ratify。
- 不主张 §4 已裁定 primitive——只钉死约束（O(1) 插入 + 协同安全）与权衡，裁断留给 R1 后的 owner。
- 不主张本锁经独立对抗验证（见页首告示）。
- 不碰权限/中央授权（K3）。
