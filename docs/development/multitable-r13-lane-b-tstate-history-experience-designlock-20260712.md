# Multitable Global History R13 Lane B — T-state（时点态）历史体验：完整历史版本查看 + 预览 + 恢复 — DESIGN LOCK

> **Status: PROPOSED — awaiting owner ratify。Docs-only：零 runtime、零迁移、零 wire 变更。**
> 定位：Global History / Time Machine R13 gap-closure 三 lane 之 **Lane B**（Lane A = revision 完整性，另文平行起草；Lane C = ops/规模）。**R14（base 级整体恢复）显式 out of scope（§7）**。R12 收官见 `multitable-time-machine-remaining-dev-and-verification-20260712.md`。
> 口径：本文写 MetaSheet 自有设计口径，不引用任何竞品。
> 基线：代码实测 @ `origin/main`（`74d4f8eb6`，2026-07-12）。行号引用以该基线为准，实施时以语义锚（函数名/LOCK 名）为准。
> 本文对 owner 的 6 条 Lane B 口头锁逐条编码为 **B-LOCK-1..6**（§3）；一切需要新增语义裁量的点收敛到 §8「待 owner 裁决」。

## 0. 一句话

把 History Center 从「按批次看影响计数（`visibleAffectedRecordCount/FieldCount`，HistoryCenterModal.vue:211-213）+ 逐批 diff」升级为：**任一时点 T 的完整表态可看（含 T 后被删除的记录）、任一记录（含当前不存在的）可从 History Center 直接预览其 T 态、并经既有守卫 + 新增幂等 operationId 执行恢复**。读面 = 既有读授权四件套的**复用**（field-mask / row-deny / no-existence-leak / admin-bypass——不是新权限模型）；写面 = R11 restore 主干（preview-identity + CAS + `restored_from_version` 回链）的**复用** + 幂等 operationId 补位。

## 1. 现状对账（代码实测，非假设）

