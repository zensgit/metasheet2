# R13-B — 完整 T-state（含 T 后被删记录）+ History Center 直接预览/恢复 — DESIGN LOCK (PROPOSED)

- **Status**: **PROPOSED — 2026-07-13. NOT ratified.** 读面完整性可自主推进（decision-independent）；**写面（从 PIT 恢复被删记录）与 R14 产品决策耦合**（base-wide vs granular），故写面待 R14。owner ratify §5 (OD-B1..B3)。
- **Provenance**: primary-source @ `origin/main`，file:line 已读非推。R13/R14 线 B 车道（[[multitable-timemachine-r13-r14-revision-completeness-and-parity-design-verification-20260713]] §3）。**依赖 R13-A**：T-state 的正确性以 revision 链完整为前提——8 条未捕获路径未修前，T-state 在这些记录上本身是错的（#4187 R13-A）。

## §0 确认的缺口（primary-source）

### 缺口 1 — PIT view **丢弃 T 后被删的记录**
T7 point-in-time view（`univer-meta.ts:8280` `GET /sheets/:sheetId/point-in-time`）**显式限定「当前仍存活」的记录**：
```
:8299  const liveIds = (SELECT id FROM meta_records WHERE sheet_id = $1)   // 只枚举当前存活
:8303  reconstructRecordsAtT(..., liveIds)                                 // 只重建这些
:8314  if (!st || !st.exists) continue                                     // 丢掉 T 时不存在的
```
注释自陈：*"restricted to records that CURRENTLY EXIST (deleted-since-T records are OUT of v1 — a product-scope choice, NOT a safety deny)"*。⇒ **一条在 T 时存在、之后被删的记录，不出现在 T 时点视图里**——这正是 owner R13-B 指的「完整 T-state 应**包含 T 后被删除的记录**」。`reconstructRecordsAtT` 本身**已能**正确判定它们（`record-reconstructor.ts:26-28`：latest ≤T 非 delete ⇒ `exists:true`；只有 latest ≤T 是 delete 才 `exists:false`）——**缺的是枚举集**：endpoint 只喂 `liveIds`，从不喂「T 后被删」的 id。

### 缺口 2 — History Center 只显示「影响数量」，不能直接预览/恢复单条
当前 History Center 时间线/批次给的是 `affectedFieldIds`/影响计数（`univer-meta.ts:3618,3624`），恢复要另走 restore-preview/execute 面。owner R13-B：**从 History Center 直接预览并恢复**（单条），而非只显示影响数量。

## §1 读面设计（可自主，decision-independent）

### 1.1 完整 T-state 枚举集
T 时点存在的记录 = **(当前存活) ∪ (T 后被删)**。第二集 = 「有一条 `action='delete'` 且 `created_at > T` 的 delete revision、且其 latest ≤T revision 非 delete」的记录 id。
- **枚举**：`SELECT DISTINCT record_id FROM meta_record_revisions WHERE sheet_id=$1 AND action='delete' AND created_at > $T`（候选被删集），并入 `liveIds`，一起喂 `reconstructRecordsAtT`；`exists:true` 的保留（含被删但 T 时存在的）。
- **标注**：响应里给被删集一个 `deletedSinceT: true` 标记，UI 可视化区分（灰显/角标），并作为「可从 PIT 恢复」的入口（写面见 §2）。
- **规模**：候选被删集可能大；沿用 §R13-C 的 `SHEET_REVERT_MAX_RECORDS`/异步阈值口径（读面通常可分页，不必异步，但要分页+计数一致）。

### 1.2 权限/掩码（安全红线，不可放松）
被删记录的 T-state **仍受 row/field 读掩码约束**——一条 actor 在 T 时无权读的记录，删了也不能因「历史」而泄露。复用现有 PIT view 的 row-deny/field-mask 链（endpoint 已有，见 :8275 注释「Row-deny...」），对第二集**同样应用**。**count 不泄**（被删集计数同样按 G5 教训不做 count-oracle：掩码后计数）。

## §2 写面设计（**与 R14 耦合，待 R14 决策**）
「从 History Center **直接恢复**」单条被删/被改记录：
- 单条 restore：复用现有 restore-execute / PIT-undelete 面（record 级已存在）——**读面把入口接上即可**（History Center 时间线的某条 → 预览该条 T-state → 一键 restore）。
- **但「整批/整表恢复」= R14 方案 A（base-wide atomic restore）**。若 R14 选 A，History Center 的「恢复」要支持批量原子；若选 granular，则明确只支持单条/字段/sheet 级。**故 §2 的批量恢复语义 hold 到 R14。** 单条恢复入口可先做（decision-independent）。

## §3 出界
- 不做批量/base-wide 恢复（R14）。
- 不改 `reconstructRecordsAtT` 的核心语义（它已正确；只扩枚举集）。
- 不在 R13-A 落地前宣称 T-state 正确（前提依赖）。

## §4 OD 决策（owner ratify）
| OD | 决策点 | 建议 |
|---|---|---|
| **OD-B1** | PIT view 纳入 T 后被删记录：默认纳入，还是 opt-in 参数（`includeDeletedSinceT`）？ | 默认纳入（完整 T-state 是产品目标）+ `deletedSinceT` 标记；分页 |
| **OD-B2** | History Center 单条直接 restore 入口先做（decision-independent），批量恢复 hold 到 R14 —— 确认此拆分 | 确认：单条先做，批量随 R14 |
| **OD-B3** | 被删记录 T-state 的掩码：与活记录同链（§1.2）——确认不因「已删」放松读权限 | 确认：同链，不放松 |

## §5 验证义务（实现阶段，mutation-proven，对齐最终验收 #2「完整 T 状态」）
- **完整性 golden**：建记录→改→删（delete revision）→ PIT view at T（删之前）**包含**该记录且值为 T 时值；at T'（删之后）**不含**；`deletedSinceT` 标记正确。突变（去掉第二集枚举）→ 该记录从 T 视图消失 → 红。
- **掩码 golden**：row/field-denied actor 的 PIT view **不含**被删记录的 id/值（突变去掉第二集掩码 → 泄露 → 红）。
- **直接 restore golden**：History Center 单条入口 → 预览 T-state → restore → 记录回到 T 值（真实入口，非快照 tautology）。
- **依赖门**：这些 golden 的正确性以 R13-A revision 链完整为前提；R13-A 未落地前，被 8 路径影响的记录的 T-state 仍错——golden 应在 R13-A 之上跑。

**收官口径**：读面完整性（§1）design-only 但可自主实现（owner ratify OD-B1/B3 后）；**写面批量恢复（§2）hold 到 R14**；全部以 **R13-A 落地**为正确性前提。
