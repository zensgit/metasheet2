# 多维表 formula→formula 引用防御（A2-defense）—— 验证

> Date: 2026-05-26 · Branch: `runtime/multitable-formula-defense-20260526`（切自 `origin/main` 466635ad1）
> 关联: Track A / `docs/development/multitable-derived-field-borrow-plan-20260526.md` 的 A2 ·
> 上游基线: A1 #1883 (`9e3fcf549`) + A1.1 #1890 (`3dae1ed3`)
> 范围: **仅多维表内核字段校验**；未触碰 `integration-core`/K3/RBAC/auth/存储；未引入 OSS 代码。K3 PoC Stage-1 锁内允许的内核打磨。

## 1. A2 pre-check（先取证，再决定做不做 topo）

A2 原计划是"记录内 formula 链拓扑排序"（让 `B={fld_A}` 且 A 也是 formula 时算对）。落地前先做了可达性 pre-check，回答三问：

1. **前端是否禁止 formula→formula？** —— **是，三层硬阻止**：
   - token 插入器 `formulaSourceFields`（`apps/web/src/multitable/components/MetaFieldManager.vue:631`）`filter(field.type !== 'formula')`：候选里根本不出现 formula 字段，且排除自引用。
   - 表达式是 freeform `<textarea>`，但 `validateFormulaExpression` 用的就是这个**已过滤**列表 → 手打 `{fld_某formula}` 被判 "unknown field reference"，`severity: 'error'`（`apps/web/src/multitable/utils/formula-docs.ts:960`）。
   - 保存被硬禁用：error 级诊断 → 配置序列化返回 `undefined` → `fieldConfigBlockingReason` 置位 → 保存按钮 `:disabled`（`MetaFieldManager.vue:342` / `:1048`）。
2. **后端是否记录 formula→formula 边？** —— **是，无类型过滤**。`router.post('/fields')`（`univer-meta.ts`）/ `router.patch('/fields/:fieldId')` 两处都 `extractFieldReferences(expression)` → `syncFormulaDependencies`；`extractFieldReferences`（`formula-engine.ts:28`，正则 `/\{(fld_[a-zA-Z0-9_]+)\}/g`）不校验被引用字段的类型/存在性。照实写入 `formula_dependencies`。
3. **真实 API 能否绕过前端？** —— **能，完全无防护**。create/update 的 zod schema 只有 `type` enum + `property: z.record(z.unknown())`；`validateLookupRollupConfig` 只管 lookup/rollup，formula 不校验。raw API 发 `{expression:"{fld_otherFormula}"}` 会被接受并记边。

**额外（纯 UI 可达）路径**：先建 string 字段 X，建 formula B 引用 X（合法），再把 X **转成 formula**。update 路径转换 X 时只同步 X 自己的依赖、不回查引用 X 的 B → B→X 静默变成 formula→formula 边，全程没碰 raw API。

**当前 recalc 对链式的真实行为**（`formula-engine.ts` `recalculateRecord`，origin/main 版）：循环里每个 `evaluateField(expression, data, …)` 都读**同一份原始 `data`**，结果只累积到独立的 `updates`、迭代间不回灌 → B 引用 formula A 时 B 读 A 旧值。**无拓扑序 → 链式公式静默算错。**

**判定**：链式 formula 在产品引导路径上被**明确禁掉**，但可经 API + 类型转换**可达**且当前**静默算错**。因此不为"产品未暴露的功能"建 topo 机器（A2-full 降级为 future/gated），改做最小、锁安全的 **A2-defense**：后端拒绝 formula→formula（含自引用），与前端立场一致，关掉 API/转换绕道。

## 2. 改动（A2-defense，as-built）

文件：`packages/core-backend/src/routes/univer-meta.ts`

- 新增 `validateFormulaReferences(query, sheetId, fieldId, expression) → string | null`（模仿 `validateLookupRollupConfig` 风格，中文+字段 id 报错）：抽 refs；含 `fieldId` 自身 → 报错；查 `meta_fields` 这些 ref 的**当前**类型，凡 `mapFieldType === 'formula'` → 报错。
  - **精确匹配前端立场**：只拒 `formula` 类型 ref。lookup/rollup 作为 formula 输入是**允许**的（前端 `formulaSourceFields` 只排除 `type !== 'formula'`），不误伤。
  - **未知/缺失 ref 仍容忍**（后端现状：`evaluateField` 把缺失 ref 替成 `0`）——超出本次范围，单列为未来决策。