| 组件 | 位置 | 现状 |
|---|---|---|
| **T5-1 时点重建原语** `reconstructRecordsAtT` | `packages/core-backend/src/multitable/record-reconstructor.ts:34` | **存在**。纯读；输入 `(query, sheetId, asOfIso, recordIds?)`，返回 `Map<recordId, RecordStateAtT>`，`RecordStateAtT = { recordId, exists, data, version }`。delete-aware（LOCK-9：最新 ≤T revision 为 `action='delete'` ⇒ `exists:false, data:null`）、确定序（LOCK-11：`created_at DESC, version DESC, id DESC`）。数据源 = `meta_record_revisions` 单表。**无 T 前 revision 的记录缺席于 map**（= created-after-T，或历史已被 retention 清除——重建器无法区分，见 §4.1 诚实降级）。 |
| **T7 时点只读视图** `GET /sheets/:sheetId/point-in-time` | `routes/univer-meta.ts:8280` | 存在，但 **v1 限定 currently-live 记录**（route 注释原话："deleted-since-T records are OUT of v1 — a product-scope choice, NOT a safety deny"）——先取 `liveIds` 再喂重建器（:8303）。row-deny = current-deny（对当前数据求值，明确**不** as-of-T）；field-mask = `loadAllowedFieldIds + maskStoredRecordFieldIds`；total = post-permission-filter（LOCK-3）。**FE 无任何消费方**（`apps/web/src/multitable/api/client.ts` 无 `point-in-time` 调用）。 |
| **T6-1/T6-2 单记录版本恢复** preview/execute | `univer-meta.ts:9198 / :9609` | preview 铸 identity（JWT/HS256，绑 `sheetId+recordId+targetVersion+strategy+changesHash(masked diff)+actorId`，TTL 10m）；execute 重算 fresh diff → hash 失配拒绝（409/410）、`expectedVersion` CAS、row-deny 404 no-oracle（SR-2）、layer-3 写门、SCHEMA_DRIFT 拒绝、`restoredFromVersion` 回链（R11 #4124）。**delete-target 显式 422 `RESTORE_UNSUPPORTED`：undelete 不在此面**（:9647）。 |
| **BS 批量恢复** preview/execute | `univer-meta.ts:9284 / :9750` | `recordIds` 显式列表 `z.array(...).min(1).max(100)`（BS-6 bounded + fail-closed，无静默截断）；scoped identity 绑 `scopeHash`；execute 需 per-record `expectedVersions`；默认 PARTIAL（逐条 skip+报告），`allOrNothing` opt-in。 |
| **T8-1 整表 revert-to-T（含 resurrect）** | `univer-meta.ts:10073 / :10112` | 整表面。deleted-after-T 的 resurrect **已实现**：`MULTITABLE_ENABLE_PIT_UNDELETE` flag（默认 OFF）+ `canManageSheetAccess` 之上 `canDeleteRecord` 地板（**非** canEditRecord）+ typed confirm `'undelete'` + `resurrectScopeHash` 绑入 identity + resurrect 单事务 all-or-nothing + `SHEET_REVERT_MAX_RECORDS` 双上限（live 行数 + effective write set）。inbound link 重放走 4c-3（`MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND`）+ A′ vintage-exact 锚（#4117：`created_at > T` 严格互补于重建器的 `<= T`）。 |
| **幂等现状** | `multitable/restore-preview-identity.ts`（模块头注释） | identity 模块自述：**"Single-use / anti-replay needs server state and is a T6-2 idempotency concern, NOT this slice"**。今天的防重放 = `expectedVersion` CAS + execute 重算 changesHash 失配拒绝——重放拿到的是**报错**（409），不是幂等确认；**不存在 client-supplied operation id**。这是已知遗留，Lane B 收口（B-LOCK-4）。 |
| **tombstone / trash 底座** | 迁移 `zzzz20260708090000_create_meta_tombstone_tables.ts`；`meta_records_trash`；`meta_record_revisions.restored_from_version`（`zzzz20260711000000`） | `meta_field_value_tombstones` + `meta_link_tombstones`（append-only、无 FK、forward-only——**4d 红线：flag 开启前销毁的数据无 tombstone，任何路径不得假装可恢复**）。trash 行带完整 `data` 快照 + `delete_revision_id` 锚。 |
| **2b trash rule-deny 先例** | `multitable-2b-trash-restore-rule-deny-design-lock-20260618.md`（IMPLEMENTED） | **非 live 行的行级 deny 求值先例**：共享求值核（LOCK-2）对 trash `data` 快照跑同一 `evaluateRecordDenied`；deny-wins ∪ grant-deny（`record_permissions` 无 cascade，删除后持续有效）；denied undelete 与 not-found 同形 404（LOCK-6）；total 同口径排除（LOCK-4）；admin bypass（LOCK-7）；flag-off byte-identical（LOCK-8）；fail-closed。 |
| **History Center UI** | `apps/web/src/multitable/components/HistoryCenterModal.vue`、`HistoryBatchChangesList.vue`、`composables/useHistoryCenter.ts` | T2/T3 只读：批次列表（impact count）+ 逐批 diff。文件头自述 "Read-only: no restore here (T5/T6 are gated)"。恢复类 client API（`restorePreviewRecord/restoreExecuteRecord/restoreBatchPreview/restoreBatchExecute`）已存在于 `client.ts:2256-2297`，但由 record drawer 一侧消费，History Center 未接。`ResetToPointPicker.vue` 已有可复用的 T 选择器形态。 |

## 2. Gap（Lane B 要关的缺口，均对基线实证）

