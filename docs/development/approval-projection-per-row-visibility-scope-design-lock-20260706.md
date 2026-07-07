# 审批投影 per-row visibility_scope 继承 · DESIGN-LOCK（RATIFIED — 方案 A）— 2026-07-06

> **状态：RATIFIED（owner 2026-07-07，选定方案 A）。** v1 = 零迁移、只开「我发起 / 我做终态决策」
> 的 per-row read；#3537 admin fence 的写/管理边界不动。方案 B（中间审批人/cc）留作后续独立
> slice（届时另评估投影字段与重算一致性）。T36-1 随本 ratify 解锁。
> **committed 文档纪律**：陈述 MetaSheet 自身原则，不出现外部产品名。
>
> **战略定位**：这是审批操作面达到桌面 parity 后的下一刀 fusion 大刀——把「审批结果是一张
> 可被公式/视图/下一条自动化消费的表」从**仅 admin 可见**放开到**参与者行级可见**，让普通用户
> 真正拿到「审批 ↔ 多维表 ↔ 自动化」同一内核的体验。价值高于 batch-2 全部锦上添花项之和。
> 独立于已完成的 B3-04 候选人目录小刀。

## 1. 需求门（demand gate，具名）

T3-6 approval projection（`base_apr_projection` 下 `sht_apr_proj_<templateId>` 表）已把每个审批实例
物化为一行只读记录（字段：`templateId/templateName/status/outcome/requesterId/approverId/createdAt/
completedAt/currentNodeKey`）。#3537 后整个 base 对非 admin 关死（`restrictApprovalProjectionCapabilities`
全量降级）。**具名用例**：普通员工想在多维表里看/统计/公式化**自己参与的**审批结果（我发起的、
我审批的），而不必是管理员。这是 fusion 叙事成立的前提。

## 2. 治理门（governance gate，复用不新建）

**不新建 ACL 子系统。** 多维表已有行级读基建，全部复用：
- `meta_sheets.row_level_read_permissions_enabled`（行级读开关）
- `meta_sheets.conditional_read_rules`（条件读规则，字段-值维度）
- `filterReadableSheetRowsForAccess`（`permission-service.ts:1432`，行级读的统一 choke，#3537 已在此加 base fence）

投影行已自带参与者标识（`requesterId` + `approverId`）——per-row 可见性可由这两个字段推导，**无需
新增行级身份存储**（除非选方案 B，见 §4）。

## 3. 安全模型（与 #3537 的组合关系）

**base 级：保持 admin-only 写/管理（#3537 fence 不动）。** 本刀只开 **per-row READ 给参与者**：
- 非 admin 参与者 → `canRead=true`（当前 fence 是 `canRead=false`），但**行被过滤到「本人为参与者」的行**。
- 非 admin 非参与者 → 看不到任何行（base 仍不出现在其列表——投影表无其可读行则 base 不 surface，与 #3537 的「≥1 可读 sheet 才 surface」一致）。
- admin → 全量（不变）。
- 写/字段/视图/自动化管理能力 → 对所有非 admin 仍全降级（system-owned read-model，不可改）。

**fail-closed**：参与者判定失败/字段缺失 → 该行不可见（宁可少给，不可错给）。
**values-free 一致**：per-row 判定只读身份字段（requesterId/approverId），不读业务快照。

## 4. 机制（两方案，推荐 A）

### 方案 A（推荐）— 投影专属 per-row 参与者谓词，接进既有行读 choke
- 在 `filterReadableSheetRowsForAccess` 的投影分支（#3537 已识别投影 sheet）中，对**非 admin**：
  不再整表拒绝，改为**保留 `requesterId === actor || approverId === actor` 的行**。
- 参与者集合来源：行内既有字段，零新存储、零迁移。
- 单点改动、与 #3537 fence 同一函数，逻辑对称（fence 是「非参与者拒」的特例）。
- **代价**：`approverId` 目前是**单一决策者**（终态 decider），多级/会签的**中间审批人**与 **cc** 不在行内 → v1 可见性 = 「我发起的 + 我做终态决策的」。中间审批人/cc 可见 = 后续 slice（需扩投影字段，见 §6）。

