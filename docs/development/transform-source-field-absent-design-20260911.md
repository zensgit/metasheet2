# 映射源字段「不存在」不再静默覆盖目标值（X02）— 设计

- 日期：2026-09-11
- 分支：`fix/transform-source-field-absent`（基于 `919582e71`）
- 范围：`plugins/plugin-integration-core/lib/transform-engine.cjs`、`plugins/plugin-integration-core/lib/pipeline-runner.cjs`、`plugins/plugin-integration-core/lib/external-write-dry-run.cjs`
- 核心原则：**「字段不存在」不等于「值为空」。**
- 返修（X02 终审）：第一版的门在生产路径上空转——见 3.1/3.2。本文中标注「返修后」的行号以返修后的文件为准。

## 1. 缺陷与调用链（实读行号）

改动前的链条：

1. `plugins/plugin-integration-core/lib/pipeline-runner.cjs:776`（改动前行号）
   `const transformed = transformRecord(sourceRecord, context.pipeline.fieldMappings || [])`
2. `plugins/plugin-integration-core/lib/transform-engine.cjs:232`（改动前行号）
   `let fieldValue = getPath(sourceRecord, mapping.sourceField)`
3. `transform-engine.cjs:34-41`（改动前行号）`getPath` 走 `reduce`，只要有一段取不到就返回 `undefined`。
4. `transform-engine.cjs:237`（改动前行号）`setPath(value, targetField, transformValue(...))` —— 把 `undefined` **写进**目标 payload。
5. `plugins/plugin-integration-core/lib/adapters/metasheet-multitable-target-adapter.cjs:162-168`
   `projectRecordForWrite` 按 `Object.entries(record)` 投影；
   `:310-315` 走 `recordsApi.patchRecord({ changes: writeData })`。

第 5 步是这条缺陷"能造成实际损失"的证据：目标侧是 **patch**，写进来的键会覆盖，没写的键会保留。所以第 4 步把 `undefined` 塞进 payload，等价于"把目标表里原本正确的值改成空"。

而且这条路上没有对应的计数：`transformRecord` 只在 `errors` 非空时把 `ok` 置 false（`transform-engine.cjs:251` 改动前），`pipeline-runner.cjs:778` 只在 `!transformed.ok` 时 `metrics.rowsFailed += 1`，水位推进条件是 `metrics.rowsFailed === 0`（`pipeline-runner.cjs:1134`、`:1149` 改动前）。字段缺失既不进 `errors`、也不计 `rowsFailed`、也不拦水位——**静默**。

### 报告定位与实读的差异（点名）

- 报告写 `getPath` 在 `transform-engine.cjs:33-39`（或 `34-42`）。实读是 **34-41**（改动前），`function getPath` 在 34 行、闭合 `}` 在 41 行。差 1 行，结论不受影响。
- 报告写「`232…`」指 `transformRecord` 里的 `getPath` 调用。实读**正好是 232 行**（改动前），这条对得上。
- 报告说键字段由 `assertKeyValues` 挡：实读 `metasheet-multitable-target-adapter.cjs:257-266`，它只在 `mode === 'upsert'`（`:287`）时对 `keyFields` 生效，且判据是 `undefined/null/''`。所以对**键字段**而言"不存在"确实会被挡下（抛 `AdapterValidationError`）；**append 模式或 keyFields 为空时不生效**——这一点报告没说，这里点名。本刀不改这条语义。

## 2. 三种情况今天是否可分辨？—— 不可分辨，所以先做可分辨性

改动前 `getPath` 对下面三件事返回的是同一个 `undefined`：

| 情形 | 改动前 `getPath` | 是否可分辨 |
| --- | --- | --- |
| 路径不存在（源侧没有这个键） | `undefined` | 否 |
| 路径存在、值是 `undefined` | `undefined` | 否 |
| 路径存在、值是 `null` / `''` | `null` / `''` | 是（这一类本来就分得开） |