- **G1 — T-state 读面不含 deleted-after-T**：T7 的 `liveIds` 限定使「T 时存在、T 后被删」的记录从时点视图消失——时点态不完整（这是 v1 的产品范围选择，现在到期）。
- **G2 — 当前不存在的记录无从预览**：T6 preview 对 missing 记录 404、对 delete-target 422；T7 无该行。用户在 History Center 看到一条删除批次，**没有任何纯读面能看「这条记录在 T 时长什么样」**。
- **G3 — History Center 无时点入口**：T7 端点零 FE 消费方；History Center 只有批次维度，没有「切到时点 T 看整表」和「从这里预览/恢复」的动线。
- **G4 — 幂等 operation id 缺位**：重放 execute = 报错而非幂等确认（§1 幂等现状行）；网络重试/双击场景下客户端无法区分「已应用」与「被拒」。
- **G5 — 单条 resurrect 无面**：deleted-after-T 记录的复活只存在于 T8-1 **整表** revert 里；「从 History Center 恢复这一条已删记录到其 T 态」没有单记录面。

## 3. DECISIONS — owner Lane B 锁（B-LOCK，ratify 对象）

### B-LOCK-1 T 时存在、T 后被删的记录，必须重现于 T-state
T-state 读面（§4.1）**不得**以「当前是否存活」过滤重建结果：一条记录只要「最新 ≤T revision 存在且非 delete」（`reconstructRecordsAtT` 的 `exists:true` 判定，LOCK-9/11 原语原样复用，**不重造重建器**），就必须出现在 T-state 中，携带其 T 快照值。数据来源分工：**值快照 = `meta_record_revisions`**（重建器唯一来源，D1/D2 已保证 delete 也留 revision）；**inbound link 边 = `meta_link_tombstones` + A′ 锚**（仅在 resurrect 执行时重放，读面不需要）。实现形态上即：去掉/绕开 T7 的 `liveIds` 限定（形态选择见 OD-B3），并对非 live 行执行 §5 的授权矩阵。

### B-LOCK-2 当前不存在的记录可直接从 History Center 预览
单记录 T-state 预览（§4.2）是**纯读**面，读的是重建态，**与当前存在性无关**：记录当前存在 → 返回 T 快照（可附 vs-current diff）；当前不存在（T 后被删）→ 同样返回 T 快照，并标记 `existsNow:false`。「先复活才能看」是本锁禁止的形态。

### B-LOCK-3 Preview 与 Execute 分离
预览 = 纯读（PV-1 不变量原样继承：无 INSERT/UPDATE/DELETE、无副作用；测试为状态不变量而非注释断言，§6 V1）；执行 = 守卫恢复（identity 消费 + CAS + 写门）。**任何 Lane B 执行面都必须消费一个由对应预览铸出的 identity**（T6/BS/T8-1 的既有铸验模式），不存在「无预览直接执行」的新路径。

### B-LOCK-4 恢复 = version/record 锁 + 幂等 operationId
- **既有锁复用**：`expectedVersion` CAS（patchRecords 事务内 SELECT FOR UPDATE 主干）+ preview-identity（changesHash / snapshotHash / scopeHash，actor-bound，TTL）——一个不减。
- **新增**：Lane B 执行面要求 client-mint 的 **`operationId`**（UUID）。服务端在**与写同一事务**内将 `(scope, operationId, actorId, outcome)` 落入幂等账本（载体 = OD-B2），账本唯一约束即守卫：**同 `operationId` 重放 → 不进入写路径，直接返回首次记录的 outcome（`replayed:true`）——绝不二次 apply**；不同 `operationId` 但状态已变 → 落入既有 CAS/hash 拒绝（409），语义不变。resurrect 场景额外自带天然幂等哨（记录 id 已存活 → 复活即拒，U4-L5 同型）。
- 这正是 identity 模块自述推迟的「server state anti-replay」的收口——**幂等语义按业务分级：值恢复/复活都是可安全确认的一次性操作，重放返回确认而非报错**。

