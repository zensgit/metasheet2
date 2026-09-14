# 映射源字段「不存在」不再静默覆盖目标值（X02）— 设计

- 日期：2026-09-11
- 分支：`fix/transform-source-field-absent`（基于 `919582e71`）
- 范围：`plugins/plugin-integration-core/lib/transform-engine.cjs`、`plugins/plugin-integration-core/lib/pipeline-runner.cjs`、`plugins/plugin-integration-core/lib/external-write-dry-run.cjs`
- 核心原则：**「字段不存在」不等于「值为空」。**
- 返修（X02 终审）：第一版的门在生产路径上空转——见 3.1/3.2。本文中标注「返修后」的行号以返修后的文件为准。
- 订正（审阅人，2026-09-11 第二轮）：「不会少写非空值」这句**原来不成立**——`dictMap: {"null": "UNKNOWN"}` 遇到缺失字段，旧版写 `UNKNOWN`、新版不写。已复现、已修（见 3.8）、差异盘点已重跑（见 3.2）。
- **后续单（2026-09-11 第三轮，分支 `fix/transform-bare-concat-empty-output`，叠在 `7aaadcdfa` 之上）**：3.4 登记的「bare `concat` 从零造空串」残留**已修**——修的是 `concat` 自己（没有一个部件被供给时产出 `undefined` 而不是 `''`），三条件与其它 step 一字未动。见 3.4 与 3.2 的第三次盘点。

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

## 3. 三种情况分别怎么处理（写在 `transform-engine.cjs:360-432`，第三轮后行号）

```
resolved     = resolveSourcePath(sourceRecord, mapping.sourceField)
usedDefault  = isBlank(resolved.value) && hasOwnProperty(mapping, 'defaultValue')   // 与改动前 233 行同款
defaultApplied = usedDefault && mapping.defaultValue !== null && mapping.defaultValue !== undefined

取值回填：if (defaultApplied || (usedDefault && resolved.found)) fieldValue = mapping.defaultValue

// 只给「会落到不写」的那一条映射；absentSourceKey 只有 dictMap 读（3.8），
// sourceFieldAbsent 只有 concat 读（3.4，第三轮）
transformContext = (!resolved.found && !defaultApplied)
                   ? { absentSourceKey: absentSourceLookupKey(mapping),   // 改动前会被查的那个键
                       sourceFieldAbsent: true }
                   : {}
outputValue = transformValue(fieldValue, mapping.transform, sourceRecord, transformContext)

不写的充要条件： !resolved.found && !defaultApplied && outputValue === undefined
```

第三轮只多了一件事：`concat` 在**一个部件都没被供给**时产出 `undefined`（而不是 `join()` 零个部件得到的 `''`），于是第三个条件对它**自然成立**。三条件本身、`defaultValue`/`dictMap`/其它 step 一字未动。

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
| 路径不存在，`defaultValue: null` / `undefined` / 无键，且链没产出值 | 回填/不回填 → 写 `null`/`undefined` | **不写 + 记 `SOURCE_FIELD_ABSENT`** | **变** |
| 路径不存在，`defaultValue: null` / `undefined` / 无键，但链里 `dictMap` 命中改动前的查表键 | 写字典的答案 | 写字典的答案 | 不变（靠 3.8 的兼容键，**这一条是本轮订正**） |

这张表不是推的，但**上一版的盘点漏了一整类**，这里连同订正一起给出。

上一版写的是「12 条源记录 × 3 条路径 × 5 种 defaultValue 形状 × 11 种 transform = 1980 组，420 组有差异，没有任何一组从『写了一个非空值』变成『不写』」。**最后半句是假的**：那 11 种 transform 里没有任何一本字典的键能命中改动前的查表键（`String(null)` 即 `"null"`），于是这一类差异结构性地落在网格之外。原脚本是进程内跑完即弃的，没有留档，所以本轮**重建**了网格并把 transform 维度补全（补上 `dictMap` 的 `"null"` 键 / `"undefined"` 键 / 两键并存 / `trim+dictMap` / `dictMap+upper` 五种形状）：