也就是说「不存在」与「存在但值为 undefined」在改动前**不可分辨**，符合任务里"如果不可分辨先把可分辨性做出来"的前提。

做法是新增 `resolveSourcePath(record, path) -> { found, value }`（`transform-engine.cjs:61-81`）：

- `value` 用 **与 `getPath` 字面相同的表达式**算出来（`current[part.key]`、数组段取 `[0]`），所以两者的 `value` 在我构造的用例里没有出现过分歧，也很难通过后续编辑单独漂移（改一处就得同时改另一处）；验证套件用 14 条记录 × 13 条路径 = **182 组**逐个 `Object.is` 比对（`__tests__/transform-source-field-absent.test.cjs` 第 5 组用例）。
- `found` 是新增信息：逐段用 `Object.prototype.hasOwnProperty.call` 判断该段是不是**自有属性**；数组段里"没有这个数组 / 不是数组 / 空数组"都算 `found = false`（没有可读的第 0 个元素）。

`getPath` 本身**一字未改**（`transform-engine.cjs:43-50`）。理由：它被 `validator.cjs:10`、`watermark.cjs:3`、`idempotency.cjs:4`、`reference-mapping-resolver.cjs:16`、`http-routes.cjs:289`、`adapters/k3-save-body-composer.cjs:20`、`adapters/data-source-sql-readonly-source-adapter.cjs:31` 共 7 处引用，都不在这一刀的范围内。特别是 `__proto__` 这类路径：`getPath({}, '__proto__')` 返回 `Object.prototype`，而 `hasOwnProperty` 判定为 `found === false`——`value` 仍然一致，只有 `found` 不同，所以不改 `getPath` 就不会动到上述 7 处引用读到的值。

## 3. 三种情况分别怎么处理（写在 `transform-engine.cjs:282-332`）

```
resolved     = resolveSourcePath(sourceRecord, mapping.sourceField)
usedDefault  = isBlank(resolved.value) && hasOwnProperty(mapping, 'defaultValue')   // 与改动前 233 行同款
defaultApplied = usedDefault && mapping.defaultValue !== null && mapping.defaultValue !== undefined

取值回填：if (defaultApplied || (usedDefault && resolved.found)) fieldValue = mapping.defaultValue
outputValue = transformValue(fieldValue, mapping.transform, sourceRecord)

不写的充要条件： !resolved.found && !defaultApplied && outputValue === undefined
```

### 3.1 为什么第二个条件不能是 `usedDefault`（X02 返修的核心）

第一版把第二个条件写成 `!usedDefault`，而 `usedDefault` 只测**键是否存在**。注册表给它经手的**每一条**映射都塞了这个键：

- `pipelines.cjs:318` `rowToFieldMapping()`：`defaultValue: parseJsonbValue(row.default_value, null)` —— `default_value` 列为 SQL NULL 时值是 `null`，**键无条件存在**（`parseJsonbValue` 在 `:115-116`）。
- `pipelines.cjs:201` `normalizeFieldMappings()`：`defaultValue: mapping.defaultValue === undefined ? null : mapping.defaultValue` —— 写入侧把 `undefined` 也折成同一个 `null`。

运行器原样透传这个数组（`pipeline-runner.cjs:395-400` `getPipeline({ includeFieldMappings: true })` → `pipelines.cjs:588` `loadFieldMappings` → `:481` `rows.map(rowToFieldMapping)`，然后 `pipeline-runner.cjs:780` `transformRecord(sourceRecord, context.pipeline.fieldMappings)`，中间没有第二次归一化）。所以 `usedDefault` 对**每一条存库映射恒为真**，第一版的不写分支在生产路径上**从未触发过**。

实测前后对照（进程内喂真函数，源记录 `{code:'MAT-001', quantity:9}`，缺 `name`）：