### B-LOCK-5 读授权 = 既有四件套复用，不是新权限模型
T-state 视图与预览**必须**复用：field 权限（`loadAllowedFieldIds`，layer-2 ∩ layer-3 ∩ taint）、行级 deny（`loadDeniedRecordIds`：grant-deny ∪ 2b conditional rule-deny）、field masking（`maskStoredRecordFieldIds`）、no-existence-leak（LOCK-3 全谱：denied 行不入列表、不入 total、直查与 missing 同形 404）。**观看者不可见的记录/字段，其存在性与值都不得经 T-state 泄露**——T 快照里的字段键同样按 allowed 集过滤（隐藏字段的历史值不因“这是历史”而解禁）。live 行的行级 deny 沿 T7 既有语义 = **current-deny，绝不 as-of-T**（T 时公开、现在被 deny 的记录不得经时点视图成为读取 oracle）；**非 live 行没有“当前数据”可评，其 rule-deny 求值基是本锁唯一需要 owner 裁量的复用参数（OD-B1，先例 = 2b LOCK-1/2）——在裁决前不实现非 live 行读面**。admin-bypass / flag-off inert 沿 2b LOCK-7/8。**本 lane 不设计任何新 RBAC/新授权路径**；凡复用无法覆盖之处一律上收 §8。

### B-LOCK-6 单条恢复与批量恢复分面；base 级恢复绝不走私
- 单条面（§4.3）与批量面（§4.4）是**两个 surface、两种 identity scope**（T6 单记录型 vs BS scoped 型，type-disjoint 由既有 identity 契约保证）。
- 批量面**只接受显式 `recordIds` 列表**，上限沿 BS-6（≤100，fail-closed 无截断），**不存在** wildcard / “全表” / “按筛选条件” 入参形态。
- **base 级（跨表/整 base）恢复 = R14，owner-gated，本 lane 明确不做（§7）**。整表 revert/reset 已有 T8 自己的面与锁，Lane B 不动。

## 4. 面（surface）设计草案

> 契约形状为 PROPOSED 草图：**语义锁定，字段命名/参数形态实施期可微调**（wire 变更两侧 shape-lock 同步，沿既有纪律）。

### 4.1 T-state 表视图（read）
- 形态（OD-B3，推荐 A）：T7 端点加 `includeDeleted`（默认 false = **byte-identical 于现状**，既有语义零扰动）；开启后结果并入 deleted-after-T 行，每行携 `existsNow: boolean`（或 `deletedSinceT: true` 标记，实施定名）。
- 能力门：`canRead`（与 T7/history detail 的读披露一致——历史批次 detail 本就以 masked 形态披露删除快照；resurrect 执行另有更高门，见 §4.3b 与 OD-B5）。
- 分页/total：沿 T7（post-permission-filter total，LOCK-3）。denied 的非 live 行同样不入列表不入 total（§5）。
- **诚实降级（4d 红线）**：重建器对「无 ≤T revision」的记录缺席处理 = created-after-T 与 retention-已清 二者不可区分；读面**不得**编造占位行，仅在响应级附 `reconstructionBasis: 'revisions'` 类说明（实施定形）。retention 交互属 Lane C，此处只声明不撒谎。

### 4.2 单记录 T-state 预览（read，History Center 的「预览此记录 @T」）
- 入参 `{ recordId, asOf }`；出参：`existsAtT`、masked T 快照、`existsNow`、（当 `existsNow=true`）复用 `computeRecordRestoreDiff` 的 vs-current masked diff、以及可执行时铸出的 preview identity（B-LOCK-3）。
- `existsAtT=false`（T 时也不存在）→ 与「记录从来不存在」**同形响应**（no-oracle）；denied → 同形 404（LOCK-6 平移）。
- 纯读（PV-1）；reveal 永不 compose（PV-3 平移：不调 reveal 函数族，`?reveal` 无效）。