```
grid: 12 records x 3 paths x 5 defaultValue shapes x 17 transforms = 3060

### baseline 919582e71 vs 返修版 HEAD 0a35028d9（订正前）
combinations: 3060  diffs: 896
  [ 756] A: 改动前写了一个空值 -> 现在不写（本刀的目标）
  [  84] B: 改动前写了一个非空值 -> 现在不写   <= 审阅人点名的那一类
         e.g. empty | spec | default=null | dictMap:nullKey :: base="UNKNOWN" -> <unwritten>
  [  28] C-blank: 写出的值变了（base=null -> "UNDEF"，dictMap 的 "undefined" 键被新的 undefined 命中）
  [  28] C-nonempty: 写出的值变了（base="N" -> "U"，两键并存时命中的键换了）

### baseline 919582e71 vs 本轮（dictMap 兼容键）
combinations: 3060  diffs: 784
  [ 784] A: 改动前写了一个空值 -> 现在不写（**只剩这一类**）
```

订正后的结论（这一版可以承诺，**作用域是这张 3060 组的网格**）：与 `919582e71` 相比，网格内**差异只有一个方向**——改动前写进去的是一个空值（`undefined`/`null`/`''`），现在不写并记一条告警。**没有任何一组从「写了一个非空值」变成「不写」，也没有任何一组写出的值发生改变**（B/C/C-nonempty 三类归零）。784 比 756 多出的 28 组是 `dictMap` 的 `"undefined"` 键那一族：订正前它被新的 `undefined` 意外命中并写出一个改动前不会写的值，订正后它按改动前的键（`"null"`）查表、查不到、不写，回到 A 类。

#### 第三轮（bare `concat`）：同一份脚本重建 + concat 专项补充网格

上一轮的脚本同样是跑完即弃、没有留档，所以第三轮**按同样维度重建**并先自证：跑 `919582e71` vs `7aaadcdfa`（#5628 HEAD），拿到的是 **3060 组 / 784 组差异 / 全部 A 类**——与上一轮登记的数字逐位相同，重建脚本与原脚本同维度这一点因此是可核的，不是自称。

```
grid: 12 records x 3 paths x 5 defaultValue shapes x 17 transforms = 3060

### 919582e71 vs 7aaadcdfa (#5628 HEAD)         diffs: 784   [784] A
### 919582e71 vs 本轮                            diffs: 868   [868] A
### 7aaadcdfa (#5628 HEAD) vs 本轮               diffs:  84   [ 84] A
       e.g. empty | spec | default=nokey | concat:bare :: 5628HEAD=""/w[] -> g44=<unwritten>/w[SOURCE_FIELD_ABSENT]
```

**相对 #5628 HEAD 新增 84 组，全部是「写 `''` → 不写并记 `SOURCE_FIELD_ABSENT`」**，一组 B（非空→不写）、一组 C（值被改）都没有。84 = 28 组「路径确实不存在」的（记录 × 路径）组合 × 3 种「默认值未设置」的形状（无键 / `null` / `undefined`），乘在 `concat:bare` 这一种 transform 上；`concat:literal`（带字面量）**零差异**。

基础网格的 transform 维度里只有两种 concat，所以第三轮另建了一张 **concat 专项补充网格**（同样的 12 记录 × 3 路径 × 5 默认值形状 × **21 种** concat 形状/链，= 3780 组；记录里另加 `other:'z'`、`blank:''` 两个键以便造「部件存在」的正例）：

```
grid: CONCAT SUPPLEMENT = 3780

### 919582e71 vs 7aaadcdfa (#5628 HEAD)   diffs: 0     <= #5628 对「链里含 concat」的映射零影响
### 919582e71 vs 本轮                      diffs: 896   [896] A
### 7aaadcdfa vs 本轮                      diffs: 896   [896] A
```

按形状拆（两张网格合计 980 组差异，全部 A 类）：

| 形状 | 差异组数 |
| --- | --- |
| `concat:bare`（基础网格） | 84 |
| `concat` 全部字段都缺 / `includeCurrent:false` 无部件 / `fields:[] values:[]` | 84 × 3 |
| `[concat,upper]`、`[concat,trim]`、`[concat,toNumber]`、`[trim,concat]` | 84 × 4 |
| `[concat,dictMap]`（`"null"` 键 / `"undefined"` 键 / 未命中） | 84 × 3 |
| `[dictMap:"null"键, concat]` | 56（另外 28 组字典命中 → 有部件 → 照旧写 `NK`） |
| `concat:literal`、`values:['']`、任一字段存在（含存在但为 `''`/`null`/`0`）、`[concat,defaultValue]`、`[concat,dictMap:""键]`、`[defaultValue,concat]` | **0** |

