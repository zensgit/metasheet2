# 多维表派生字段 —— 借鉴开发计划 + 门控 TODO

> Date: 2026-05-26 · 依据: `docs/research/multitable-vs-teable-hyperformula-comparison-20260526.md`
> 状态: **计划，非开工令**。每个条目都是一次**独立的显式 opt-in**（遵循 staged-opt-in 纪律），我不会自动开下一条。
> K3 PoC Stage-1 锁仍在：多维表内核打磨**允许**，但 `integration-core`/RBAC/auth **一律不碰**；阶段二(数据工厂)相关条目**冻结**。

## 标记图例
- ✅ 已完成
- ⬜ **可启动**（无 K3 阻塞，属内核打磨；仍需你点头 opt-in 才动手）
- 🔒 **门控**（被一个 gate 挡住：要么需要一次 scope 决策/RFC，要么需 K3 GATE PASS / 阶段二解锁）
- ❌ **明确不做**（地基级风险或已有更优绕法）

## 许可证速查（决定"抄代码"还是"抄思想"）
- Teable `packages/*`（`@teable/formula` ANTLR 解析器、`core` 字段域、`db-main-prisma` schema）= **MIT** → **可改用/改写进产品**。
- Teable `apps/*`（`calculation`/`field` 后端服务）= **AGPL-3.0** → **仅借思想**，不复制代码。
- HyperFormula = **GPLv3 或 商业专有** → **仅借思想**（当依赖须购商业授权）。

---

## 0. 基线（已完成）

- [x] ✅ **T0** OSS 逐文件对标文档 —— `docs/research/multitable-vs-teable-hyperformula-comparison-20260526.md`
- [x] ✅ **A1** formula recalc 接进网格 PATCH —— PR #1883 **MERGED** `9e3fcf549`（2026-05-26；详见 Track A）
- [x] ✅ **A1.1** formula 字段写入设为只读 —— PR #1890 **MERGED** `3dae1ed3`（2026-05-26；详见 Track A）

---

## 1. Track A — 多维表 formula 正确性修复（内核打磨 / 我们自己的代码 / 许可证零风险）

> 价值最高、风险最低、不碰任何冻结区。**建议的第一步 = A1。**

