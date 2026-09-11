# 映射源字段「不存在」不再静默覆盖目标值（X02）— 设计

- 日期：2026-09-11
- 分支：`fix/transform-source-field-absent`（基于 `919582e71`）
- 范围：`plugins/plugin-integration-core/lib/transform-engine.cjs`、`plugins/plugin-integration-core/lib/pipeline-runner.cjs`
- 核心原则：**「字段不存在」不等于「值为空」。**

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

## 3. 三种情况分别怎么处理（写在 `transform-engine.cjs:282-312`）

```
resolved = resolveSourcePath(sourceRecord, mapping.sourceField)
usedDefault = isBlank(resolved.value) && hasOwnProperty(mapping, 'defaultValue')   // 与改动前 233 行同款
outputValue = transformValue(fieldValue, mapping.transform, sourceRecord)

不写的充要条件： !resolved.found && !usedDefault && outputValue === undefined
```

| 情形 | 行为 | 与改动前相比 |
| --- | --- | --- |
| 路径**不存在**，无 `defaultValue`，transform 链也没造出值 | **不写目标字段**（键根本不出现在 payload 里）+ 记 `SOURCE_FIELD_ABSENT` | **本表中只有这一格与改动前不同** |
| 路径存在、值是 `null` / `''` / `0` / `false` / 显式 `undefined` | 照旧写 | 不变 |
| 配了 `mapping.defaultValue`（含显式 `undefined`） | 照旧走默认值，优先级不变 | 不变 |
| 路径不存在，但 transform 链自己产出了值（`concat` 带 `values`、`dictMap` 带 `defaultValue`、`defaultValue` 步骤） | 照旧写 | 不变 |

第三个条件 `outputValue === undefined` 是刻意的：它保证**今天能跑通的管道不会开始少写字段**。只有"从头到尾谁都没给出值"才落到不写。

### 不写不等于跳过守卫

改动前 `setPath` 承担了两件事：路径安全检查 + 写入。跳过写入会连带跳过检查，那是把守卫放松。所以把检查拆成 `parseTargetPath`（`transform-engine.cjs:98-109`，逻辑与原 `setPath` 开头**逐字相同**），`setPath` 改为调用它（`:111-112`），而"不写"分支里**先调用 `parseTargetPath(targetField)` 再记 warning**（`:300`）。于是 `targetField` 为 `__proto__` / `x.constructor.y` 的映射，无论源字段在不在，都照旧抛 `TransformError` → 落进 `errors` → `ok === false`。变异 M4 证明这条线是活的。

`required` 语义也没动：`validator.cjs` 的 `validateRecord` 用 `getPath(record, field)` 读目标值（`validator.cjs:234`），没写的键读出来还是 `undefined`，`required` 照旧判 `REQUIRED`。

## 4. 编码信号：照的是哪个先例

**两个先例，各照一半，都在仓内，没有自创格式：**

1. **条目形状**照 `transform-engine.cjs` 自己的 `errors` 条目（改动前 `:239-246`）：
   `{ field, sourceField, index, code, message, details }`。新的 warning 条目字段名、顺序完全一致，只是 `code` 换成 `SOURCE_FIELD_ABSENT`（`transform-engine.cjs:301-308`）。同一个函数产出、同一批消费者读，形状统一。
2. **数组名与"非致命"语义**照 `lib/stock-preparation-source-preflight.cjs`：那里 `SOURCE_PREFLIGHT_WARNING_CODES`（`:380-398`）配 `warnings.push({ code, detail })`（`:1859-1915`），warning 不改判定结果，只是被读出来。所以这里也叫 `warnings`，且**不参与 `ok` 的计算**。

**运行级呈现**照 `pipeline-runner.cjs` 自己的 `buildProvenanceDetails()`（`:1004-1008`）：一个跑在 try 外面的运行级计数器，只在 `> 0` 时进 `finishRun` 的 `details`，并且**成功路径和失败路径两处都带上**。新增的 `buildSourceFieldAbsentDetails()` 就在它下面（`pipeline-runner.cjs:1010-1023`，`const` 在 `:1014`），接线在 `:1214`（成功）与 `:1242`（失败）。

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

- `SOURCE_FIELD_ABSENT` **不增加** `metrics.rowsFailed`（`pipeline-runner.cjs:781-800` 只记计数器，不碰 metrics）。
- 因此 `metrics.rowsFailed === 0` 仍成立 → `lastSuccessfulWatermark` 照常更新（`:1172`）→ `watermarkMayAdvance` 为真（`:1186`）→ **水位照常推进**，run 状态仍是 `succeeded`。

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
4. **`http-routes.cjs`**：被溯源 pin 钉住，未改（`transformRecord` 在 `:3280`、`:3306` 的两个调用点只读 `.ok` / `.value` / `.errors`，新增的 `warnings` 对它们透明）。
5. **`external-write-dry-run.cjs:784`**：dry-run 规划器同样调用 `transformRecord`，本刀让它自动受益于"不写"，但**没有**在它的 `counts` / `rowErrorTypes` 里增加 `source_field_absent` 口径。要在 dry-run 报告里也看见这个码，是后续单。
6. **`metrics` 形状**：没有加字段。`run-log.cjs:45-52` 的 `normalizeMetrics` 只透传 5 个已知键，加进去也会在落库时被丢掉；运行级可见性统一走 `details`。
7. **`apps/web` 的错误码文案**（`errorCodeLabels.ts`）：本刀不碰（被在飞 PR 占用）。`SOURCE_FIELD_ABSENT` 目前只在运行详情里以裸码出现。

## 7. 血缘与守卫一览（改动后行号）

| 位置 | 作用 |
| --- | --- |
| `transform-engine.cjs:29` | `SOURCE_FIELD_ABSENT` 常量 |
| `transform-engine.cjs:61-81` | `resolveSourcePath` —— 可分辨性 |
| `transform-engine.cjs:98-109` | `parseTargetPath` —— 从 `setPath` 拆出的写侧路径守卫 |
| `transform-engine.cjs:282-312` | `transformRecord` 的三分支处置 |
| `transform-engine.cjs:300` | 不写分支里仍然跑写侧路径守卫 |
| `transform-engine.cjs:329` | `ok` 仍然只看 `errors` |
| `pipeline-runner.cjs:75-78` | 字段对上限 50 |
| `pipeline-runner.cjs:781-800` | 每行的计数与字段名收集（不碰 metrics） |
| `pipeline-runner.cjs:1010-1023` | 运行级 details 构造 |
| `pipeline-runner.cjs:1214` / `:1242` | 成功路径 / 失败路径都带上 |