| 映射形状 | 返修前 | 返修后 |
| --- | --- | --- |
| 字面量 `{sourceField:'name', targetField:'name'}` | `value={}`、1 条 `SOURCE_FIELD_ABSENT` | 同（不变） |
| 存库形状 `{..., defaultValue: null}`（= `rowToFieldMapping` 的返回） | `value={"name":null}`、`warnings=[]` | `value={}`、1 条 `SOURCE_FIELD_ABSENT` |
| `normalizeFieldMappings([{sourceField:'name',targetField:'name',sortOrder:0}])` | `value={"name":null}`、`warnings=[]` | `value={}`、1 条 `SOURCE_FIELD_ABSENT` |

两种形状**唯一的差别就是一个 `defaultValue` 键**；返修后两者答案一致，这一点由 `testStoredMappingShapeIsNotBlanked` 钉住（它的映射由 `pipelines.__internals.rowToFieldMapping` / `normalizeFieldMappings` 产出，不是字面量）。

### 3.2 为什么取值回填也必须跟着收一格

只把第二个条件换成 `!defaultApplied`、把回填留作 `if (usedDefault) fieldValue = mapping.defaultValue` **修不好**：回填会把 `fieldValue` 变成 `null`，于是 `outputValue` 是 `null` 而不是 `undefined`，**第三个条件独立地再挡一次**。实测（变异 M9，只把回填改回去）：`testStoredMappingShapeIsNotBlanked` 等 5 条用例转红。

所以回填的条件收成 `defaultApplied || (usedDefault && resolved.found)`。逐象限核对，与改动前（`919582e71`）逐一比对：

| 象限 | 改动前 | 现在 | 是否变化 |
| --- | --- | --- | --- |
| 路径存在、值空（`null`/`''`），`defaultValue: null` | 回填 → 写 `null` | 回填 → 写 `null` | 不变 |
| 路径存在、值空，`defaultValue: 'X'` | 回填 → 写 `'X'` | 回填 → 写 `'X'` | 不变 |
| 路径不存在，`defaultValue: 'X'` | 回填 → 写 `'X'` | 回填 → 写 `'X'` | 不变 |
| 路径不存在，`defaultValue: null` / `undefined` / 无键 | 回填/不回填 → 写 `null`/`undefined` | **不写 + 记 `SOURCE_FIELD_ABSENT`** | **变** |

这张表不是推的：用 12 条源记录 × 3 条路径 × 5 种 defaultValue 形状 × 11 种 transform = **1980 组**，把 `919582e71` 的 `transformRecord` 与现在的逐组比对，**420 组有差异，全部落在上表最后一行**（分成三桶：无键 140、`null` 140、`undefined` 140，三桶的差异都是「本来写一个空值 → 现在不写并记一条告警」）。与第一版 HEAD（`c2b482c8b`）比则是 **280 组**，即 `null` 与 `undefined` 两桶。没有任何一组从「写了一个非空值」变成「不写」。

### 3.3 三种情况的处置表

| 情形 | 行为 | 与改动前相比 |
| --- | --- | --- |
| 路径**不存在**，无 `defaultValue`（或它是 `null`/`undefined`），transform 链也没造出值 | **不写目标字段**（键根本不出现在 payload 里）+ 记 `SOURCE_FIELD_ABSENT` | **本表中只有这一格与改动前不同** |
| 路径存在、值是 `null` / `''` / `0` / `false` / 显式 `undefined` | 照旧写 | 不变 |
| 配了非空 `mapping.defaultValue`（含 `''`） | 照旧走默认值，优先级不变 | 不变 |
| 路径存在但值空 + 任意 `defaultValue`（含 `null`） | 照旧回填后再写 | 不变 |
| 路径不存在，但 transform 链自己产出了**非空**值（`concat` 带 `values`、`dictMap` 带 `defaultValue`、`defaultValue` 步骤） | 照旧写 | 不变 |
| 路径不存在，`concat` 的部件也全缺 | **照旧写空串 `''`**，且不记告警 | 不变（**已知残留**，见 3.4） |