- 新增 `findFormulaReferrers(query, sheetId, fieldId) → string[]`（反向）：`formula_dependencies fd JOIN meta_fields mf` 查引用 `fieldId` 的**存活 formula 字段**。`JOIN + mapFieldType` 复检是**承重**的：`formula_dependencies` 在字段删除（`univer-meta.ts` `DELETE FROM meta_fields` 不清边）/ formula→非formula 转换（`syncFormulaDependencies` 仅在 `nextType==='formula'` 调用）时**都不清理**，会留陈旧边、指向已非 formula 的字段 —— 这些**不得**阻断转换。
- **三处强制点**（均抛 `ValidationError` → 400 `VALIDATION_ERROR`，在事务内抛 → 回滚）：
  1. create：`validateLookupRollupConfig` 之后，`type === 'formula' && property?.expression` → `validateFormulaReferences`。
  2. update：同上，`nextType === 'formula' && nextProperty?.expression`。
  3. update 转换防御：`nextType === 'formula' && currentType !== 'formula'` → `findFormulaReferrers`，非空则拒（报出引用方字段 id）。

**不做**（确认范围边界）：不动 recalc topo（那是 A2-full，单独 gate）；不加 `formula_dependencies` 清理迁移（lazy/on-edit）；不改前端（三层守卫已在）；不拒未知 ref。

## 3. soft-migration 语义（需知会）

本改动落地后，**任何已存在的、表达式含 formula 引用的 formula 字段**（此前经 raw API 或转换路径造出）会在**下次有人编辑其表达式 / 把某字段转成 formula 时**校验失败。这是**正确行为**，但对这一类记录是一次行为变化。**不加迁移**——lazy / on-edit 是恰当范围；存量链式 formula 的 recalc 误算是既有问题，不在本 PR 范围。

**严格的 on-edit（非每次写）**：update 强制点①的 `nextProperty` 会回退到存量 `row.property`，因此**仅当 PATCH payload 显式带 `property.expression` 时才校验**（`expressionInPayload` 守卫）。对存量链式 formula 做**纯改名 PATCH（不带 property）不会触发校验、不会 400**——已由单测锁定。

## 4. 测试

新增 `packages/core-backend/tests/unit/multitable-formula-reference-guard.test.ts`（**route-level**：挂真实 `univerMetaRouter()` + 内存 mock pool，打真实 `POST/PATCH /api/multitable/fields`，非手搭 helper 调用 —— 遵循 wire-vs-fixture 纪律），9 例全绿：

| 用例 | 期望 |
|---|---|
| create formula 引用另一 formula | 400，报出被引用 formula id，事务回滚（B 未落库） |
| create formula 引用自身 | 400，"引用自身" |
| create formula 引用 **lookup**（判别：不过度拒绝） | 201 放行 |
| create formula 引用**不存在**字段（保留现容忍） | 201 放行 |
| update formula 表达式改为引用另一 formula | 400 |
| 对存量链式 formula 做**纯改名 PATCH**（不带 property）| 200，表达式不变（lazy/on-edit，不过度急切）|
| 转换 string→formula 而有**存活** formula 引用它 | 400，报出引用方 id，"转换为公式" |
| 转换 string→formula 而无引用 | 200 放行 |
| 转换 string→formula 而仅有**陈旧边**（引用方已转走非 formula）| 200 放行（承重：JOIN+类型复检忽略陈旧边）|

- 全后端单元套件：**3229 passed / 86 skipped**（含本 8 例），零回归。
- `tsc --noEmit`：绿。

## 5. K3 / OSS 合规
- 仅多维表内核字段校验；未触碰 `integration-core`/K3/RBAC/auth/存储模型。
- 未引入 Teable/HyperFormula 任何代码。
- 无 migration（不新增表/列；`formula_dependencies` 已存在，沿用其 schema）。