**中间量度如实登记**：先写出来的那一版**只**改了 `concat`，补充网格里出现了 **84 组 B 类 + 180 组 C-blank**，全部集中在 `[concat, dictMap]`：改动前 `concat` 交给下游 `dictMap` 的是 `''`，查的键就是 `""`；只改 `concat` 之后交下去的是 `undefined`，键悄悄变成了 `absentSourceLookupKey()` 的那个键，于是 `{"": "EMPTY"}` 这种字典**今天会写的值不写了**（B），`{"null": ...}` 这种**今天不会写的值反而写了**（C）。这正是 3.8 里审阅人点名过的同一类错误换了个位置重演。修法与 3.8 同款：链级只把**查表键**还原成改动前这一点上会查的那个键（永远是 `''`，因为 `join()` 零个部件恒等于 `''`），值一个字不动。上表就是还原之后的结果——B / C 两类归零。

### 3.3 三种情况的处置表

| 情形 | 行为 | 与改动前相比 |
| --- | --- | --- |
| 路径**不存在**，无 `defaultValue`（或它是 `null`/`undefined`），transform 链也没造出值 | **不写目标字段**（键根本不出现在 payload 里）+ 记 `SOURCE_FIELD_ABSENT` | **本表中只有这一格与改动前不同** |
| 路径存在、值是 `null` / `''` / `0` / `false` / 显式 `undefined` | 照旧写 | 不变 |
| 配了非空 `mapping.defaultValue`（含 `''`） | 照旧走默认值，优先级不变 | 不变 |
| 路径存在但值空 + 任意 `defaultValue`（含 `null`） | 照旧回填后再写 | 不变 |
| 路径不存在，但 transform 链自己产出了**非空**值（`concat` 带 `values`、`dictMap` 带 `defaultValue`、`dictMap` 带改动前查表键（`"null"`）、`defaultValue` 步骤） | 照旧写 | 不变（`dictMap` 那一格靠 3.8 的兼容键才成立） |
| 路径不存在，`concat` 至少有**一个部件被供给**（字面量、或某个 `fields` 字段在源侧存在——哪怕值是 `''`/`null`） | 照旧按既有规则拼（结果可能就是 `''`），照旧写 | 不变 |
| 路径不存在，`concat` 的部件**一个都没被供给** | **不写 + 记 `SOURCE_FIELD_ABSENT`** | **变（第三轮，见 3.4；#5628 那一版是照旧写 `''` 且不记告警）** |

第三个条件 `outputValue === undefined` 是刻意的：只有「从头到尾谁都没给出值」才落到不写。

但它**一个人撑不住**「今天能跑通的管道不会开始少写非空字段」这句承诺：链里的 `dictMap` 是**查表**，改动前查的键是回填出来的 `null`，现在链里流的是 `undefined`，键就变了。这一条由 3.8 的兼容键补上；两者合起来才是那句承诺的完整依据，盘点数字见 3.2。

### 3.4 bare `concat` 从零造空串：#5628 登记的残留，第三轮已修

**残留是什么**（#5628 的原文保留在此，便于对照）：`concat` 先 `filter(part => !isBlank(part) && !isBlankAfterTrim(part))` 再 `join(separator)`，**所有部件都缺失时返回 `''` 而不是 `undefined`**。于是第三个条件为假，目标被写成空串，`warnings` 为空。实测：`{fn:'concat'}` 与 `{fn:'concat', fields:['colour']}` 在源侧全缺时都产出 `{"FSpec":""}`。#5628 把它订正成「产出**非空**值时照旧写」并用 `testBareConcatStillWritesEmptyString` 钉住了当时的行为。

**第三轮的修法（选 (a)：改 `concat` 自己，不动第三条件）**——`transform-engine.cjs:243-292`：

```js
let anyPartSupplied = false
if (args.includeCurrent !== false) { parts.push(value); if (value !== undefined) anyPartSupplied = true }
for (const field of args.fields || []) { const part = resolveSourcePath(sourceRecord, field); parts.push(part.value); if (part.found) anyPartSupplied = true }
for (const literal of args.values || []) { parts.push(literal); anyPartSupplied = true }

if (!anyPartSupplied && context.sourceFieldAbsent === true) return undefined
```

