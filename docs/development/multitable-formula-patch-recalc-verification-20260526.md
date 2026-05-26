# A1 — Formula recalc on record PATCH: verification

> Date: 2026-05-26 · Branch: `codex/multitable-formula-patch-recalc-20260526` (off `origin/main` c0707b21e)
> Scope: multitable kernel only. **No** integration-core / K3 / RBAC / auth / storage-model / OSS code.
> Plan ref: `docs/development/multitable-derived-field-borrow-plan-20260526.md` Track A / item A1.

## 1. 缺陷

多维表 `formula` 字段在**网格 PATCH 编辑**后不刷新：用户在网格里改了 formula 引用的源字段，formula 值保持陈旧。

## 2. 根因（两层，都已验证）

1. **表达式取错了源**：formula 表达式存在 `meta_fields.property.expression`（前端 `MetaFieldManager.vue` 的编辑器、以及 `formula_dependencies` 的依赖抽取都用它）。但 `MultitableFormulaEngine.recalculateRecord` 从 `record.data[fieldId]` 取表达式并要求 `startsWith('=')` —— 而 `record.data[formulaFieldId]` 存的是**计算值/空**，不是 `=…` 串。所以对"字段定义式 formula"该过滤基本 no-op，**光接线也算不出值**。
2. **recalc 只接了一条写路径**：`recalculateRecord` 全后端唯一调用点是 `/views/:viewId/submit`（公开表单提交）。网格 PATCH 走 `RecordWriteService.patchRecords`，只做 lookup/rollup，**从不触发 formula recalc**。

> 因此 A1 必须"先修表达式语义，再接 PATCH 写路径"——不能只接线。

## 3. 实现（4 处改动，全部在多维表内核）

1. **`multitable/formula-engine.ts` `recalculateRecord`**：表达式取 `field.property.expression` 为准；**仅当该字段完全没有 `property.expression`（undefined，老记录）时**才回退到 record.data 里的遗留 `=…` 串 —— `property.expression` 为空串视为"无公式"、不回退到 data 串（避免把客户端早先写进 data 的脏 `=…` 当公式算）。写回改为 **JSONB 合并仅 formula 键** (`data = data || $1::jsonb`)，避免 SELECT→UPDATE 间并发写被整块覆盖；**不 bump version**（派生值非用户编辑）。
2. **`multitable/record-write-service.ts`**：`RecordWriteHelpers` 新增**必填** `recalculateFormulaFields`；`patchRecords` 加 Step 4c —— 用真实变更字段调该 helper，把重算出的 formula 值并入响应 `records`，并注入实时广播 `recordPatches[].patch` + 把 formula 字段 id 加进 `fieldIds`。
3. **`routes/univer-meta.ts`**：新增 `recalculateFormulaFields` helper（先按 `formula_dependencies` 门控，命中才逐记录调 `recalculateRecord`），注入 `/patch` 路由的 writeHelpers；表单提交路径改为用 recalc 返回值**叠加**可见 formula 值进响应（不覆盖已合并的 link 值）。
4. **`index.ts`（Yjs 协同桥）**：`recalculateFormulaFields` 在此**置为 no-op stub**，与该桥既有的 `applyLookupRollup`/`computeDependentLookupRollupRecords` stub 一致（Yjs 协同写路径本就不做派生字段重算；formula 在协同路径的支持是单独议题，非本 PR）。

## 4. 实时陈旧问题的处理（已验证无需前端改动）

`apps/web/src/multitable/composables/useMultitableGrid.ts:applyRemoteRecordPatch` 对远端 patch 做 `data: { ...current.data, ...options.patch }` 并恒返回 true。因此把重算后的 formula 值放进广播 `recordPatches[].patch`，其它客户端会**直接合并出新值**——无需任何前端改动。`fieldIds` 里加 formula id 仅在该字段正被排序/筛选时触发整页刷新（`structuralRealtimeFieldIds` = 活动 sort/filter 字段），那种情况下整页刷新本就是正确行为。

## 5. 实现边界（本 PR 明确不做）

