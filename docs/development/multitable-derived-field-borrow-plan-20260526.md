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

- [x] ✅ **A2-defense (PR #1896 MERGED `516176619` 2026-05-26) 后端拒绝 formula→formula 引用**
  - **A2 pre-check 结论**（落地前取证）：链式 formula 在产品引导路径被**前端三层硬禁**（token 选择器排除 `type==='formula'` + 表达式校验 error + 保存禁用），但经 **raw API**（create/update 对 formula 表达式零校验）+ **类型转换**（建 string X→建 formula B 引用 X→把 X 转成 formula）**可达**，且 `recalculateRecord` 无 topo → 链式静默算错。详见 `multitable-formula-reference-guard-verification-20260526.md` §1。
  - **判定**：不为"产品未暴露的功能"建 topo 机器；改做最小、锁安全的 defense，与前端立场一致。
  - **如建（as-built）**：`univer-meta.ts` 新增 `validateFormulaReferences`（抽 refs，含自身 / 凡 `mapFieldType==='formula'` 的 ref → 拒；**只拒 formula 类型**，lookup/rollup 作输入放行，未知 ref 仍容忍）+ `findFormulaReferrers`（反向，`formula_dependencies JOIN meta_fields` 复检存活 formula 引用方，**JOIN+类型过滤忽略陈旧边**——删字段/转走 formula 都不清边）；三处强制点：create + update 校验本字段表达式、update `nextType==='formula' && currentType!=='formula'` 时反向拒转换。
  - **测试**：新增 route-level `multitable-formula-reference-guard.test.ts`（真实路由 + 内存 pool，9 例含判别 lookup/nonexistent 放行 + 承重 stale-edge 转换放行 + 存量链式纯改名 on-edit 不触发）；全后端单元 3230 passed/86 skipped 零回归 + tsc 绿。
  - **soft-migration**：存量含 formula 引用的 formula 字段，下次编辑表达式/转换时才校验失败（lazy/on-edit，不加迁移；存量链式误算属既有问题）。
  - **K3 / OSS**：仅多维表内核字段校验；未碰 integration-core/K3/RBAC/auth/存储；无 OSS 代码；无 migration。

- [ ] 🔒 **A2-full（记录内 formula 链拓扑排序）—— 降级为 gated/future**
  - **为什么降级**：A2-defense 已使 formula→formula 在后端不可达（与前端一致），产品**不暴露**链式 formula → 没有正确性需求要支持它。topo 求值只在"决定把链式 formula 作为产品特性"时才有意义。
  - **若启用做什么**：`recalculateRecord` 循环改读"边算边回灌"的工作副本，按 `formula_dependencies` 当前记录子图局部拓扑定序；同时放宽 A2-defense 的拒绝。
  - **门**：需显式 opt-in（先回答"链式 formula 是否成为产品特性"），且与 B/C 的引擎/依赖图工作面协同最佳。
  - **K3**: 允许（但默认 defer）

- [ ] ⬜ **A2b 宏展开转义/注入加固**
  - **现状缺陷**：`evaluateField` 把字段值字面替换进表达式字符串；值含引号 / `{fld_` / 运算符时会污染表达式。
  - **做什么**：对替换值做安全编码。B1 RFC 已拍板先做 A2b、推迟解析器，因此这是耐久修复，不是短寿命补丁。
  - **验收**：对抗性单测（值含 `"`、`{fld_x}`、`1+1`、超长串）。
  - **工作量**: S · **风险**: 低 · **依赖**: 无（下一条独立 opt-in）
  - **K3**: 允许

---

## 2. Track B — 公式解析器决策（B1 已拍板：先做 A2b；解析器推迟）

- [x] ✅ **B1 RFC 已拍板（2026-05-27）→ `formula-parser-and-derived-ref-graph-rfc-b1c1-20260526.md`**（结论：**做 A2b 加固宏展开；B1a 不做、B1b 推迟**——核实 `{fld_xxx}` 正则抽取已够稳，且求值与网格引擎 46 函数紧耦合致 B1b parity 风险高）。A2b 是下一条独立 opt-in；B2 保持冻结，直到翻盘条件触发。
  - **为什么**：宏展开（字符串替换 + 喂给 A1 引擎）本质脆弱；Teable `packages/formula` 用 ANTLR 把表达式解析成 AST、`FieldReferenceVisitor.getReferenceFieldIds()` 直接抽依赖。**许可证 MIT，可安全改用。**
  - **门**：RFC 已完成并拍板；解析器路线推迟。只有公式能力要做大、或决定砍掉"多维表 formula 复用网格 A1 引擎"这层耦合，才重启 B1/B2。
  - **K3**: 内核打磨范畴，但作为"新子战线"需 scope-gate 点头

- [ ] 🔒 **B2 集成 ANTLR 解析 + AST 依赖抽取（推迟；仅 B1 翻盘后）**
  - **做什么**：用 ANTLR 解析替换正则 `{fld}` 抽取 + 宏展开求值；`formula_dependencies` 的填充改为从 AST visitor 抽取。
  - **验收**：与现行为的 parity 测试套件（同表达式同结果）+ 依赖抽取覆盖跨字段引用。
  - **工作量**: M–L · **风险**: 中 · **依赖**: B1
  - **K3**: 同 B1

---

## 3. Track C — 统一派生字段依赖图（更重；需 scope-gate；借 Teable `calculation` 的**思想**，AGPL 不抄码）

> 这是"让多维表派生字段真正成熟"的地基：支持多跳传递、派生字段可被再引用、环检测。属较大投入，作为一个 bundle 的 scope-gate。

- [x] ✅ **C1 RFC 已拍板（2026-05-27）→ `formula-parser-and-derived-ref-graph-rfc-b1c1-20260526.md`**（结论：**暂不建**——C1 只建表几乎无价值，真问题是"要不要多跳派生字段"；无具体多跳需求前单跳模型 + A2-defense 自洽。出现具体多跳需求才按 C1→C2a→C3 启动；Track C 整体保持 🔒）。
  - **做什么**：把现有 `formula_dependencies` 泛化成统一的 `Reference(from_field_id,to_field_id)` 边表，覆盖 formula + lookup + rollup（字段保存时按类型抽取依赖并 upsert）。
  - **来源/许可证**：思想来自 Teable `reference.service` / `field-supplement.service`（AGPL，**仅借思想**）。
  - **工作量**: M · **风险**: 中 · **依赖**: 需具体多跳派生需求重启 scope-gate
  - **K3**: 继续冻结

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

- [x] ✅ **F1 (PR #1897 MERGED `a7c1126d6` 2026-05-26) 删 `formula/engine.ts` 的死依赖图代码**
  - **现状**：`buildDependencyGraph`/`topologicalSort`/`calculationOrder`/`dependencyGraph` **零生产调用方**（唯一调用是一条只测内部状态的单测；`PluginRegistry`/openapi-sdk 的同名物不相关、未触碰）。
  - **如建（as-built）**：删 `engine.ts` 两字段(`calculationOrder`/`dependencyGraph`) + 两方法(`buildDependencyGraph`/`topologicalSort`)；删只覆盖它的 `describe('Dependency Graph')` 测试块。净 −82 行纯删除、无行为变化。不动 `MultitableFormulaEngine`，不做 AST 缓存/环检测/重构。
  - **验证**：tsc + `pnpm build` + eslint(0 error) + `formula-engine.test.ts`/`multitable-formula-engine.test.ts`(129 pass) + 全后端单元 3229 pass/86 skip 零回归。详见 `formula-engine-deadcode-cleanup-f1-verification-20260526.md`。
  - **工作量**: XS · **风险**: 极低 · **依赖**: 无 · **K3**: 允许

- [ ] 🔒 **F2 网格引擎 AST 缓存 + 环检测 —— 仅当网格公式被产品化**
  - **思想来源**：HyperFormula（GPL，仅思想）：AST 按归一化引用 hash 缓存、Tarjan SCC 环检测、脏子图局部重算。
  - **门**：除非决定把电子表格网格公式做成产品特性，否则**默认 defer**。
  - **K3**: 允许（但低优先 / 多半 defer）

---

## 7. 建议排序（这是**优先级**，不是自动流水线 —— 每条仍是一次独立 opt-in）

```
优先级（非自动推进）:
  ✅ A1（#1883）· ✅ A1.1（#1890）· ✅ A2-defense · ✅ F1（死代码清理）   ← 内核打磨链已落
        ├─ ⬜ A2b（宏展开转义/注入加固）：B1 已拍板为下一条独立 opt-in
        ├─ A2-full（链式 topo）：🔒 降级 gated/future（产品不暴露链式 formula；先答"是否做成特性"）
        └─ B1/B2 解析器：🔒 推迟（翻盘条件触发才重启）
  C1/C2a/C3（多跳派生）：🔒 暂不建（无具体多跳需求前保持冻结）
  D（outbox）        ：保持冻结，等 DF-N2
  E（存储）          ：永不
  F2（网格AST缓存）  ：defer 到网格公式产品化
```

- **重要**：箭头是优先级顺序，**不代表做完一条自动开下一条**。每条各需独立 opt-in；我一条一条来。
- **A1**（#1883）、**A1.1**（#1890）、**A2-defense**、**F1**（删网格死代码）均已落；**B1/C1 RFC 已拍板**。下一条可启动项 = **A2b**，但仍需独立 opt-in。
- **A2-full（链式 topo）** 已降级 gated/future（产品不暴露链式 formula，先答"是否做成特性"）。
- **B2 解析器**、**C1/C2a/C3 多跳派生** 均推迟；出现 RFC 写明的翻盘条件才重启。
- **C2b（物化）** 是最重、最靠近存储模型的独立 gate，单独拍板。
- **阶段二相关（D）** 一律等 GATE/解锁，不在本轮。

## 8. 落地纪律（沿用既有约定）
- 任一向被序列化对象(field-by-field copy / whitelist / pick / select)新增字段 → 必须有**真实 wire 的集成测试**（A1 尤其，别只测 fixture/form-submit）。
- 单 PR 单链单 opt-in；Conventional Commits `feat(multitable): …`；`pnpm validate:all` 过门。
- 不碰 `integration-core`/RBAC/auth。涉及 `migrations` 用当前最高 `zzzz` 前缀使其排在最后。