### 方案 B（更全但更重）— 投影时写 `visibility_scope` 参与者 id 集
- 投影服务在写行时，从实例的**完整参与者集**（requester + 所有 assignment 审批人 + cc）算出 id 集，
  存入行（新列或 data 内 `_visibilityUserIds`）；行读 choke 按「actor ∈ 集」过滤。
- **优点**：覆盖中间审批人 + cc，可见性完整。
- **代价**：新列/迁移 + 投影写路径改动 + 集合随退回/加签/转办变化时的重算一致性（对齐 nodeEntryEpoch
  轮次语义）——复杂度显著高。

**推荐**：v1 走 **A**（最小、对称、零迁移，立即拿到「我发起/我决策」的 fusion 体验），把「中间审批人/cc
可见」作为**独立后续 slice**（届时可平滑升到 B 或给 A 补投影字段）。§6 明列。

## 5. 验证计划（ratify 后实现时执行）

- 真库集成（新 `.db.test.ts`，两点 CI 接线）：
  - 非 admin 发起人 → 只看到**自己发起的**投影行；看不到他人行。
  - 非 admin 决策审批人 → 看到**自己做终态的**行。
  - 非 admin 无关者 → 零行；base 不 surface。
  - admin → 全量（回归 #3537）。
  - 写/字段/自动化能力对所有非 admin 仍 false（#3537 fence 未被本刀削弱——**RED-before**：去掉参与者谓词退回整表拒，证明是加法不是替换）。
  - 参与者字段缺失/损坏 → fail-closed 该行不可见。
- 与 #3537 的 7/7 fence 测试并行绿（组合正确性）。

## 6. Out of scope（显式，各自独立 gate）

- **中间审批人 / cc 可见性**（方案 B 或 A+投影字段）——独立后续 slice。
- **写回投影**（投影仍 system-owned 只读）。
- **跨模板聚合视图 / 公式跨表引用投影**——多维表既有能力自然获得，非本刀职责。
- **DelegationSettingsView 管理员委托页手填 ID → 选人器**（owner 2026-07-06 指出的 UX tail）——
  非本刀，归 batch-2 G 尾（可复用 B3-04 的 `ApprovalUserPicker`，小切片）。

## 7. Checklist（RATIFIED 2026-07-07 — 方案 A；T36-1/2 解锁，T36-3 独立后续）

- ✅ **T36-0** 本设计锁（PROPOSED）
- ✅ **T36-1** 方案 A 参与者读——#3758。as-built 比锁面更深一层：谓词不止接进
  `filterReadableSheetRowsForAccess`（列表腿），而是挂进行级读 deny-choke 内部
  （`loadRowLevelReadDenyEnabled` 对投影表恒真 + `loadDeniedRecordIds`/
  `loadRecordPermissionScopeMap` 合入非参与者行，DENY-WINS）——W1-2 goldens 锁过的全部
  读表面免费继承。两轮审阅（owner + 对抗）各抓一个 P1 均已修：主读面被
  `hasRecordPermissionAssignments` 短路（投影表恒报 true 修复 + 真 wire 级测试）、
  Yjs 订阅无行级复核（`isRecordReadDeniedForUser` 接进 authChecker + 接线 tripwire）。
  另修 SQL 三值逻辑 fail-open（corrupt 行 COALESCE 关死）。RED-before 变异 3 组全证。
- ✅ **T36-2** 组合回归 + 文档 as-built——本 PR。#3537 fence 7/7 与参与者套件 13/13 同跑绿；
  generic deny-choke 回归 24/24；fence 测试文件借本线首次接入 CI（此前 skip-green）。
- 🔒 **T36-3**（后续独立 slice）中间审批人/cc 可见性（方案 B 评估）

---

**一句话**：投影行已带参与者身份、多维表已有行级读 choke、#3537 已把 base 关死——T3-6 v1 就是在同一个
choke 里把「整表拒非 admin」改成「保留本人为参与者的行」，最小加法即让普通用户看见自己的审批结果表。
**owner 已 ratify 方案 A（2026-07-07）——按 T36-1→T36-2 实现。**