第三个条件 `outputValue === undefined` 是刻意的：它保证**今天能跑通的管道不会开始少写字段**。只有「从头到尾谁都没给出值」才落到不写。

### 3.4 已知残留：bare `concat` 会从零造出空串（本刀不修，只写死并钉住）

`concat`（`transform-engine.cjs:221-239`）先 `filter(part => !isBlank(part) && !isBlankAfterTrim(part))` 再 `join(separator)`，**所有部件都缺失时返回 `''` 而不是 `undefined`**。于是第三个条件为假，目标被写成空串，`warnings` 为空。实测：`{fn:'concat'}` 与 `{fn:'concat', fields:['colour']}` 在源侧全缺时都产出 `{"FSpec":""}`。

因此上一版设计文档 §3 表格第 4 行「transform 链自己产出了值」对 bare `concat` 是**假陈述**——它不是「产出了值」，它是**从零造了一个空串**。本文已改为「产出**非空**值时照旧写」，并新增 `testBareConcatStillWritesEmptyString` **钉住今天的行为**，把残留变成显式合同而不是意外。

**不把第三条件放宽成 `isBlank(outputValue)`**：实测 HEAD 上 `transform: {fn:'defaultValue', value:''}` 在源字段缺失时写出 `{"T":""}`，放宽后它会停写——那正是 `transform-engine.cjs:309-316` 注释明文承诺不做的「让今天能跑的管道开始少写字段」。正解是把「是否产出」沿 `applyTransform` 传下来，属另一刀。变异 M14 证明这条钉子是活的：一放宽，`testBareConcatStillWritesEmptyString` 立刻红。

### 3.5 定案：数组段为空 = 不存在（原 F02，本刀裁定）

`resolveSourcePath`（`transform-engine.cjs:74-77`）把「没有这个数组 / 不是数组 / 空数组」一律判为 `found = false`。返修把不写分支修活之后这条语义**变成可达的**，所以在这里定案，而不是留着。

**裁定：维持现状（空数组段 = 不存在），并补用例钉住。** 三条理由：

1. `a[]` 这个写法的字面意思是「读 `a` 的第 0 个元素」。空数组没有第 0 个元素，**没有可读的东西**，这与「读到了一个空值」是两回事——正是本刀全篇在分辨的那件事。
2. 被否掉的替代方案（`found = true, value = undefined`）**并不能交付它承诺的能力**。它写进 payload 的是 `undefined`，不是 `[]`；对 multitable 目标来说 `projectRecordForWrite`（`metasheet-multitable-target-adapter.cjs:162-168`）会把这个键原样带进 `patchRecord` 的 `changes`，落到 HTTP 上又被 JSON 序列化丢掉。也就是说它既**重新打开了本刀刚堵上的覆盖写**，又**清不掉目标**。
3. 源侧要把一个重复字段合法清空，**映射数组本身**即可：`resolveSourcePath({tags: []}, 'tags')` 是 `{found: true, value: []}`，照旧写 `[]`，目标被清空。这条路今天就通，无需改动。

钉子：`testEmptyArraySegmentIsAbsentByDecision`（两条 `resolveSourcePath` 正反例 + `tags[]` 不写 + `tags` 写 `[]`）。变异 M15（把空数组当存在）让它转红。

### 3.6 C6 外部写规划器的收敛性（终审点名的「所有视角都没看的一条路径」）

`external-write-dry-run.cjs:793` 的规划器也调 `transformRecord`。不写这个键之后：

- `writableDataFromRecord`（`:545-551`）**滤掉 `undefined`** → 该字段不在 update 的 payload 里；
- 而 `classifyExisting`（`:562-576`）原先拿**全部** `writableFields` 与库里现值比（`valuesEqual` 在 `:398-404`，`undefined ≈ null`）。