### 4.3 单条恢复（execute，两形态、一个幂等契约）
- **(a) 记录当前存在 → 值恢复**：复用 T6-2 主干原样（masked diff、layer-3 写门、SCHEMA_DRIFT、CAS、`restoredFromVersion` 回链）。asOf→targetVersion 由预览服务端解析并绑入 identity（OD-B6）。增量仅 `operationId`（B-LOCK-4）。
- **(b) 记录当前不存在 → 单条 resurrect**：T8-1 undelete 底盘的**单记录化复用**（推荐完整继承其地板：flag + `canDeleteRecord` + typed confirm `'undelete'` + `snapshotHash` 绑定 + 单事务 + inbound replay 走 4c-3 flag + A′ 锚；复用度 = OD-B4）。**守卫只增不减**：任何一项弱化（如降为 canEditRecord）都是对 T8-1 锁的破坏，禁止。
- 两形态共用 §3 B-LOCK-4 幂等契约；outcome 形状沿既有（restored / skipped+reason / conflict 409 / identity 410）。

### 4.4 批量恢复（execute，独立面）
- BS-1/BS-3 主干复用：显式 `recordIds`（≤100）、per-record `expectedVersions`、scopeHash identity、默认 PARTIAL + `allOrNothing` opt-in。增量：`operationId`（批量 = **一个** operationId 对应一次批量 outcome 整体落账，重放返回整份 outcome）。
- **v1 范围收缩**：批量面只做**值恢复**（当前存在的记录）；批量 resurrect（多条已删记录一次复活）**不在 Lane B v1**——它与 R14 的距离过近，留待单条 resurrect 面稳定后另行 opt-in（§7）。

### 4.5 History Center UI 扩展（FE）
- 新「时点视图」入口（T 选择器可沿 `ResetToPointPicker` 形态）→ 4.1 读面；批次/记录行新增「预览此时点」→ 4.2；预览面内按 §4.3 守卫渐进露出「恢复」（无能力/无 flag 时不渲染执行钮，服务端仍是唯一裁决者）。
- 现有 impact-count 列表默认形态不动（OD-B7）；FE 不重算任何权限（渲染服务端给的 masked 结果，useHistoryCenter 既有纪律）。

## 5. 读授权复用矩阵（B-LOCK-5 的落点）

| 守卫 | live 行（T-state 中） | 非 live 行（deleted-after-T） |
|---|---|---|
| field-mask | `loadAllowedFieldIds` + `maskStoredRecordFieldIds`（T7 原样） | 同左——对 **T 快照的键**过滤；隐藏字段的历史值不解禁 |
| 行级 deny：grant-deny | `loadDeniedRecordIds` grant 分量 | **持续有效**（`record_permissions` 无 FK/cascade，2b 锁已实证）——直接复用 |
| 行级 deny：rule-deny | current-deny（T7 语义：对当前数据求值，绝不 as-of-T） | **求值基 = OD-B1**（推荐：2b LOCK-2 共享核对「被披露的 T 快照」求值——被规则隐藏的值不因删除而泄露，且与 resurrect 后将复活成的数据一致）；**裁决前不实现** |
| no-existence-leak | LOCK-3：不入列表/不入 total/同形 404 | 同左 + 2b LOCK-6 平移（denied 与 missing/从未存在 同形） |
| admin bypass / flag-off inert | 2b LOCK-7/8 | 同左（flag-off 时非 live 行的 rule-deny 支路与 pre-2b byte-identical 地不发新查询） |
| reveal | 永不 compose（PV-3） | 同左 |
| fail-closed | 求值错误 → deny（既有语义） | 同左（字段已删致规则不可评 → 整行 deny，2b LOCK-2 预期副作用同型） |

## 6. 验证计划（实施期逐片交付，验收即门；全部 real-DB golden 除注明 FE spec）