为什么选 (a) 而不是 (b)（把「哪些字段缺失」灌进 `transformContext`、在 bare 情形短路）：(a) 只改 `concat` 一个 case 的返回值，**第三条件、取值回填、其它 6 个 step 一字不动**，「不写」的判据仍然只有 `outputValue === undefined` 这一条；(b) 要在 `transformRecord` 里替 `concat` 提前算一遍它的部件，等于把一个 step 的语义搬到调度层，`fields` 解析会出现第二份实现（与 `concat` 自己的那份可能漂移），而且仍然要在 `concat` 里落地短路。(b) 唯一比 (a) 多出来的能力——把「部件为何缺失」上报——本轮没有需求。

三处刻意的窄化，每一处都有正控钉住：

1. **「被供给」判的是「存在」，不是「非空」**。源侧 `{colour: ''}` 是**说了话**（把值清空了），`values:['']` 是操作员**写下了**一个空字面量：两者都照旧走 `join`，答案就是 `''`，照旧写。只有「一个部件都没被供给」才产出 `undefined`。`fields` 因此改用 `resolveSourcePath()`（与 `getPath()` 同值、多一个 `found`，值的一致性由既有用例 5 的 182 组断言钉着），不是改用一个新的取值口径。
2. **整条短路被 `context.sourceFieldAbsent` 圈在「本来就会落到不写」的那一条映射上**。路径存在（包括自有键持 `undefined`）、默认值真的供了值、以及**导出的 `transformValue()` 的所有外部调用者**（无 context），都照旧得到 `''`。没有这一层，`{spec: undefined}` + bare `concat` 会从写 `''` 变成写 `undefined`——那是「值被改」，不是本轮要的「空串→不写」。
3. **链级只还原查表键，不还原值**（`transformValue`，`transform-engine.cjs:316-337`）：`concat` 短路之后，下游 `dictMap` 若不做处理会换一个键去查表。改动前这一点上被查的键恒为 `""`（`join()` 零个部件恒等于 `''`），所以把键钉回 `""`，值不动——命中就照旧写，未命中仍然落到不写。理由与 3.8 完全同款，实测数据见 3.2 的「中间量度」。

**仍然不把第三条件放宽成 `isBlank(outputValue)`**（审阅人明令）：`{fn:'defaultValue', value:''}`、`{fn:'concat', values:['']}` 都是链被**明确要求**造出一个空串，放宽会让它们停写。变异 M23 证明这条钉子是活的：一放宽，`testAllAbsentConcatWritesNothing` 的 `EMPTY literal` 正控立刻红。

钉子：`testAllAbsentConcatWritesNothing`（替代 #5628 的 `testBareConcatStillWritesEmptyString`）——8 种「无部件」形状 × 3 种默认值形状全部断言**不写 + 告警**，10 条正控断言**照旧写**，3 条「路径存在」断言写 `''`，1 条 `transformValue()` 无 context 断言写 `''`，外加一条走完整 `runPipeline` + 真 multitable 适配器的端到端断言（库里的 `'Correct bolt'` 必须留住）。

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

改动前 `setPath` 承担了两件事：路径安全检查 + 写入。跳过写入会连带跳过检查，那是把守卫放松。所以把检查拆成 `parseTargetPath`（`transform-engine.cjs:98-109`，逻辑与原 `setPath` 开头**逐字相同**），`setPath` 改为调用它（`:111-112`），而"不写"分支里**先调用 `parseTargetPath(targetField)` 再记 warning**（`:411`）。于是 `targetField` 为 `__proto__` / `x.constructor.y` 的映射，无论源字段在不在，都照旧抛 `TransformError` → 落进 `errors` → `ok === false`。变异 M4 证明这条线是活的。

`required` 语义也没动：`validator.cjs` 的 `validateRecord` 用 `getPath(record, field)` 读目标值（`validator.cjs:234`），没写的键读出来还是 `undefined`，`required` 照旧判 `REQUIRED`。

### 3.8 `dictMap` 的 `"null"` 键：审阅人订正与兼容修法（本轮）