于是一行「唯一差异就是源字段缺失」的记录会被判成 `update`，写下去却是空操作，**下一轮再判 `update`**——`counts` 与 `rowFingerprints`（`:858`）永久报 churn，永不收敛。改动前它收敛，但收敛方式是把好值覆盖成 `null`。

**本刀的处理（最小、只收不放）**：`classifyExisting` 只比较**这一行真的会写出去的字段**：

```js
const comparedFields = writableFields.filter((field) => getPath(targetRecord, field) !== undefined)
```

这只会把一个本来就是空操作的 `update` 变成 `skip`；payload **确实携带**的字段照比不误，所以它不可能把一个真实差异判成 `skip`。钉子：`testPlannerConvergesWhenSourceFieldIsAbsent` 跑两轮 plan + 一次 apply，断言第 1 轮 `update`、写出去的 payload 不含缺失字段、库里旧值保留，第 2 轮收敛成 `skip` 且不再发第二次写。变异 M11（改回比全部 `writableFields`）让它转红。既有的 `external-write-dry-run.test.cjs`（1373 行）在这条改动下仍全绿。

### 3.7 不写不等于跳过守卫

改动前 `setPath` 承担了两件事：路径安全检查 + 写入。跳过写入会连带跳过检查，那是把守卫放松。所以把检查拆成 `parseTargetPath`（`transform-engine.cjs:98-109`，逻辑与原 `setPath` 开头**逐字相同**），`setPath` 改为调用它（`:111-112`），而"不写"分支里**先调用 `parseTargetPath(targetField)` 再记 warning**（`:320`）。于是 `targetField` 为 `__proto__` / `x.constructor.y` 的映射，无论源字段在不在，都照旧抛 `TransformError` → 落进 `errors` → `ok === false`。变异 M4 证明这条线是活的。

`required` 语义也没动：`validator.cjs` 的 `validateRecord` 用 `getPath(record, field)` 读目标值（`validator.cjs:234`），没写的键读出来还是 `undefined`，`required` 照旧判 `REQUIRED`。

## 4. 编码信号：照的是哪个先例

**两个先例，各照一半，都在仓内，没有自创格式：**

1. **条目形状**照 `transform-engine.cjs` 自己的 `errors` 条目（改动前 `:239-246`）：
   `{ field, sourceField, index, code, message, details }`。新的 warning 条目字段名、顺序完全一致，只是 `code` 换成 `SOURCE_FIELD_ABSENT`（`transform-engine.cjs:321-328`）。同一个函数产出、同一批消费者读，形状统一。
2. **数组名与"非致命"语义**照 `lib/stock-preparation-source-preflight.cjs`：那里 `SOURCE_PREFLIGHT_WARNING_CODES`（`:380-398`）配 `warnings.push({ code, detail })`（`:1859-1915`），warning 不改判定结果，只是被读出来。所以这里也叫 `warnings`，且**不参与 `ok` 的计算**。

**运行级呈现**照 `pipeline-runner.cjs` 自己的 `buildProvenanceDetails()`（`:1012-1016`）：一个跑在 try 外面的运行级计数器，只在 `> 0` 时进 `finishRun` 的 `details`，并且**成功路径和失败路径两处都带上**。新增的 `buildSourceFieldAbsentDetails()` 就在它下面（`pipeline-runner.cjs:1018-1029`，`const` 在 `:1022`），接线在 `:1222`（成功）与 `:1250`（失败）。

产出形状：

```json
"sourceFieldAbsent": {
  "code": "SOURCE_FIELD_ABSENT",
  "rows": 2,
  "fields": [ { "sourceField": "colour", "targetField": "FColour" },
              { "sourceField": "spec",   "targetField": "FSpec" } ]
}
```

即**计数（受影响行数）+ 字段名（源侧与目标侧两个标识符）**。

### values-free 论证