- **V1 预览零突变 + 正控**：对 4.1/4.2 各一支——preview 调用前后 `meta_records` + `meta_record_revisions` 行数与目标记录 `version` **相等**（PV-1 状态不变量）；**正控腿：同一 fixture 走 execute 后 version 恰 +1 / resurrect 后行数恰 +1**——防「观测一坏全 fail-closed 空转变绿」。
- **V2 幂等双执行**：同 `operationId` 连续两次 execute ⇒ **恰一次 apply**（恰一条 forward revision、version 恰 +1），第二次响应 `replayed:true` 且 outcome 与首次逐字节一致；**正控腿：新 preview + 新 operationId ⇒ 第二次 apply 真实发生**（version 再 +1）。并发形态（两个同 id 请求同时到达）以事务内唯一约束冲突收敛为「一次 apply + 一次 replayed」——**必须构造真并发断言，顺序论证不算数**。
- **V3 no-existence-leak（负向 + 正控）**：构造一条对 viewer 隐藏（rule-denied 与 grant-denied 各一）且已删除的记录：unauthorized viewer 的 T-state **整响应 body**（非仅 records 数组）不含其 recordId 与任何字段值，total 不计入；对其直接预览 → 与「从未存在的 id」**同形** 404；**正控腿：authorized viewer（及 admin）在同一 fixture 上看得见该行与其值**。
- **V4 deleted-after-T 重现**：建记录 → 取 T → 删除 → T-state（includeDeleted）含该行，`existsAtT:true`、值 = T 快照、`existsNow:false`；同 fixture 一条 created-after-T 记录**不**出现。
- **V5 T-state field-mask**：对 viewer 隐藏的字段，其键不出现在 live 行与非 live 行的 data 中（两行同测）。
- **V6 批量面边界**：`recordIds` 缺失/空/超 100 → 400 fail-closed；请求形状层面不存在 wildcard 语义（契约测试 + 显式 invalid-value 测试）。
- **V7 resurrect 守卫**：无 `canDeleteRecord` → 与 not-found 同形拒绝；缺 typed confirm → 400 `CONFIRM_REQUIRED`；flag OFF → inert（与 flag 引入前 byte-identical）；id 已存活 → 复活拒绝（幂等哨）。
- **CI 接线（两点接线纪律）**：real-DB golden 必须**显式加入** `plugin-tests.yml` 真库白名单（skip-when-unreachable 陷阱：哨兵嵌在 describeIfDatabase 里保护不了自己）；本计划不依赖 `views` 迁移簇（CI 测试库排除簇，接不进 CI 的测试不写）；FE spec 必须**显式加入** required `web-tests` 过滤器（`run-required-web-tests.sh`——R12 收官 §3.1 教训：不接线的 spec 在零个 workflow 里跑）。
- 若 OD-B2 裁 A（新账本表）：迁移**必须**是 `zzzz` 前缀 TS 迁移（zzzz-ordering：数字 SQL 迁移先于所有 zzzz 表创建运行会静默 no-op），并以 fresh-DB 全量 migrate 验证。

## 7. 明确不做（out of scope，逐条显式）

1. **Lane A**（revision 政策 / 完整性守卫）——平行锁，另文；本文不预占其裁量。
2. **Lane C**（retention 与 Reset 并存、>5000 async 路径、运维阶梯）——§4.1 只声明诚实降级，不设计 retention 交互。
3. **R14 base 级整体恢复**（跨表原子 restore、config revision 联动）——**owner-gated HOLD。Lane B 的批量面不是也不得演化为它的走私通道**（B-LOCK-6：显式 id 列表 ≤100、无 wildcard、无跨表 scope）；批量 resurrect 亦因同理推迟（§4.4）。
4. T8-2 destructive Reset 的任何语义变更；T8-1 整表 revert 面本身（Lane B 只**复用**其 undelete 底盘，不改其锁）。
5. 新权限模型 / 新 RBAC / as-of-T 权限时间旅行（权限永远按当前定义评估；rule-deny 的求值**输入**选择 ≠ 权限模型变更，见 OD-B1）。
6. 4d 红线内的任何“追溯恢复”：tombstone forward-only，capture 开启前销毁的数据不得假装可恢复。
7. schema/字段结构的 T-state（字段定义按当前 schema；快照携带已不存在字段 → 沿既有 SCHEMA_DRIFT/排除语义，不做 schema 回放）。
8. config（视图/字段定义）恢复面——已有 config-restore 自己的锁链，Lane B 不触。