- A2 记录内 formula 链拓扑排序 / A2b 宏展开转义重写 —— 不做。
- B（ANTLR 解析器）/ C（统一依赖图、多跳、物化）/ D（异步 outbox）/ E（存储迁移）/ F（网格引擎）—— 不做。
- 不引入 Teable / HyperFormula 源码或依赖。
- 不改 version 语义；formula 物化不额外 bump version。
- 不改 migration / 存储模型。
- Yjs 协同写路径的 formula recalc —— stub（与 lookup/rollup 一致），非本 PR。
- 不为"顺手"把 `recalculateRecord` 改成批量形态（per-record N+1 在本 scope 可接受）。
- **`validateChanges` 对 formula 字段的写校验保持不变**（执行单验收要求"readonly 语义不变"）。现状：`validateChanges` 允许客户端把 `''` 或 `=…` 串写进 formula 字段值（不像 lookup/rollup 直接拒）。本 PR 不动它。**已知留待决策的后续项**：是否把 formula 也并入 `lookup`/`rollup` 的 `RecordFieldForbiddenError` 只读分支（彻底禁止直接写 formula 值）。本 PR 通过上面的"回退仅在 property.expression 缺失时生效"已消除该写入对计算正确性的影响（脏 `=…` 串在 property.expression 存在时被忽略），故此项是收口/防污染，不是正确性阻塞 —— 单独 opt-in 决定。

## 6. 测试

命令与结果（在 worktree `metasheet2-formula-a1` 执行）：

```
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-formula-engine.test.ts tests/unit/record-write-service.test.ts
→ 2 files / 81 tests PASS

pnpm --filter @metasheet/core-backend test:unit
→ 179 files / 2338 tests PASS（无回归）

pnpm --filter @metasheet/core-backend build   # tsc 类型检查
→ PASS（必填 helper 在编译期抓出了 index.ts Yjs 桥的漏接线，已补 stub）

cd packages/core-backend && npx playwright test --config tests/e2e/playwright.config.ts \
  multitable-formula-smoke.spec.ts
→ 5 tests SKIPPED（本地未起 backend:7778 / frontend:8899；runner 已识别新增 case 4 @:150）
```

新增/改动测试：
- `multitable-formula-engine.test.ts`：property.expression 取源 + 仅合并 formula 键写回（断言 `data || ` 且参数只含 formula 键）；遗留 `=…` 串回退；表达式失败写 `#ERROR!`；无 formula 字段不发 UPDATE。
- `record-write-service.test.ts`：依赖命中→formula 值进响应 `records` **且**进实时 `recordPatches[].patch` + `fieldIds`（锁住"其它客户端不陈旧"）；无依赖→响应/实时不含 formula。
- `multitable-formula-smoke.spec.ts` case 4（真 wire）：建 A/B/formula(`={A}+{B}`) + 记录 → 经真实 `POST /api/multitable/patch` 改 A=20 → 断言 PATCH 响应 `records` 与独立 `GET /records/:id` 的 DB 值均为 25。

## 7. 未覆盖 / 待补

- **e2e 在本地被 skip**（无 :7778/:8899）。需在起了 backend+frontend 的环境（CI e2e step / staging）跑一次 case 4 拿到真绿。当前它已被 runner 识别、断言已写死，但未实跑通过。
- formula 在 Yjs 协同写路径不重算（与 lookup/rollup 一致，已 stub）—— 如需协同实时 formula，另开 issue。

## 8. K3 / OSS 声明

- 不触碰 `plugin-integration-core` / K3 / 中央 RBAC / auth / 存储模型。
- 未引入任何 OSS（Teable / HyperFormula）代码或依赖；本次借鉴仅为"先修语义再接线"的思路。

## 9. 验收对照（对应执行单 §6）

| 验收项 | 状态 |
|---|---|
| PATCH 源字段后同记录 formula 在 DB 与 API response 更新 | ✅ 单测锁定；e2e 断言已写（待真跑） |
| 发起端能看到 formula 刷新 | ✅ 响应 `records` 携带 |
| 其它实时客户端不因只本地 patch 源字段而陈旧 | ✅ 实时 `recordPatches[].patch` 携带 formula 值（applyRemoteRecordPatch 合并） |
| formula readonly 写语义不变 | ✅ 未改 validateChanges |
| 不实现多跳/跨表/链/物化策略/ANTLR | ✅ |