`fields` 里的两个字符串来自 `mapping.sourceField` / `mapping.targetField`，也就是**管道配置**，不是记录内容；`rows` 是整数。所以运行详情里既没有源值、没有行内容，也没有主机或凭据。验证套件对 run details 做了整串搜索，逐个断言 6 个源值都不出现。

字段对集合上了 50 的上限（`pipeline-runner.cjs:75-78` 的 `MAX_SOURCE_FIELD_ABSENT_FIELDS`，与 `targetWriteSummaries` 同一个 50），超出时加 `fieldsTruncated: true`。这是为了让运行详情有界，不是脱敏。

## 5. 水位：本刀不改，以及我的判断

事实（改动后仍然成立，并被测试钉住）：

- `SOURCE_FIELD_ABSENT` **不增加** `metrics.rowsFailed`（`pipeline-runner.cjs:781-806` 只记计数器，不碰 metrics）。
- 因此 `metrics.rowsFailed === 0` 仍成立 → `lastSuccessfulWatermark` 照常更新（`:1180`）→ `watermarkMayAdvance` 为真（`:1194`）→ **水位照常推进**，run 状态仍是 `succeeded`。

**我的判断：这一波保留现状是对的，但它是一个真实的残留缺口，应当由 owner 裁决后单独一刀处理。** 依据：

1. **改了会让今天能跑通的管道开始失败。** 源侧列名漂移、投影裁列、稀疏 JSON 都会大面积触发这个码。如果让它推不动水位，下一次增量会从同一水位重读同一批行，并且每次都停在这里——那是把一个"少写一列"的问题升级成"增量管道卡死"。任务边界里明确写了不做这类改动。
2. **水位推进在这里不再造成数据损失。** 改动前水位推进之所以危险，是因为那一轮**已经把正确值覆盖成空了**，再不重读就修不回来。改完之后那一轮"什么都没写坏"——目标表保留了原值。水位推进的后果从"丢数据且不可恢复"降级成"这一列这一轮没更新"。这是这一刀能把水位问题往后放的关键理由。
3. **真正对的解法不在水位层。** "整列在源侧消失"应该在**跑之前**用 `getSchema()` 比对拦住（明确不做，见下），而不是在跑完之后靠水位反悔；靠水位反悔只能做到"反复重试同一批"，并不能让缺的列回来。
4. **中间档也有代价。** "只在 SOURCE_FIELD_ABSENT 命中率超过阈值时不推水位"是可做的，但它要先定阈值、还要定阈值按行算还是按字段算，属于策略而非正确性，得 owner 拍板。

结论：**有意保留，且需要后续单据**——建议后续项为"运行后阈值告警"（不阻塞水位）+ "运行前 schema 预检"（阻塞运行），两者合起来才覆盖。

## 6. 明确不做（后续单）

