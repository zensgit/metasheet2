# 多维表对标：metasheet2 vs Teable vs HyperFormula（逐文件深读）

> Date: 2026-05-26 · Author: Claude (deep-read comparison) · Status: research / not a commitment
> Scope: storage model + derived-value (formula/lookup/rollup) engines. UI/grid rendering、协同(Yjs)、自动化 不在本文范围（已在前序对话中单独列出 OSS 参考）。

## 0. TL;DR

我把 **Teable**（`teableio/teable`）和 **HyperFormula**（`handsontable/hyperformula`）clone 到 `/tmp/oss-compare/`（仓库外，AGPL/GPL 代码不进我们的 git 树），逐文件读了三方的存储模型与公式/派生字段引擎。核心结论：

1. **我们有两条公式路径，正好对上两个参考**：
   - 网格 A1-单元格引擎 `formula/engine.ts` ↔ **HyperFormula**（两者都是 A1 单元格模型）。
   - 多维表派生字段 `applyLookupRollup`（在 `univer-meta.ts`）↔ **Teable `calculation` 特性**（两者都是字段引用模型）。
2. **存储模型是根分歧**：metasheet2 = `meta_records.data` **单行 JSONB blob** + `meta_links` 关系结表（混合）；Teable = **每张用户表一张物理 PG 表、每个字段一个物理列**（`dbFieldName`）。这一条直接决定了能否把 filter/sort/**aggregate 下推到 SQL** —— 关系到 #1840 `view-aggregate`。
3. **我们生产的多维表派生字段：lookup + rollup 是单跳、读时计算（不物化）、单层依赖重算**；`formula` 有持久依赖表（`formula_dependencies`，列含 `depends_on_sheet_id` 即设计上可跨表）+ 求值引擎（`MultitableFormulaEngine`，宏展开式），但 **recalc 只在公开表单提交路由 `/views/:viewId/submit` 触发，网格编辑(PATCH `RecordWriteService.patchRecords`)路径不触发** → 同一个 formula 字段：表单填报会算出值，之后在网格里改引用字段不会刷新（**跨写路径不一致** —— ✅ 已于 A1 / PR #1883 修复，见 §7.3）。Teable 用**持久化的 `Reference(from_field_id,to_field_id)` 边表 + 递归 CTE 求传递闭包 + DFS 拓扑排序 + leaf-first 重算**，并把结果**物化进物理列**，支持 formula/lookup/rollup/link 全套与多跳传递。
4. **HyperFormula 展示了一个成熟增量单元格引擎长什么样**：lexer+parser、**AST 缓存**（按归一化引用 hash，结构相同的公式共享 AST）、顶点依赖图、**脏子图局部重算**（`dirtyAndVolatileNodeIds` + `partialRun`）、**Tarjan SCC 环检测**、range 顶点带聚合缓存、结构性编辑(增删行列)的 `dependencyTransformers`、`metadata` 驱动的函数插件参数校验。我们的网格引擎相比之下是 demo 级（正则递归重解析、无 AST 缓存、依赖图基本是死代码、无环检测）。
5. **彩蛋（最值得借鉴）**：Teable 的 Prisma 里有 `ComputedUpdateOutbox` / `ComputedUpdateOutboxSeed` / `ComputedUpdateDeadLetter` / `ComputedUpdatePauseScope` —— 一套**异步派生字段更新的 outbox + 死信 + 暂停域**机制。这与我们 DF-N1 死信展示(#1848)、DF-N1.5 重放(#1857)、以及 NiFi-provenance 数据工厂方向**直接同构**，是本次最高价值的可借鉴模式。

**许可证现实（决定"借鉴"边界）**：
- HyperFormula = **GPLv3 或 商业专有 双授权**（按 license key 区分）→ 闭源商业产品里**只能借鉴模式**，要当依赖用必须买商业授权。
- Teable = apps(`nestjs-backend`/`nextjs-app`) 是 **AGPL-3.0**；但 **`packages/*`（`core` 字段域、`formula` 解析器、`db-main-prisma` схема）全部是 MIT** → Teable 的**公式解析器 + 字段模型可以安全改用/改写**，只有后端 `calculation` 编排是 AGPL（仅借鉴模式）。
- 阅读架构始终合法；**本文不复制任何代码**。

---

## 1. 方法与覆盖度（诚实声明）

**Clone**：`git clone --depth 1`（HyperFormula 全量 8.9M）+ Teable 用 `--filter=blob:none` blobless + sparse-checkout（只取 `packages/{core,formula,db-main-prisma}` 与 `apps/nestjs-backend/src/features/{field,record,calculation,view,table}`）。

**逐文件读的程度**（不假装"全读 14800 行解释器"）：
- **metasheet2（基线，全读）**：`formula/engine.ts`(1084)、`multitable/formula-engine.ts`(165)、`multitable/record-write-service.ts`(939)、`univer-meta.ts` 的 `applyLookupRollup`+`computeDependentLookupRollupRecords`(1554–1813)、存储迁移、可达性 grep。
- **Teable**：`calculation/reference.service.ts` 的递归 CTE 自读；`packages/formula/parse-formula.ts` 自读（确认 ANTLR）；Prisma 模型自读（`Reference`/`ComputedUpdate*`/动态记录表）。`calculation/{field-calculation,link,batch}.service.ts` 与 `derivate/*.field.ts` 由结构化扫描得到方法签名级映射（非逐行）。
- **HyperFormula**：`DependencyGraph/Graph.ts` 脏跟踪核心自读；增量重算/transformers/parser 缓存/顶点模型/函数插件/环检测由结构化扫描得到 file:line 级映射。
- **未覆盖**：Teable 51 个字段文件的逐型 plumbing、HF 380+ 函数实现、两边的测试套件细节。这些不影响架构层结论。

---

## 2. 两引擎映射（全文骨架）

metasheet2 有两条独立的"公式/派生值"路径，分别对上两个参考：

| 维度 | metasheet2 路径 | 对标参考 | 模型 |
|---|---|---|---|
| 网格单元格公式 (`=A1+B2`) | `src/formula/engine.ts`（读 `cells` 表的电子表格模型；经 `FormulaService` 暴露函数目录/校验，被 `MultitableFormulaEngine` 包装复用） | **HyperFormula** | A1 单元格地址 |
| 多维表派生字段 (lookup/rollup/formula) | `applyLookupRollup`（`univer-meta.ts`，生产写/读路径） | **Teable `calculation`** | 字段引用 + 跨记录链接 |

> 关键澄清（已逐一可达性 grep 验证）：
> - `routes/univer-meta.ts` 是**主多维表路由文件**（名字是历史遗留，不是 POC）；出货的记录写路径 `RecordWriteService.patchRecords` 就是从它抽取的。
> - 网格引擎 `formula/engine.ts` 的 `buildDependencyGraph`/`topologicalSort`/`calculationOrder` **没有任何生产调用方**（唯一的 `rebuildDependencyGraph` 命中是 `PluginRegistry`，与之无关）—— demo/死代码。
> - 多维表 `MultitableFormulaEngine.recalculateRecord` 全后端**只有一个调用点**：`univer-meta.ts:6666`，位于 `router.post('/views/:viewId/submit')`（公开表单提交，:6288）。网格 PATCH 写路径 `RecordWriteService.patchRecords` **只做 lookup/rollup，不触发 formula recalc**。

---

## 3. 存储模型 —— 根分歧

### 3.1 metasheet2：JSONB blob + 关系结表（混合）
- 记录：`meta_records(id, sheet_id, data jsonb, version, ...)` —— **一行一条记录，所有字段值塞在一个 `data` JSONB blob 里**，按 field id 取值（`data ->> 'fld_xxx'`）。来源：`db/migrations/zzz20251231_create_meta_schema.ts`。
- 写：`UPDATE meta_records SET data = data || $1::jsonb, version = version + 1`（`record-write-service.ts:651`）—— JSONB 合并 + 乐观锁（`SELECT … FOR UPDATE` + version 校验）。
- 链接：单独的 `meta_links(field_id, record_id, foreign_record_id)` **关系结表**（`record-write-service.ts:723`）。所以是"字段值 blob + 关系 relational"的混合。

### 3.2 Teable：每表一物理表、每字段一物理列
- 建表：`table.service.ts:145` `createDBTable()` 用 Knex `schema.createTable(dbTableName, …)`，带系统列 `__id / __auto_number / __created_time / __last_modified_time / __created_by / __last_modified_by / __version`，经 `$executeRawUnsafe` 执行。
- 加字段 = **加物理列**：`field.service.ts:428 alterTableAddField()` → `dbProvider.createColumnSchema(...)` 产出 `ALTER TABLE ADD COLUMN`；字段 id 经 `generateDbFieldName()` 映射到物理列名 `dbFieldName`（存在 Prisma `Field.dbFieldName`）。
- 读写：`reference.service.ts:175` `recordRaw2Record()` 直接读 `raw.__id / raw.__auto_number` 等原始列；写经 `convertCellValue2DBValue()` 直接落物理列。**记录不是一个 Prisma 模型** —— 它们活在动态物理表里；Prisma 只建元数据模型（`TableMeta` 存 dbTableName、`Field` 存 dbFieldName）。

### 3.3 HyperFormula：内存地址映射（无 DB）
纯内存：`AddressMapping` + `SheetMapping` + `RangeMapping` 把 `(sheet,col,row)` 映射到顶点。不是持久层，但其顶点/缓存模型对"如何组织可增量重算的派生值"有参考意义。

### 3.4 影响矩阵（为什么这条最要紧）

| 能力 | metasheet2 (JSONB blob) | Teable (列式物理表) |
|---|---|---|
| 按字段 filter/sort | `data ->> 'fld'` 表达式索引，可做但每行 JSON 抽取 | 原生列 + 普通索引 |
| **聚合下推 SQL**（#1840） | rollup/lookup 是读时计算、不物化 → **无法 `SELECT sum(col)`**，只能取行回内存算 | 派生值物化进列 → 原生 `SELECT sum/avg/...` |
| 加字段成本 | 零 DDL（blob 加键） | `ALTER TABLE`（有迁移/锁成本） |
| 稀疏/超多字段 | 天然省空间 | 物理列上限/宽表问题 |
| 派生字段可被再引用 | **不能**（lookup/rollup 不落库，链上游读不到） | 能（物化在列里，可被下游 rollup/formula 再引用） |
| 类型严格性 | 弱（JSONB 任意） | 强（列类型 + 转换器） |

**对 #1840 的直接含义**：agg-footer 的 `view-aggregate` 端点想做 SQL 聚合，在 blob 模型下对**普通字段**可行（`data->>'fld'` 强转后 `sum`），但对 **rollup/lookup 派生列不可行**（值不在库里）。这解释了为什么 #1840 设计里 "group subtotals + SQL-agg deferred (#4-3b-2)" 是对的——派生列聚合在当前存储模型下必须走"取行回内存"的慢路径。**结论：blob 模型不是 bug，是一个有意识的权衡；但它给"派生列的 SQL 聚合"画了一条硬边界。**

---

## 4. 子系统 A：网格单元格公式（`formula/engine.ts` ↔ HyperFormula）

> 前置：此引擎读 `cells` 表（电子表格网格模型，与多维表 `meta_records` 不同），**不在多维表出货写路径**上；经 `FormulaService` 暴露函数目录/校验，并被 `MultitableFormulaEngine` 包装复用。因此本节优先级低，除非网格公式被产品化。

### 4.1 metasheet2 怎么做
- **解析**：`parseFormula` 用正则 + 字符串切分**递归重解析子串**（代码注释自承 "simplified for demo… use a proper parser"）。每次 `calculate()` 从字符串**重新解析**，无 AST 缓存。
- **求值**：`getCellValue` 按需查 DB（每个未命中单元格一次 query，context 内一个 `cache` Map），pull-based 异步惰性求值。
- **依赖图**：`buildDependencyGraph` 从一张 `formulas` 表读预存的 deps，`topologicalSort` 算顺序——但**与 `calculate` 路径脱节、无调用方、无环检测**（DFS 只有 `visited` 无 `visiting`，不识别环）。
- **错误**：`calculate` catch-all 返回 `#ERROR!`；有限错误类型（`#DIV/0!`/`#N/A`/`#VALUE!`/`#REF!`）。
- 函数：约 40 个，`Map<string, fn>` 硬编码绑定。

### 4.2 HyperFormula 怎么做
- **解析 + AST 缓存**：`parser/ParserWithCaching.ts:89` `computeHashFromTokens()` 按 token 算 hash，**cell 引用用 `.hash(true)` 归一化为绝对地址** → 结构相同的公式（如 C3 的 `=A$1+B2` 与 D4 的同构式）**共享同一 AST**，`Cache` 命中直接复用（`:91`）。
- **顶点依赖图**：`DependencyGraph/` 顶点类型 `ScalarFormulaVertex`(缓存 `cachedCellValue`)/`ArrayFormulaVertex`/`ValueCellVertex`/`EmptyCellVertex`(单例)/`RangeVertex`(带 `functionCache`+`criterionFunctionCache` 缓存 SUM/SUMIF 等区间聚合)/`ParsingErrorVertex`。
- **增量重算（核心）**：编辑 → `Graph.markNodeAsDirty()`(`:298`) 把节点 id 推入 `dirtyAndVolatileNodeIds: ProcessableValue<{dirty,volatile}>`(`:46`) → `recomputeIfDependencyGraphNeedsIt()`(`HyperFormula.ts:4621`) 取脏顶点 → `Evaluator.partialRun()`(`:44`) 只对脏子图做拓扑重算 → `clearDirtyVertices()`。**只算受影响的子图，不全量重算。**
- **环检测**：`TopSort.ts` 迭代式 **Tarjan SCC**，返回 `{sorted, cycled}`，环顶点标 `#CYCLE!`（`Evaluator.ts:102`）。
- **结构性编辑**：增删行列经 `Operations.doAddRows()`(`:822`) 调 `dependencyGraph.addRows()` 平移地址 + 注册 `AddRowsTransformer`（`dependencyTransformers/`，lazy AST 变换），删除引用变 `#REF!`。
- **函数插件**：`FunctionPlugin` 模式——静态 `implementedFunctions` 声明 `{method, parameters:[{argumentType}], repeatLastArgs}`，`runFunction()` 按 `metadata` 做参数类型强转/校验/向量化（`FunctionPlugin.ts:403`）。约 390 个函数。

### 4.3 差距 + 可借鉴

| 主题 | 差距 | 可借鉴模式（GPL→仅模式） | 优先级 |
|---|---|---|---|
| 解析性能 | 每次重解析、无缓存、正则切分 | AST 缓存 + 按归一化引用 hash | 低（非出货路径） |
| 增量性 | 无（pull-based 全惰性，或死的拓扑） | 脏顶点集 + partial 拓扑重算 | 低 |
| 健壮性 | 无环检测、错误吞成 `#ERROR!` | Tarjan SCC → `#CYCLE!`；细分错误 | 低 |
| 函数扩展 | 硬编码 Map | metadata 驱动的插件 + 参数强转 | 低-中 |

**行动建议**：把 `formula/engine.ts` 的死依赖图代码（`buildDependencyGraph`/`topologicalSort`/`calculationOrder`）标记为 cleanup 候选（在 K3 锁解除后的内核打磨窗口）。除非网格公式产品化，否则不投入重写。

---

## 5. 子系统 B：多维表派生字段（`applyLookupRollup` ↔ Teable `calculation`）

**这是本次最有价值的对标。**

### 5.1 metasheet2 怎么做（`univer-meta.ts:1554` + `record-write-service.ts` Step 4）

**lookup / rollup**（`applyLookupRollup`，出货写+读路径都调）：
- **类型**：`lookup`（跨链接拉取目标字段值）+ `rollup`（对链接记录的目标字段做 count/sum/avg/min/max 聚合）。
- **单跳**：`resolveLookupValues` 读**直接链接**的 foreign 记录的 `data[targetFieldId]` **原始值**。若目标字段本身是 lookup/rollup/formula —— 因为这些**不物化进 `data`** —— 读到的是空/undefined。**即：不能对一个派生字段做 lookup/rollup。**
- **读时计算、不物化**：`applyLookupRollup` 把结果写进**内存** `row.data[fieldId]`（`:1668`）并返回给前端/广播，**不 `UPDATE` 回库**。读路径(`:1801`,`:2231`)也调它 → **每次读都重算**。好处=永不过期；代价=每读 N+1 次 foreign 查询、无法 SQL 聚合。
- **单层依赖重算**：`computeDependentLookupRollupRecords`(`:1728`) 在记录 X 变更后，经 `meta_links.foreign_record_id` 找出**直接**链接到 X 的记录、重算它们的 lookup/rollup —— **不做传递闭包**（A rollup B、B rollup C，改 C 只更新 B 不更新 A）。
- **权限感知**：`resolveReadableSheetIds` —— 跨表 lookup/rollup 尊重 foreign 表读权限（读不到的表跳过）。这点比 Teable 更早内建。

**formula**（`MultitableFormulaEngine` + `formula_dependencies` 表）—— 能力存在但**跨写路径不一致**：
- **依赖表**：`formula_dependencies(sheet_id, field_id, depends_on_field_id, depends_on_sheet_id)`（迁移 `zzzz20260413130000`），字段保存时 DELETE+INSERT 重建（`univer-meta.ts:799`）。**有 `depends_on_sheet_id` 列** → 设计上能记跨表依赖。
- **求值**：宏展开式 —— `evaluateField` 把 `{fld_xxx}` 用记录自身 `data` 里的字面值（JSON 强转）替换进字符串，再喂给 A1 网格引擎 `calculate()`。**脆弱点**：值含特殊字符/引号时的注入与转义；类型丢失。
- **单记录 / 记录内**：`recalculateRecord` 只加载**一条**记录、对它自己的 formula 字段求值；且循环里读的是**原始** `data`、写入 `updates` —— 所以**记录内 formula 引用 formula**（B=`{fld_A}` 且 A 也是 formula）读到的是 A 的旧值/公式串，**无拓扑排序**。设计上 `formula_dependencies` 有跨表列，但 `recalculateRecord` 不做跨记录传播。
- **接线缺口（关键）**：recalc 全后端**只在** `/views/:viewId/submit`（公开表单提交）触发一次。网格编辑走 `RecordWriteService.patchRecords` —— **不调 recalc**。后果：formula 字段表单填报时算出值，之后在网格里改其引用的字段，formula **不刷新、变陈旧**。

### 5.2 Teable 怎么做（`calculation/*` + `field-calculate/field-supplement.service.ts`）
- **持久化依赖图**：派生字段创建时，`field-supplement.service.ts:2194 createComputedFieldReference()` 经 `getFieldReferenceIds(field)` 抽取依赖（formula→`getReferenceFieldIds()`；rollup/lookup→`lookupOptions` 的 linkFieldId+lookupFieldId+filter/sort 字段；link→`lookupFieldId`），写入 **`Reference(from_field_id, to_field_id)` 边表**（Prisma `model Reference`, `@@unique([toFieldId,fromFieldId])`）。
- **传递闭包**：`reference.service.ts:184 getFieldGraphItems()` 用 **递归 CTE**（`withRecursive('connected_reference', …)` 双向 join）求出起始字段集的**全部传递依赖**。
- **拓扑排序 + leaf-first 重算**：`calculation/utils/dfs.ts:64 getTopoOrders()` DFS 后序拓扑，依赖先于被依赖；`hasCycle()` 色彩 DFS 环检测（建引用时即查，`field-supplement.service.ts:2238`）。
- **物化进物理列**：`field-calculation.service.ts` 按拓扑序分页取记录、算值，`batch.service.ts:batchUpdateDB()` 用**临时表 join 更新**主表物理列（chunk 由 `calcChunkSize` 控制，RxJS `bufferCount`+`concatMap`）。值落库 → 下游可再引用、可 SQL 聚合。
- **公式 = ANTLR**：`packages/formula/parse-formula.ts` 用 `antlr4ts`（`FormulaLexer`/`Formula` → `ExprContext`），AST 经 visitor 处理（`FieldReferenceVisitor` 抽依赖、`ConversionVisitor` 处理 `{field}` 引用）。该包还导出一个 SQL 编译入口 `parseFormulaToSQL(expression, visitor)`，**但本次未验证它的调用方/覆盖范围**（checkout 内未见直接 caller，`.toSQL()` 命中多为 Knex builder）—— 故不据此下任何"公式全量 SQL 下推"的结论。§3 的"Teable 能 SQL 聚合派生列"结论**只依赖物化**（`field-calculation.service` 把算好的值写进物理列），这一条是确证的。
- **链接两向维护**：`link.service.ts` 按 m2m/m2o/o2m/o2o 分别维护 FK（结表/FK 列），并经 `symmetricFieldId` **同步对称字段**（双向链接）、`extractLinkTitle` 维护链接标题。
- **异步 outbox + 死信**（彩蛋）：Prisma `ComputedUpdateOutbox` / `…OutboxSeed` / `ComputedUpdateDeadLetter` / `ComputedUpdatePauseScope` —— 大扇出的派生更新可**异步出箱、失败进死信、按域暂停**，而非全部卡在请求事务里。

### 5.3 差距矩阵（核心产出）

| 能力 | metasheet2 | Teable (`calculation`) | 差距严重度 |
|---|---|---|---|
| 派生字段类型 | lookup + rollup（出货路径）；formula（仅表单提交路径求值） | formula + lookup + rollup + conditional-rollup + link | 中-高 |
| **formula 跨写路径一致性** | **不一致**：表单提交算、网格编辑不算 → 陈旧 | 统一经 Reference 图重算 | **中-高（可见缺陷，见 §7#3）** |
| formula 求值方式 | 宏展开（字面值替换进 A1 引擎），单记录、无拓扑 | ANTLR AST + 跨记录拓扑闭包 | 中-高 |
| lookup/rollup 依赖表示 | 无持久图，按字段类型即时扫描 + 单层依赖重算 | 持久 `Reference` 边表 + 递归 CTE 闭包 | 高 |
| 多跳传递 | 单跳；单层依赖重算 | 全传递闭包 + 拓扑序级联 | 高 |
| 派生字段可被再引用 | 否（不物化） | 是（物化进列） | 高 |
| 物化/聚合 | 读时算、不落库 → 无 SQL 聚合 | 落库 → 原生 SQL 聚合 | 高（接 #1840） |
| 环检测 | 无 | 建引用时 `hasCycle` | 中 |
| 大扇出处理 | 同步在请求事务内 | 异步 outbox + 死信 + 暂停域 | 中-高（接 DF-N1） |
| 权限感知派生 | **有**（`resolveReadableSheetIds`） | （需另查） | metasheet2 领先 |
| 公式→SQL 下推 | 无 | `parseFormulaToSQL` | 中（受限于存储模型） |

### 5.4 可借鉴模式（按许可证标注）

| 模式 | 来源 | 许可证 | 落地难度 | 价值 |
|---|---|---|---|---|
| **持久 `Reference` 边表 + 递归 CTE 求闭包** | Teable `reference.service` (AGPL) | 仅模式 | 中 | 高——解锁多跳/派生再引用 |
| **建字段时抽取依赖 + 建图时环检测** | Teable `field-supplement` (AGPL) | 仅模式 | 低-中 | 高 |
| **ANTLR 公式解析 + `getReferenceFieldIds()`** | Teable `packages/formula`+`core` | **MIT 可改用** | 中 | 高（替换我们的宏展开） |
| **异步 outbox + 死信 + 暂停域** | Teable `ComputedUpdate*` (schema MIT) | 模式+schema 可借 | 中 | **最高**（见 §6） |
| **临时表 join 批量更新物理列** | Teable `batch.service` (AGPL) | 仅模式 | 中 | 中（依赖存储改造） |

---

## 6. 跨切面：异步派生更新 outbox + 死信（最高价值借鉴）

Teable 的 `ComputedUpdateOutbox` / `ComputedUpdateOutboxSeed` / `ComputedUpdateDeadLetter` / `ComputedUpdatePauseScope` 与我们正在推进的方向**直接同构**：

- **vs DF-N1 死信展示(#1848) / DF-N1.5 重放(#1857)**：Teable 把"派生字段更新失败"建模成可重放的死信记录——和我们 run 级死信/重放是同一思想，但 Teable 应用在**内部派生字段传播**层，粒度更细。这给"死信/重放该建在哪一层"提供了一个成熟参照。
- **vs 数据工厂 NiFi-provenance 方向(#1838/#1880)**：`Outbox` 模式本质是 per-update 的来源/状态记录，正是 NiFi per-record provenance 在"派生更新"语境的体现。`ComputedUpdatePauseScope`（按域暂停传播）对应数据工厂"暂停某 pipeline"的运维诉求。
- **vs 我们 `applyLookupRollup` 同步在请求事务内**：当一条记录被很多记录 rollup 时，我们的单层重算虽避免了级联爆炸，但也意味着多跳永远算不全；Teable 的异步 outbox 是"既要传递闭包、又不阻塞写请求"的工程答案。

> 注意：这是**模式借鉴**与**已决策的呼应**，不是"现在去建"。DF-N2+ / connectors 仍冻结，每步是 GATE/解锁后的独立 opt-in。

---

## 7. 这次对标实际能影响的近期决策（1–3 周）

1. **#1840 `view-aggregate`**：本文确认——blob 存储下，**派生列（rollup/lookup）的 SQL 聚合在当前模型不可行**，#1840 把 group-subtotals/SQL-agg defer 到 #4-3b-2 是正确的；普通字段聚合可做但走 `data->>` 强转。**不要**为派生列聚合去改存储模型（那是地基级改造，且撞 K3 锁附近的热文件）。
2. **DF-N2 provenance（已决 JSONB-on-existing-tables）**：Teable 用**独立 `Reference` 边表 + `ComputedUpdate*` outbox 表**，而非把血缘塞进现有表。这**不否定**我们的 JSONB-on-existing-tables 决策（我们的 provenance 是 run/record 级，不是字段依赖图级），但 Teable 的 outbox/死信**表结构**值得在 DF-N2 详设时作为对照（#1880 已记 NiFi 对标，可补一句 Teable 对照）。
3. **多维表 formula 跨写路径不一致（已验证，建议建 backlog issue）**：前端 `MetaFieldManager.vue` **有完整 formula 编辑器**（表达式/函数目录/字段引用），用户能建 formula 字段；后端 formula recalc **只在 `/views/:viewId/submit` 触发**，网格 PATCH 编辑不触发。**用户可见后果**：表单填报出来的 formula 值，在网格里改了引用字段后**不刷新、变陈旧**。严重度：中（数据正确性/陈旧，限"表单建值→网格改引用"路径）。**K3 锁下不动手实现**，但应建 issue 记录这个不一致 + 记录内 formula 链的拓扑/转义两个已知弱点，防止"以为统一支持其实只一条路径算"。修复方向（解锁后）：把 `recalculateRecord`（或其重写版）接进 `RecordWriteService.patchRecords` 的 Step 4，与 lookup/rollup 同位。
   - **[UPDATE 2026-05-26 · 已修复 = A1 / PR #1883 MERGED `9e3fcf549`]**：实现按"先修表达式语义（`recalculateRecord` 取 `field.property.expression`，仅 expression 键缺失才回退 data `=…` 串）再接 `patchRecords` Step 4c（必填 `recalculateFormulaFields` helper，按 `formula_dependencies` 门控）"。重算值进响应 `records` + 实时 `recordPatches[].patch`，其它客户端经 `applyRemoteRecordPatch` 合并、**无需前端改动**。**Yjs 边界**：协同桥按既有 lookup/rollup 模式把该 helper 置 no-op stub → formula recalc **不在协同编辑路径触发**。`validateChanges` formula 写入只读 = **A1.1 已合并（PR #1890 `3dae1ed3`）**：formula 并入 lookup/rollup 的只读拒写分支（formula 本就 UI 只读，此为后端 backstop）。
4. **网格引擎死代码**：`formula/engine.ts` 的 `buildDependencyGraph`/`topologicalSort`/`calculationOrder` 无调用方 —— K3 锁解除后的内核打磨可清理。
   - **[UPDATE 2026-06-10 · 已完成 = F1 / PR #1897 MERGED `a7c1126d6`（2026-05-26）]**：死依赖图代码已验证不存在于 `formula/engine.ts`。

> 全部受 **K3 PoC Stage-1 锁** 约束：以上是"记录/对照"，非"开工"。涉及 `integration-core`/RBAC/auth 一律不碰。

---

## 8. 许可证细节（落地前必读）

| 项目 | 部分 | 许可证 | 对闭源商业产品 |
|---|---|---|---|
| HyperFormula | 全部 | **GPLv3 或 商业专有**（license key 区分） | 仅借鉴模式；当依赖用须购商业授权 |
| Teable | `apps/nestjs-backend`,`apps/nextjs-app` | **AGPL-3.0** | 仅借鉴模式（`calculation`/`field` 服务在此） |
| Teable | `packages/*`（`core`,`formula`,`db-main-prisma`,sdk…） | **MIT** | **可改用/改写**（公式解析器、字段域、schema） |
| Teable | 品牌资产（名称/logo） | 专有 | 不可用 |

阅读架构学习永远合法。**本文不含任何被复制的源代码**，仅描述模式与 file:line 锚点。

---

## 9. 附录：本次读过的文件锚点

**metasheet2**
- `packages/core-backend/src/formula/engine.ts`（全，网格 A1 引擎；死依赖图 @1034-1080）
- `packages/core-backend/src/multitable/formula-engine.ts`（全，宏展开 `MultitableFormulaEngine`）
- `packages/core-backend/src/multitable/record-write-service.ts`（全，出货网格写路径；Step 4 lookup/rollup @775；formula 仅校验 @561）
- `packages/core-backend/src/routes/univer-meta.ts`：`applyLookupRollup`/`computeDependentLookupRollupRecords` @1554-1813；`formula_dependencies` 重建 @799；formula recalc 唯一调用点 @6666，位于 `router.post('/views/:viewId/submit')` @6288
- `packages/core-backend/src/db/migrations/zzz20251231_create_meta_schema.ts`（`meta_records.data jsonb`）、`zzzz20260413130000_create_formula_dependencies.ts`（formula 依赖表）
- `apps/web/src/multitable/components/MetaFieldManager.vue:161-229`（前端 formula 编辑器，确认可创建 formula 字段）

**Teable**（`/tmp/oss-compare/teable`）
- `apps/nestjs-backend/src/features/calculation/reference.service.ts:184`（递归 CTE）
- `.../calculation/{field-calculation,link,batch}.service.ts`（拓扑重算/两向链接/批量物化）
- `.../calculation/utils/dfs.ts:64`（拓扑 + `hasCycle`）
- `.../field/field-calculate/field-supplement.service.ts:2194`（建引用）
- `.../features/table/table.service.ts:145`、`.../field/field.service.ts:428`（建物理表/列）
- `packages/formula/src/parse-formula.ts`（ANTLR + `parseFormulaToSQL`）
- `packages/core/src/models/field/derivate/{formula,rollup,link}.field.ts`、`lookup-options-base.schema.ts`
- `packages/db-main-prisma/prisma/postgres/schema.prisma`（`Reference`@376、`ComputedUpdateOutbox`@231/`…DeadLetter`@280/`…PauseScope`@316、`TableMeta`@134、`Field`@192）

**HyperFormula**（`/tmp/oss-compare/hyperformula`）
- `src/DependencyGraph/{Graph,DependencyGraph,TopSort,FormulaVertex,RangeVertex,ValueCellVertex}.ts`
- `src/{Operations,CrudOperations,Evaluator,HyperFormula}.ts`、`src/dependencyTransformers/*`
- `src/parser/{ParserWithCaching,Cache}.ts`
- `src/interpreter/plugin/{FunctionPlugin,SumprodPlugin}.ts`（插件模式样本）

---

## 10. 一句话建议

存储模型（blob vs 列式）是地基、**别动**（撞 K3 锁、且 #1840 已正确绕开）。真正值得"读它的代码、抄它的思想"的是两条：**(a) Teable `packages/formula`（MIT）的 ANTLR 解析 + `getReferenceFieldIds` 依赖抽取**，用来在未来替换我们多维表的宏展开式 formula；**(b) Teable 的 `ComputedUpdate*` 异步 outbox+死信模式**，它和我们 DF-N1/数据工厂方向同构，是 DF-N2 详设时最该对照的成熟样本。HyperFormula 主要当"成熟增量单元格引擎的教科书"看，许可证决定了它只能借思想。