**订正的事实**（两个版本各跑一次，进程内喂真函数，源记录 `{code:'MAT-001', quantity:9}`、缺 `name`、映射 `{sourceField:'name', targetField:'name', defaultValue:null, transform:{fn:'dictMap', args:{map:{"null":"UNKNOWN"}}}}`）：

| 版本 | 结果 |
| --- | --- |
| `919582e71`（改动前） | `{"name":"UNKNOWN"}`，无告警 |
| `0a35028d9`（订正前的本分支） | 不写 `name`，1 条 `SOURCE_FIELD_ABSENT` |
| 本轮 | `{"name":"UNKNOWN"}`，无告警（回到改动前） |

**为什么会这样**：改动前 `transformRecord` 给链喂的**不是** `undefined`——取值回填把 `mapping.defaultValue` 喂了进去，而注册表给每条存库映射带的是 `null`（3.1）。`dictMap` 的查表键是 `String(value)`，于是键是 `"null"`，一本写了 `"null"` 条目的字典**真的会命中、真的会写出一个非空值**。返修后链里流的是 `undefined`，键变成 `"undefined"`，命不中 → `outputValue` 是 `undefined` → 落到不写。这不是「少写一个空值」，是**少写一个非空值**，与 §3.3 的承诺冲突。

**裁决：修（保住旧效果），不是改口径。** 理由三条：

1. 本刀的原则是「缺失不写空」**加上**「链自己产出的非空值照写」。`dictMap` 的 `"null"` 条目就是操作员写下的「源侧什么都没说时，写这个」——它产出的是一个真值，不是一个空洞。只改文档等于让这条原则在 `dictMap` 上开一个例外。
2. 这条形状在生产上**可达且合理**：JSON 的对象键本来就是字符串，`"null"` 是操作员能存进 `field_mappings.transform` 的合法键；而且它恰恰是「源侧没给值时兜个底」的常见写法。
3. 代价可控：它只需要**换一个查表键**，不需要放宽三条件中的任何一条（放宽第三条件的后果见 3.4）。

**做法（只给 dictMap，不做全局归一化）**：

- `absentSourceLookupKey(mapping)`（`transform-engine.cjs:206-210`）返回**改动前会被查的那个键**：映射带 `defaultValue` 键就是 `String(mapping.defaultValue)`（存库映射即 `"null"`），不带键就是 `"undefined"`。它返回的是**键**，不是值。
- `transformRecord` 只在「路径不存在 且 没有真默认值」这条**本来就会落到不写**的分支上，把它放进 `transformContext`（`:340-343`）。
- `applyTransform` 的 `dictMap` 分支在 `value === undefined` 时用这个键查表（`:262-278`）；**链里流的值一个字没动**，所以查不到时 `outputValue` 仍是 `undefined`，仍然不写。

**为什么不做全局归一化**（把缺失值直接当成 `null` 喂给链）：`trim`/`upper`/`lower`/`toNumber`/`toDate` 对 `null` 是**原样返回**，于是 `outputValue` 变成 `null`，第三条件失效，本刀刚堵上的覆盖写整条回来。变异 M19 实证：只改这一处，**13/17 条用例转红**（含端到端的 `testStoredMappingShapeIsNotBlanked`、`testPlannerConvergesWhenSourceFieldIsAbsent`）。

**为什么键要跟着映射走、不能写死 `"null"`**：不带 `defaultValue` 键的字面量映射在改动前喂给链的是 `undefined`，它的字典里那条 `"null"` **从来没命中过**。写死 `"null"` 会让本刀开始写出改动前不会写的值——那是把「只收不放」变成「顺手放宽」。变异 M18 实证：1/17 红（`a "null" entry does not fire for a mapping that never fed null`）。

**边界（都有用例钉住）**：

| 形状（源字段缺失） | 行为 | 与 `919582e71` 相比 |
| --- | --- | --- |
| 存库映射 + 字典有 `"null"` 条目 | 写字典的答案 | 不变 |
| 存库映射 + `[trim, dictMap]` / `[upper, dictMap]` / `[dictMap, upper]` | 写字典的答案 | 不变 |
| 存库映射 + 字典**没有**对应条目、也没有 `args.defaultValue` | **不写** + 告警 | 变（改动前写 `null`，是空值） |
| 存库映射 + `trim`/`upper`/`lower`/`toNumber`/`toDate` 单步 | **不写** + 告警 | 变（改动前写 `null`，是空值） |
| 无 `defaultValue` 键的字面量映射 + 字典只有 `"null"` 条目 | **不写** + 告警 | 变（改动前写 `undefined`，是空洞） |
| 无 `defaultValue` 键的字面量映射 + 字典有 `"undefined"` 条目 | 写字典的答案 | 不变 |
| 两个键都在的字典（存库映射） | 命中 `"null"` | 不变 |
| `args.defaultValue` 兜底 / 非空 `mapping.defaultValue` | 照旧 | 不变 |