- [x] ✅ **A1 (SHIPPED — PR #1883, MERGED `9e3fcf549` 2026-05-26) 把 formula recalc 接进网格写路径**
  - **缺陷（已修）**：`recalculateRecord` 此前只在 `/views/:viewId/submit` 触发，且从 `record.data[fieldId]`（计算值/空）取表达式而非 `field.property.expression` → 网格 PATCH 改引用字段后 formula 陈旧。**重定义为"先修表达式语义、再接线"**（光接线算不出值）。
  - **如建（as-built）**：① `recalculateRecord` 以 `property.expression` 为准（仅 expression **键缺失**的老记录回退 data `=…` 串，`hasOwnProperty` 守卫；空/非串=无公式不回退）、合并仅 formula 键写回、不 bump version；② `RecordWriteService.patchRecords` 新增**必填** `recalculateFormulaFields`（按 `formula_dependencies` 门控），重算值进响应 `records` + 实时 `recordPatches[].patch` + `fieldIds`（其它客户端经 `applyRemoteRecordPatch` 合并新值，**无需前端改动**，已验证）；③ 表单提交路径叠加返回值。
  - **Yjs 边界（修正先前假设）**：`patchRecords` 也被 Yjs 协同桥(`yjs-record-bridge.ts`)调用，但桥处把 `recalculateFormulaFields` 与既有的 `applyLookupRollup`/`computeDependentLookupRollupRecords` 一样**置 no-op stub** → **formula recalc 不在协同编辑路径触发**（与 lookup/rollup 一致）。协同路径的 formula 重算是单独议题，非本 PR。
  - **测试**：engine 语义 + 接线断言（后端单测 2338 全绿）+ tsc 绿；e2e 真 wire case（`POST /api/multitable/patch`→25）已写，本地无 :7778/:8899 被 skip（需起前后端跑真绿）。
  - **K3 / OSS**：仅多维表内核；未触碰 integration-core/K3/RBAC/auth/存储；未引入 OSS 代码。

- [x] ✅ **A1.1 (SHIPPED — PR #1890, MERGED `3dae1ed3` 2026-05-26) 把 formula 字段值写入设为只读**
  - **背景**：A1 未改 `validateChanges`（执行单要求"readonly 语义不变"），它仍允许客户端把 `''`/`=…` 写进 formula 字段值。
  - **如建（as-built）**：`validateChanges` 把 `formula` 并入 `lookup`/`rollup` 的 `RecordFieldForbiddenError`(FIELD_READONLY) 只读分支；并删掉写循环里现已 dead 的 formula skip（validateChanges 先行）。
  - **pre-check 结论（已做）**：formula 经 `deriveFieldPermissions`(`permission-derivation.ts:58`)→`readOnlyFieldIds` **已是 UI 只读** → 网格从不 PATCH formula；create/form-submit 走**独立** `record-service` 校验、不受影响；recalc 物化写是直连 DB UPDATE、不过 validateChanges。无生产写入方被破坏；唯一一个依赖旧"静默跳过"的测试已改成 empty-change no-op。2340 后端单测通过、tsc 绿。

- [ ] ⬜ **A2 记录内 formula 链拓扑排序**
  - **现状缺陷**：`recalculateRecord` 循环读**原始** `data`、写 `updates`，所以 `B={fld_A}` 且 A 也是 formula 时，B 读到 A 的旧值/公式串 —— 无序。
  - **做什么**：对记录内 formula 字段按依赖做局部拓扑序求值。注意：`formula_dependencies` 记的是**表级 field→field 边**，不是单记录内的求值链；这里**复用它的边数据**（过滤出当前记录的 formula 字段子图来定序），不是直接复用一套现成机制 —— 需新写记录内的局部定序。
  - **验收**：单测 —— B 引用 A（皆 formula），单次重算后 B = 基于 A 新值的结果。
  - **工作量**: S · **风险**: 低 · **依赖**: 与 A1 同改更省事
  - **K3**: 允许

- [ ] ⬜ **A2b 宏展开转义/注入加固**
  - **现状缺陷**：`evaluateField` 把字段值字面替换进表达式字符串；值含引号 / `{fld_` / 运算符时会污染表达式。
  - **做什么**：对替换值做安全编码（或被 Track B 的真解析器整体取代后作废）。
  - **验收**：对抗性单测（值含 `"`、`{fld_x}`、`1+1`、超长串）。
  - **工作量**: S · **风险**: 低 · **依赖**: 若决定做 B 则可并入/废弃
  - **K3**: 允许

---

## 2. Track B — 用真正的字段引用解析器替换宏展开（需 scope-gate；Teable `@teable/formula` 是 MIT 可改用）

- [ ] 🔒 **B1 [scope-gate / 出一份短 RFC] 选型：改用/改写 `@teable/formula` vs 保留并加固宏展开**
  - **为什么**：宏展开（字符串替换 + 喂给 A1 引擎）本质脆弱；Teable `packages/formula` 用 ANTLR 把表达式解析成 AST、`FieldReferenceVisitor.getReferenceFieldIds()` 直接抽依赖。**许可证 MIT，可安全改用。**
  - **门**：这是一次有意义的新子工作面 → **需你显式 opt-in** 才进入。产出 = RFC（取舍 + 迁移面 + 风险）。
  - **K3**: 内核打磨范畴，但作为"新子战线"需 scope-gate 点头

- [ ] 🔒 **B2 集成 ANTLR 解析 + AST 依赖抽取（若 B1 选"改用"）**
  - **做什么**：用 ANTLR 解析替换正则 `{fld}` 抽取 + 宏展开求值；`formula_dependencies` 的填充改为从 AST visitor 抽取。
  - **验收**：与现行为的 parity 测试套件（同表达式同结果）+ 依赖抽取覆盖跨字段引用。
  - **工作量**: M–L · **风险**: 中 · **依赖**: B1
  - **K3**: 同 B1

---

## 3. Track C — 统一派生字段依赖图（更重；需 scope-gate；借 Teable `calculation` 的**思想**，AGPL 不抄码）

> 这是"让多维表派生字段真正成熟"的地基：支持多跳传递、派生字段可被再引用、环检测。属较大投入，作为一个 bundle 的 scope-gate。

- [ ] 🔒 **C1 [scope-gate RFC] 统一依赖边表**
  - **做什么**：把现有 `formula_dependencies` 泛化成统一的 `Reference(from_field_id,to_field_id)` 边表，覆盖 formula + lookup + rollup（字段保存时按类型抽取依赖并 upsert）。
  - **来源/许可证**：思想来自 Teable `reference.service` / `field-supplement.service`（AGPL，**仅借思想**）。
  - **工作量**: M · **风险**: 中 · **依赖**: 与 B 协同最佳
  - **K3**: 需 scope-gate

- [ ] 🔒 **C2a 多跳传递闭包重算（内存版，不引入物化）**
  - **为什么**：现状单层（A rollup B、B rollup C，改 C 只更新 B 不更新 A）。
  - **做什么**：用递归 CTE/内存拓扑求传递闭包，按拓扑序级联重算 —— 但**派生值仍读时计算、不落库**。代价：多跳 + 读时计算 = 重入读（每跳重算下层），深链性能差。先验证正确性再谈性能。
  - **验收**：A→B→C 三跳传递正确。
  - **工作量**: M–L · **风险**: 中（性能） · **依赖**: C1
  - **K3**: 需 scope-gate

- [ ] 🔒 **C2b [独立 gate / 靠近存储模型，最谨慎] 派生值（有限）物化**
  - **为什么**：要让 lookup/rollup **能引用派生字段**、且多跳不重入读，必须把派生值物化（落库）。Teable 正是靠物化进物理列才支持这些。
  - **做什么**：在 blob 模型里对派生字段值做受控物化（写回 `data` 或旁表）+ 失效/重算策略。**这是一个独立的、靠近存储模型的决策 gate**，不能当作 C2a 的延续顺手做；最好并入 C1 的 RFC 显式拍板（做/不做/折中）。
  - **风险**: 高（一致性、失效传播、与 #1840 聚合路径的交互）· **依赖**: C1 的 RFC 结论
  - **K3**: 独立 scope-gate（且物化决策须显式 opt-in）

- [ ] 🔒 **C3 建字段时环检测**
  - **做什么**：color-DFS（`hasCycle` 思想）在创建/改 formula/lookup/rollup 字段时拒绝成环。
  - **验收**：建环字段被拒 + 友好报错。
  - **工作量**: S · **风险**: 低 · **依赖**: C1
  - **K3**: 需 scope-gate

---

## 4. Track D — 异步派生更新 outbox + 死信（🔒 冻结，绑定阶段二 DF-N2）

- [ ] 🔒 **D1 [冻结] 不现在做；DF-N2 详设时对照 Teable `ComputedUpdate*`**
  - **为什么**：Teable 的 `ComputedUpdateOutbox` / `OutboxSeed` / `ComputedUpdateDeadLetter` / `ComputedUpdatePauseScope` = 异步派生更新 outbox + 死信 + 暂停域，与你们 DF-N1 死信(#1848)/DF-N1.5 重放(#1857)/NiFi-provenance 方向**直接同构**，是 DF-N2 最该对照的成熟样本。
  - **门**：K3 GATE PASS / 阶段二解锁后，且作为 DF-N2 详设的一部分。关联 #1838/#1839/#1880。
  - **K3**: **冻结**（阶段二，独立 gated opt-in）

---

## 5. Track E — 存储模型（❌ 明确不做）

- ❌ **E1 不把 `meta_records` blob 迁成"每字段一物理列"**
  - **为什么不做**：地基级改造、撞 K3 锁附近热文件；且派生列 SQL 聚合的诉求 **#1840 已用"取行回内存"正确绕开**（group-subtotals/SQL-agg defer 到 #4-3b-2）。
  - **要做的只是**：在文档里把这条边界写清楚（已在对标文档 §3 完成），避免有人误开此战线。

---

## 6. Track F — 网格 A1 引擎清理（内核打磨，低优先）

- [ ] ⬜ **F1 删 `formula/engine.ts` 的死依赖图代码**
  - **现状**：`buildDependencyGraph`/`topologicalSort`/`calculationOrder` **零调用方**（唯一 `rebuildDependencyGraph` 命中是无关的 `PluginRegistry`）。
  - **验收**：删除后 build/类型/测试全绿，行为无变化。
  - **工作量**: XS · **风险**: 极低 · **依赖**: 无
  - **K3**: 允许

- [ ] 🔒 **F2 网格引擎 AST 缓存 + 环检测 —— 仅当网格公式被产品化**
  - **思想来源**：HyperFormula（GPL，仅思想）：AST 按归一化引用 hash 缓存、Tarjan SCC 环检测、脏子图局部重算。
  - **门**：除非决定把电子表格网格公式做成产品特性，否则**默认 defer**。
  - **K3**: 允许（但低优先 / 多半 defer）

---

## 7. 建议排序（这是**优先级**，不是自动流水线 —— 每条仍是一次独立 opt-in）

```
优先级（非自动推进）:
  ✅ A1（#1883）· ✅ A1.1（#1890） →  A2 · F1（顺手清理）   ← 内核打磨，下一顺位 A2
        └─ 若决定投资真引擎 ─→ scope-gate: B1 ⊕ C1（打包一份 RFC）→ B2 · C2a · C3 ·（C2b 另议）
  D（outbox）        ：保持冻结，等 DF-N2
  E（存储）          ：永不
  F2（网格AST缓存）  ：defer 到网格公式产品化
```

- **重要**：箭头是优先级顺序，**不代表做完一条自动开下一条**。每条各需独立 opt-in；我一条一条来。
- **A1 已合并**（#1883）、**A1.1 已合并**（#1890）。下一顺位 = **A2**（记录内 formula 链拓扑排序），其后视情况 F1；或走 B1⊕C1 的 RFC。各自独立 opt-in。
- **想把多维表派生字段做"扎实"** → 额外 opt-in **B1⊕C1 的 RFC**，再逐条决定 B2/C2a/C3；**C2b（物化）是最重、最靠近存储模型的独立 gate，单独拍板**。
- **阶段二相关（D）** 一律等 GATE/解锁，不在本轮。

## 8. 落地纪律（沿用既有约定）
- 任一向被序列化对象(field-by-field copy / whitelist / pick / select)新增字段 → 必须有**真实 wire 的集成测试**（A1 尤其，别只测 fixture/form-submit）。
- 单 PR 单链单 opt-in；Conventional Commits `feat(multitable): …`；`pnpm validate:all` 过门。
- 不碰 `integration-core`/RBAC/auth。涉及 `migrations` 用当前最高 `zzzz` 前缀使其排在最后。