1. **运行前 `getSchema()` 比对式预检守卫**：把 `pipeline.fieldMappings` 的 `sourceField` 和源适配器 `getSchema()` 的列集比一遍，整列缺失就在跑之前拒绝。这是更大的一刀，会牵动 `/schema` 的调用面（各适配器 `getSchema()` 的可用性、成本、权限），本刀不碰。
2. **会让今天能跑通的管道开始失败的改动**：包括把 `SOURCE_FIELD_ABSENT` 升级成 error、让它计入 `rowsFailed`、让它阻塞水位。
3. **`required` 与键字段的既有语义**：一行没改。
4. **`http-routes.cjs`**：被溯源 pin 钉住，未改（`transformRecord` 在 `:3280`、`:3306` 的两个调用点只读 `.ok` / `.value` / `.errors`，新增的 `warnings` 对它们透明）。遗留分叉照旧登记：`normalizePreviewFieldMappings`（`http-routes.cjs:2991-2996`）是纯透传，预览用的是 HTTP JSON 原样的映射；JSON 表达不出 `undefined`，而「没有 `defaultValue` 键」与「`defaultValue: null`」在返修后**处置相同**，所以这条分叉在本刀之后不再造成预览与存库不一致——但它仍是一个没有归一化的入口，后续单。
5. **dry-run 报告口径**：`external-write-dry-run.cjs` 的 `counts` / `rowErrorTypes` **没有**新增 `source_field_absent` 口径；本刀在那边只做了收敛性修复（见 3.6）。要在 C6 报告里也看见这个码，是后续单。
6. **`metrics` 形状（裁决 (a)：只登记，不做）**：终审要求把 `sourceFieldAbsent.rows` 抬进 `metrics`，理由是运行历史面板只渲染 status/metrics/errorSummary/targetWriteSummaries。**实读复验后本刀不做**：`run-log.cjs:45-52` 的 `normalizeMetrics` 只透传 5 个已知键，而 `finishRun`（`run-log.cjs:108-126`）把它们作为**独立列**交给 `updatePipelineRun`（`rowsRead` / `rowsCleaned` / `rowsWritten` / `rowsFailed` / `durationMs`），没有一个通用的 metrics JSONB。多一个指标就要多一列，是落库形状变更 + 迁移，超出本刀边界。
   顺带订正终审的一个前提：`targetWriteSummaries` 其实也在 `details` 里（`pipeline-runner.cjs:1218-1220` 写入，`apps/web/src/views/IntegrationWorkbenchView.vue:3285` 读的是 `run.details?.targetWriteSummaries`），所以「面板只渲染 metrics」并不完全成立——**面板已经在读 details 的某些键**，`sourceFieldAbsent` 要可见，正确的一刀是在前端加一个 details 读点，而不是改落库形状。该前端改动本刀不做（与在飞 PR 的前端文件冲突面重叠）。
7. **`apps/web` 的错误码文案**（`errorCodeLabels.ts`）：本刀不碰（被在飞 PR 占用）。`SOURCE_FIELD_ABSENT` 目前只在运行详情里以裸码出现。
8. **bare `concat` 的行为修正**：见 3.4，本刀只订正口径 + 钉住现状。

## 7. 血缘与守卫一览（返修后行号）

| 位置 | 作用 |
| --- | --- |
| `transform-engine.cjs:29` | `SOURCE_FIELD_ABSENT` 常量 |
| `transform-engine.cjs:61-81` | `resolveSourcePath` —— 可分辨性（`:74-77` 空数组段 = 不存在，见 3.5） |
| `transform-engine.cjs:98-109` | `parseTargetPath` —— 从 `setPath` 拆出的写侧路径守卫 |
| `transform-engine.cjs:287-288` | `usedDefault` —— **只**管取值优先级，与改动前同款 |
| `transform-engine.cjs:296-298` | `defaultApplied` —— 「默认值真的给出了值」，空默认不算（3.1） |
| `transform-engine.cjs:305` | 取值回填，收成 `defaultApplied || (usedDefault && resolved.found)`（3.2） |
| `transform-engine.cjs:317` | 不写的三条件，第二条用 `!defaultApplied` |
| `transform-engine.cjs:320` | 不写分支里仍然跑写侧路径守卫 |
| `transform-engine.cjs:349` | `ok` 仍然只看 `errors` |
| `pipeline-runner.cjs:75-78` | 字段对上限 50 |
| `pipeline-runner.cjs:786-806` | 每行的计数与字段名收集（不碰 metrics）；`:790` 按 code 过滤后再计行，`:800` 先去重再判上限 |
| `pipeline-runner.cjs:1018-1029` | 运行级 details 构造 |
| `pipeline-runner.cjs:1222` / `:1250` | 成功路径 / 失败路径都带上（dry-run 走成功路径，见验证文档） |
| `external-write-dry-run.cjs:562-576` | C6 规划器只比较「这一行真的会写出去的字段」（3.6） |