**迁移提示（给想要「缺失就写某值」的映射）**：靠 `dictMap` 的 `"null"` 键兜底**仍然有效**，不必改配置。但它依赖的是「改动前回填了什么」这个实现细节，可读性差；更直白、且与三种情形的分辨无关的写法是配 `mapping.defaultValue`（非空默认值优先级从头到尾没变，见 3.2 表格），或在链尾加一步 `{fn:'defaultValue', value:'UNKNOWN'}`。两种写法今天都通，且都不会被本刀的不写分支拦下。

**没修的**：`dictMap` **未命中**时，改动前写的是 `null`（存库映射）或 `undefined`（字面量映射），现在不写——这属于本刀正要消灭的空值覆盖写，**有意变**，用例 3e 第 3 节钉住。

## 4. 编码信号：照的是哪个先例

**两个先例，各照一半，都在仓内，没有自创格式：**

1. **条目形状**照 `transform-engine.cjs` 自己的 `errors` 条目（改动前 `:239-246`）：
   `{ field, sourceField, index, code, message, details }`。新的 warning 条目字段名、顺序完全一致，只是 `code` 换成 `SOURCE_FIELD_ABSENT`（`transform-engine.cjs:412-418`）。同一个函数产出、同一批消费者读，形状统一。
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
4. **`http-routes.cjs`**：未改（`transformRecord` 在 `:3280`、`:3306` 的两个调用点只读 `.ok` / `.value` / `.errors`，新增的 `warnings` 对它们透明；实读复核：它**不在** `s6a-package-provenance-pins.json` 的 66 个叶子键里，上一版说它"被溯源 pin 钉住"是**记错了**，这里点名订正——没改它的真实原因是它不在本刀的改动面里）。

   遗留分叉**在本轮重新变成活的**，如实登记：`normalizePreviewFieldMappings`（`http-routes.cjs:2991-2996`）是纯透传，预览用的是 HTTP JSON 原样的映射。返修轮里「没有 `defaultValue` 键」与「`defaultValue: null`」处置相同，所以那一轮这条分叉不产生差异；**兼容键让它们重新分开了**——查表键一个是 `"undefined"`、一个是 `"null"`。实测（源记录缺 `name`，`transform: {fn:'dictMap', args:{map:{"null":"UNKNOWN"}}}`）：

   ```
   预览体没带 defaultValue 键 : {}                      ← 不写
   预览体带 defaultValue: null : {"name":"UNKNOWN"}      ← 写（= 实跑的答案）
   ```

   影响面：**只**在「预览体手写、且故意省掉 `defaultValue` 键、且字典里写了 `"null"` 条目」这一格；UI 把存库映射原样回传（带 `defaultValue: null`）时两侧一致。正解是给预览入口补一次与 `normalizeFieldMappings` 同款的归一化，属另一刀（要动 `http-routes.cjs` 的入参形状，与在飞 PR 的冲突面重叠）。本刀不做，登记为后续单。
5. **dry-run 报告口径**：`external-write-dry-run.cjs` 的 `counts` / `rowErrorTypes` **没有**新增 `source_field_absent` 口径；本刀在那边只做了收敛性修复（见 3.6）。要在 C6 报告里也看见这个码，是后续单。
6. **`metrics` 形状（裁决 (a)：只登记，不做）**：终审要求把 `sourceFieldAbsent.rows` 抬进 `metrics`，理由是运行历史面板只渲染 status/metrics/errorSummary/targetWriteSummaries。**实读复验后本刀不做**：`run-log.cjs:45-52` 的 `normalizeMetrics` 只透传 5 个已知键，而 `finishRun`（`run-log.cjs:108-126`）把它们作为**独立列**交给 `updatePipelineRun`（`rowsRead` / `rowsCleaned` / `rowsWritten` / `rowsFailed` / `durationMs`），没有一个通用的 metrics JSONB。多一个指标就要多一列，是落库形状变更 + 迁移，超出本刀边界。
   顺带订正终审的一个前提：`targetWriteSummaries` 其实也在 `details` 里（`pipeline-runner.cjs:1218-1220` 写入，`apps/web/src/views/IntegrationWorkbenchView.vue:3285` 读的是 `run.details?.targetWriteSummaries`），所以「面板只渲染 metrics」并不完全成立——**面板已经在读 details 的某些键**，`sourceFieldAbsent` 要可见，正确的一刀是在前端加一个 details 读点，而不是改落库形状。该前端改动本刀不做（与在飞 PR 的前端文件冲突面重叠）。