## 8. 待 owner 裁决（OD-B；裁决前对应切片不实现）

| # | 问题 | 推荐 | 备选 |
|---|---|---|---|
| **OD-B1** | 非 live 行的 **rule-deny 求值基**（B-LOCK-5 唯一裁量点） | **对「被披露的 T 快照」求值**（2b LOCK-2 共享核，deny-wins ∪ grant-deny，fail-closed）：披露什么就按什么判——被规则隐藏的值不因“已删除”而经历史泄露，且与 resurrect 复活成的数据一致 | (b) 对 last-known 快照（trash `data` / 最新 revision）求值——2b LOCK-1 字面平移，但存在「T 快照命中规则而 last-known 不命中 ⇒ 泄露」的窗口；(c) 两基并集取最严（成本略高，语义最保守） |
| **OD-B2** | `operationId` 幂等账本载体 | **A：独立 append-only 账本表**（镜像 tombstone 表设计原则：无 FK、surrogate PK、`(scope, operation_id)` 唯一约束、retention 后议归 Lane C）——批量面一 op 一账天然成立 | B：`meta_record_revisions` 加列——单条面够用，批量/一 op 多 revision 表达力不足，且把幂等状态和历史数据耦死 |
| **OD-B3** | T-state 读面形态 | **A：T7 端点 + `includeDeleted` 参数（默认 false，byte-identical）**——一个时点真源，零新端点 | B：新端点并行——契约更干净但两处时点语义需长期同步 |
| **OD-B4** | 单条 resurrect 对 T8-1 底盘的复用度 | **完整继承**：`MULTITABLE_ENABLE_PIT_UNDELETE` 同一 flag + `canDeleteRecord` + typed confirm + inbound replay 沿 4c-3 flag/A′ 锚 | 若 owner 要求本面独立 flag（与整表 revert 分别开关），请在此裁决——推荐仍同门槛、只加不减 |
| **OD-B5** | deleted-after-T 行在**读面**的能力门 | **读 = `canRead` + mask**（与 history batch detail 既有披露口径一致——删除快照本就以 masked 形态可读）；**执行 resurrect = `canDeleteRecord`**（与 trash/T8-1 一致） | 若 owner 认为时点读面对已删行应提门到 `canDeleteRecord`（trash-list 口径），请在此裁决 |
| **OD-B6** | asOf→targetVersion 解析归属（单条值恢复复用 T6-2 by-version 主干） | **预览服务端解析并绑入 identity**（client 永不自报 version 映射）——无新语义，列出仅为确认 | — |
| **OD-B7** | UI 动线 | History Center 内新「时点视图」入口 + 批次/记录行「预览此时点」；现有列表默认形态不动 | 若 owner 想要独立于 History Center 的时点页，请在此裁决 |

## 9. 实施切片建议（ratify 后逐片独立 opt-in；每环独立 PR + 对抗审，staged lineage）

1. **B1** T-state 读面（B-LOCK-1/5；V1 读支、V3、V4、V5）——依赖 OD-B1/B3/B5。
2. **B2** 单记录 T-state 预览 + History Center 只读入口（B-LOCK-2/3；V1、V3 预览支）——依赖 B1。
3. **B3** 幂等账本 + 单条值恢复 execute（B-LOCK-4；V2）——依赖 OD-B2/B6；如新表 ⇒ zzzz TS 迁移 + fresh-DB 全量验证。
4. **B4** 单条 resurrect（B-LOCK-6 单条侧；V7）——依赖 OD-B4 + B3 的账本。
5. **B5** 批量值恢复面接 operationId（B-LOCK-6 批量侧；V6）——依赖 B3。

每片交付 = 实现 + real-DB golden（含正控腿）+ CI 两点接线自证 + 独立对抗审；**本文自身不含任何实现，不因合入而改变任何运行时行为。**