7. **`apps/web` 的错误码文案**（`errorCodeLabels.ts`）：本刀不碰（被在飞 PR 占用）。`SOURCE_FIELD_ABSENT` 目前只在运行详情里以裸码出现。
8. ~~**bare `concat` 的行为修正**：见 3.4，本刀只订正口径 + 钉住现状。~~ **已在第三轮（`fix/transform-bare-concat-empty-output`）做掉**，见 3.4。
9. **`dictMap` 未命中时的口径**：改动前写空值、现在不写，属本刀的目标行为，不是残留（3.8 末）。

## 7. 血缘与守卫一览（第三轮后行号）

| 位置 | 作用 |
| --- | --- |
| `transform-engine.cjs:29` | `SOURCE_FIELD_ABSENT` 常量 |
| `transform-engine.cjs:61-81` | `resolveSourcePath` —— 可分辨性（`:74-77` 空数组段 = 不存在，见 3.5） |
| `transform-engine.cjs:98-109` | `parseTargetPath` —— 从 `setPath` 拆出的写侧路径守卫 |
| `transform-engine.cjs:192` | `EMPTY_TRANSFORM_CONTEXT` —— 除「不写分支」外每个调用者看到的形状 |
| `transform-engine.cjs:206-210` | `absentSourceLookupKey` —— 改动前会被查的那个**键**（3.8） |
| `transform-engine.cjs:243-292` | `concat` —— 「被供给的部件」记账（`:266` 用 `resolveSourcePath().found`）；`:287` 一个部件都没被供给且本映射落在缺失分支时产出 `undefined`（3.4，第三轮） |
| `transform-engine.cjs:294-310` | `dictMap` 用兼容键查表；**只**换键不换值，未命中仍落到不写（3.8） |
| `transform-engine.cjs:316-337` | `transformValue` —— 逐步跑链；`:332-334` 在 `concat` 短路后把下游 `dictMap` 的查表键钉回 `""`（改动前这一点上被查的键），值不动（3.4，第三轮） |
| `transform-engine.cjs:365-366` | `usedDefault` —— **只**管取值优先级，与改动前同款 |
| `transform-engine.cjs:374-376` | `defaultApplied` —— 「默认值真的给出了值」，空默认不算（3.1） |
| `transform-engine.cjs:383` | 取值回填，收成 `defaultApplied || (usedDefault && resolved.found)`（3.2） |
| `transform-engine.cjs:392-394` | `transformContext` —— 只在「本来会落到不写」的那条映射上构造；带 `absentSourceKey`（3.8）与 `sourceFieldAbsent`（3.4） |
| `transform-engine.cjs:408` | 不写的三条件，第二条用 `!defaultApplied`；第三轮**一字未动** |
| `transform-engine.cjs:411` | 不写分支里仍然跑写侧路径守卫 |
| `transform-engine.cjs:440` | `ok` 仍然只看 `errors` |
| `pipeline-runner.cjs:75-78` | 字段对上限 50 |
| `pipeline-runner.cjs:786-806` | 每行的计数与字段名收集（不碰 metrics）；`:790` 按 code 过滤后再计行，`:800` 先去重再判上限 |
| `pipeline-runner.cjs:1018-1029` | 运行级 details 构造 |
| `pipeline-runner.cjs:1222` / `:1250` | 成功路径 / 失败路径都带上（dry-run 走成功路径，见验证文档） |
| `external-write-dry-run.cjs:562-576` | C6 规划器只比较「这一行真的会写出去的字段」（3.6） |
