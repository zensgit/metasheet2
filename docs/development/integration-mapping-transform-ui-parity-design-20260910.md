# 数据工厂「清洗映射规则」转换/校验 UI 对齐引擎全集（G27）

Date: 2026-09-10
Branch: `feat/integration-mapping-transform-ui-parity`（基于 `origin/main` a22955f83）
Scope: 前端到达率，**后端零改动**（`plugins/`、`packages/` 未触碰）

## 1. 为什么

差距分析 G27：`plugin-integration-core` 的转换引擎与校验器早就支持一整套能力，但工作台的「清洗映射规则」分区只暴露了其中一半，另一半在 UI 上**不可达**——不是坏了，是没有入口。

| 层 | 引擎/校验器已支持 | G27 之前 UI 能写出 | 差 |
| --- | --- | --- | --- |
| 转换 | `trim` `upper` `lower` `toNumber` `toDate` `defaultValue` `concat` `dictMap`（`lib/transform-engine.cjs:10-19`） | `trim` `upper` `lower` `toNumber` `dictMap` | `toDate` `defaultValue` `concat` |
| 转换链 | 单步 / 数组 / `{ steps: [...] }`（`normalizeTransformList`，`transform-engine.cjs:107-112`） | 只能单步（`parseTransform` 直接 `return { fn }`） | 多步链 |
| 映射级默认值 | `mapping.defaultValue`，取空值时先顶上再进转换（`pipelines.cjs:201` + `transform-engine.cjs:232-235`） | 无入口 | 全部 |
| 校验 | `required` `pattern` `enum` `min` `max`（`lib/validator.cjs:12`） | `required` `min` `max` | `pattern` `enum` |

本次把 UI 补齐到引擎全集，并加一条**双向对齐断言**（UI 列表 == 引擎 `SUPPORTED_TRANSFORMS` / `SUPPORTED_RULES`），让「引擎加了一种转换而 UI 忘了加」和「UI 编了一种引擎不认的转换」都变成 CI 红。

## 2. 形状以引擎源码为准（读完再写的三个反直觉点）

1. **`toDate` 的 `format` 不是格式串。** 引擎只判断 `args.format === 'date'`，是就输出 `toISOString().slice(0, 10)`，其余一律整条 ISO（`transform-engine.cjs:158-167`）。所以 UI 给的是**两个选项的下拉**（`iso` / `date`），而不是让人填 `YYYY-MM-DD`——填了也只会被当成「非 date」= 整条 ISO，属于静默不生效。
2. **`concat` 默认把当前字段值排在最前。** `args.includeCurrent !== false` 时先 push 当前值，再按 `args.fields` 顺序取源记录字段，最后 `args.values` 字面量；空值（含纯空格）会被过滤掉再 join（`transform-engine.cjs:172-190`）。UI 只暴露 `fields` + `separator`，并在帮助文案里写明「当前来源字段的值排在最前」。`values` / `includeCurrent` 本次不给控件。
3. **单步 transform 不能是裸字符串。** 引擎的 `normalizeTransformStep` 认字符串，但 pipeline 注册层的 `optionalJson`（`pipelines.cjs:103-109`）会把非 object 的 `transform` 直接判 400。所以 UI 永远写对象或数组，绝不写 `"trim"`。

## 3. Payload 形状表（UI 写出的字节）

以下都是 `buildFieldMappingPayload()`（`apps/web/src/components/integration/integrationMappingTransform.ts:231`）的输出，逐条被 `apps/web/tests/integrationMappingTransformParity.spec.ts` 断言，并被真引擎 `transformRecord()` / `validateRecord()` 实跑验证。

### 3.1 转换步骤

| UI 选择 | payload | 引擎读法 |
| --- | --- | --- |
| 无转换 | 省略 `transform` 键（值为 `undefined`） | `normalizeTransformList(undefined) -> []` |
| trim / upper / lower / toNumber | `{ "fn": "trim" }` | `args = {}` |
| toDate（仅日期） | `{ "fn": "toDate", "format": "date" }` | `args.format === 'date'` → `2024-01-31` |
| toDate（ISO 日期时间，默认） | `{ "fn": "toDate", "format": "iso" }` | 非 `'date'` → `2024-01-31T00:00:00.000Z` |
| defaultValue | `{ "fn": "defaultValue", "value": "UNKNOWN" }` | `args.value ?? args.defaultValue`（`transform-engine.cjs:169`） |
| concat | `{ "fn": "concat", "fields": ["spec","color"], "separator": "-" }` | 当前值 + `fields` 顺序，空值跳过 |
| dictMap | `{ "fn": "dictMap", "map": { "EA": "Pcs" } }` | **与 G27 之前逐字节相同** |
| 转换链（≥2 步） | `[ { "fn": "trim" }, { "fn": "upper" }, ... ]` | `normalizeTransformList` 收数组，`reduce` 左到右 |

链形状选**数组**而不是 `{ steps: [...] }`：两者引擎都认（`transform-engine.cjs:107-112`），数组是 `normalizeTransformList` 的第一分支，也能过 `optionalJson`（数组走 `value.slice()`）。读回时两种都能解析（见 §5）。

链里每一步都可以带自己的参数（含自己的 dictMap 文本）；`fn` 为空的步骤在 build 时被丢弃，因此「点了『再加一步』但没选转换」不会改变 payload。**当有效步骤恰好只剩一步时，回落成单对象**——这是保持字节兼容的关键。

### 3.2 映射级默认值与校验

| UI 输入 | payload 片段 | 引擎读法 |
| --- | --- | --- |
| 缺值默认值（行右侧） | `"defaultValue": "N/A"`，**只在填了才出现**，排在 `sortOrder` 之后 | `transformRecord` 在来源值 `isBlank`（**只有** `undefined` / `null` / `''`）时先替换，**再**跑转换链（所以 `N/A` 还会被后续 `upper` 处理） |
| 必填 | `{ "type": "required" }` | 不变 |
| 正则 | `{ "type": "pattern", "params": { "regex": "^MAT-\\d+$" } }` | `compilePattern` 读 `params.regex`（`validator.cjs:84-101`） |
| 枚举 | `{ "type": "enum", "params": { "values": ["active","inactive"] } }` | `enumValues` 读 `params.values`；值保持字符串，`includesEnumValue` 会把数字 `10` 与字符串 `'10'` 视为相等 |
| min / max | `{ "type": "min", "value": 0.000001 }` | **与 G27 之前逐字节相同**（扁平形；`normalizeRule` 会把散键折进 params） |

规则顺序固定为 `required → pattern → enum → min → max`，未填的不产出；整行都没填则 `validation` 为 `undefined`（沿用旧行为）。

`params` 形（pattern/enum）与扁平形（min/max）并存是**故意**的：min/max 的扁平形是既有线上字节，不能动；pattern/enum 采用引擎自己的测试 `__tests__/transform-validator.test.cjs:105,123` 用的 `params` 形。两者经 `normalizeRule` 归一后完全等价。

### 3.3 字节兼容保证

单步、无 pattern/enum、无映射级默认值的一行，产出的对象**键名、键序、值都与 G27 之前一致**：

```
{"sourceField":"code","targetField":"FNumber","transform":{"fn":"upper"},"validation":[{"type":"required"}],"sortOrder":3}
```

证据：`apps/web/tests/IntegrationWorkbenchView.spec.ts` 的 52 条测试**一行未改**全绿（其中包含对 `fieldMappings` payload 的逐条断言），外加 parity spec 里的 `JSON.stringify` 逐字节断言与 `Object.keys` 键序断言。

## 4. UI 控件

行编辑器（`apps/web/src/components/integration/IntegrationMappingRulesSection.vue`）的转换列从一个 `<label>` 变成一个 `transform-cell`（第 49 行），仍然是 5 列网格的第 3 格——删除按钮的列没有移动。

| 控件 | testid | 出现条件 |
| --- | --- | --- |
| 转换下拉（8 种 + 无转换） | `transform-fn-{i}` | 始终 |
| dictMap 文本域 | `dict-map-{i}` | fn = dictMap（既有 testid，未改名） |
| 日期格式下拉 | `transform-args-{i}-date-format` | fn = toDate |
| 兜底值输入 | `transform-args-{i}-default-value` | fn = defaultValue |
| 源字段多选 / 逗号分隔回退输入 | `transform-args-{i}-concat-fields` | fn = concat（有 schema 时是 `<select multiple>`，无 schema 时是文本框） |
| 分隔符输入 | `transform-args-{i}-concat-separator` | fn = concat |
| 「再加一步」 | `add-transform-step-{i}` | 始终 |
| 链步骤转换下拉 | `transform-step-fn-{i}-{s}` | 每个已添加步骤 |
| 链步骤 dictMap / 参数 | `transform-step-dict-map-{i}-{s}` / `transform-args-{i}-{s}-*` | 按该步骤的 fn |
| 「删除这一步」 | `remove-transform-step-{i}-{s}` | 每个已添加步骤 |
| 正则 | `validation-pattern-{i}` | 始终 |
| 枚举（逗号分隔） | `validation-enum-{i}` | 始终 |
| 缺值默认值 | `mapping-default-value-{i}` | 始终 |

参数控件被抽成 `IntegrationMappingTransformArgs.vue`，第 1 步与链上各步共用同一份 markup（testid 前缀不同），两处不可能长歪。该组件只用 `var(--ms-*)` 令牌，已登记进 `tests/ui-foundation-style-guard.spec.ts` 的 token-only 目标集。

链的 push/splice 留在视图里（`addTransformStep` / `removeTransformStep` 作为 prop 传下去），与既有 `addMapping` / `removeMapping` 同一套约定：数组归视图，markup 归分区组件。

### 4.1 build 期守卫（不是放宽，是收紧）

三条「引擎会静默无效或逐行报错」的输入在 build 期直接抛中文错误，落到既有的保存/预览 try-catch 里：

- `defaultValue` 兜底值为空 → 引擎会把 `''` 当空值，等于白配。
- `concat` 一个字段都没选 → 结果只剩当前值，等于白配。
- `pattern` 正则编译不过 → 引擎会给**每一行**产一条 `INVALID_RULE`，等于用死信队列告诉你打错字了。

（`dictMap` 空文本的旧守卫原样保留。）

错误信息带行号（#5596 F07）：`buildMappings()` 是在一个 try 块里遍历所有行的，光看「concat 至少需要选择一个拼接字段」没法知道是哪一行。现在统一加前缀 `第 N 条清洗规则（目标字段）：`，原文完整保留在后面；目标字段与来源字段都空时退化成「未命名字段」。

## 5. 编辑器内往返（G08 的前置件）

工作台目前**没有**从已保存 pipeline 回读映射的路径（视图里只有 `savedPipelineId`，没有把 `fieldMappings` 塞回 `mappings.value` 的地方），所以本次只做**纯函数级往返**：`editableMappingFromPayload(payload, id)`（`integrationMappingTransform.ts:311`）是 `buildFieldMappingPayload` 的逆。

- 强方向（已断言）：任何 UI 能产出的 payload，`build(parse(payload)) === payload`。
- 读入时**故意比写出时宽**：`{ steps: [...] }`、裸字符串步骤、`{ type: 'upper' }`、`{ fn, args: {...} }` 嵌套、扁平 `regex` / `allowedValues` / `min` 都能解析——这些是引擎合法但 UI 不写的形状，手写或旧数据也能载入。
- 读入时的**优先级严格照抄引擎**（#5596 F02 修正）：
  - 步骤参数——`normalizeTransformStep`（`transform-engine.cjs:131`）里 `isPlainObject(step.args)` 为真时 `args` **整体替换**顶层，不是合并。所以 `{ fn:'toDate', args:{ unrelated:1 }, format:'date' }` 的 `format` 引擎根本不看，编辑器也必须显示「ISO 日期时间」。
  - 规则参数——`normalizeRule`（`validator.cjs:42-46`）先复制 `rule.params` 再把顶层散键覆盖进去，冲突时**顶层赢**。所以 `{ type:'pattern', regex:'^TOP$', params:{ regex:'^NESTED$' } }` 取 `^TOP$`。
  两条都有拿真引擎/真校验器跑出来的对照用例（不是照着我的理解写的期望值）。
- 已知有损（每一条都有断言，不是静默）：
  1. `dictMap` 的可选 `defaultValue` 参数；
  2. `concat` 的 `values` / `includeCurrent`；
  3. **`pattern` 的 `params.flags`**（#5596 F01）——校验器是 `new RegExp(pattern, flags)`（`validator.cjs:85-97`），所以一条 `flags:'i'` 的规则读回再存就变成大小写敏感；
  4. **任意规则的自定义 `message`**（#5596 F11）——`makeError` 优先用 `rule.message`（`validator.cjs:59`），读回再存就退回引擎默认文案。
  5. **dictMap 里编辑器约定表示不了的条目**（见 §5.1）：键含 `=`、键或值含换行、键或值为空/纯空格——整条**跳过**，并各产一条 `loadWarnings`。
  6. **dictMap 键值的首尾空格**（同 §5.1）：解析侧一律 trim，所以 `parse(serialize(map))` 等于 **trim 后**的 map，不是原 map；这一条同样产 `loadWarnings`，因为引擎是按 `String(value)` 精确查键（`transform-engine.cjs:191-196`），trim 改变了它能匹配到的来源值。
  以上六项都没有编辑器控件，读入时**丢弃/规范化**；UI 不认识的 `fn`（例如脏数据里的 `evalScript`）同样被丢弃，绝不带着一个 UI 编不出来的步骤继续存回去。要保留它们，目前只能不经编辑器直接写 payload。丢弃信号统一挂在 `EditableMapping.loadWarnings`（编辑器内部状态，永不下发）。

### 5.1 dictMap 文本约定（序列化与解析同一套）

这套约定由**正向解析** `parseDictionaryMap` 定义，逆函数必须照它来写，否则就会静默改写字典：

- 一行一条，按**第一个** `=` 切分 → **键不能含 `=`，值可以**（`EA=a=b` 读作 `EA` → `a=b`）；
- 键、值都会被 trim → 两侧都不能带首尾空格；
- 键、值都不能含换行（换行就是记录分隔符）；
- 键、值都不能为空。

修复前逆函数是直白的 `` `${key}=${value}` ``，完全不管这套约定：键为 `A=B` 的条目读回来变成键 `A`、值 `B=<原值>`（**静默改写**），值里带换行的条目要么让下一次保存抛「每行必须使用 source=target 格式」，要么裂成一条伪条目。现在逆函数只输出解析侧能原样读回的条目，其余**跳过并报告**；如果一个 dictMap 的条目全部不可表示，文本为空，下一次保存会响亮地失败在「dictMap 字典映射不能为空」，而不是悄悄存成另一本字典。

对应用例三条：`round-trips a dictMap VALUE containing "=" (only the first "=" splits)`、`skips (and reports) a dictMap entry the textarea convention cannot express`、`pins the dictMap trim loss: parse(serialize(map)) equals the TRIMMED map, and says so`（后者还用真引擎对比了 trim 前后 `' EA '` 与 `'EA'` 的匹配差异）。

这是刻意的方向性：读得宽只影响编辑器里显示什么，**写口没有放宽**——写出去的永远是上面第 3 节那张表里的形状，且经过白名单与 build 期守卫。有损的方向也是安全的那一侧：编辑器绝不声称自己拿着一个显示不出来的东西，也绝不把一条只理解了一半的规则再发回去。

### 5.2 存库这一跳会改变什么（#5596 终审补测）

UI 的 payload 不是直接进引擎的，中间还有注册层 `normalizeFieldMappings`（`pipelines.cjs:181`）。它做两件对语义有影响的事：

- **没填默认值的行会被写成 `defaultValue: null` 自有键**（`pipelines.cjs:201`）。而 `transformRecord` 判的是 `hasOwnProperty`（`transform-engine.cjs:233`），所以「存之前」缺值得到 `undefined`，「存回来之后」同一行缺值得到 `null`。这条差异现在被钉在测试里，而不是留给生产环境去发现。
- **数组形的转换链原样透传**（`optionalJson` 对数组走 `value.slice()`），存回来后 `transformRecord` 仍按链执行。

对应用例：`survives the API layer: normalizeFieldMappings -> transformRecord keeps chains and pins null defaults`（直接 `require` 注册层，不改 `plugins/`）。

## 6. 改了哪些文件

| 文件 | 改动 |
| --- | --- |
| `apps/web/src/components/integration/integrationMappingTransform.ts`（新） | 纯模块：转换列表常量、参数/步骤/映射工厂、payload 构建器、校验规则构建器、逆函数 |
| `apps/web/src/components/integration/IntegrationMappingTransformArgs.vue`（新） | toDate/defaultValue/concat 的参数控件，第 1 步与链上步骤共用 |
| `apps/web/src/components/integration/IntegrationMappingRulesSection.vue` | 转换列改成 cell + 链 UI；校验列加 pattern/enum/默认值；两个新 prop |
| `apps/web/src/components/integration/integrationWorkbenchSectionTypes.ts` | `TransformFn` 扩到引擎全集；新增 `MappingDateFormat` / `MappingTransformArgs` / `MappingTransformStep`；`EditableMapping` 加 5 个字段 |
| `apps/web/src/views/IntegrationWorkbenchView.vue` | 同步本地类型；`transformOptions` 改为引用模块常量；映射工厂改用 `createEditableMapping`；新增 `addTransformStep` / `removeTransformStep`；`parseDictionaryMap` / `parseOptionalNumber` / `parseTransform` / `buildValidationRules` 迁出（净 -21 行） |
| `apps/web/tests/IntegrationMappingRulesSection.spec.ts` | 参数控件按 fn 显隐 + 回写、链的 prop 调用形状、pattern/enum/默认值回写 |
| `apps/web/tests/integrationMappingTransformParity.spec.ts`（新） | 引擎对齐断言、payload 形状表、字节兼容、引擎实跑、往返、两个自带变异探针 |
| `apps/web/tests/ui-foundation-style-guard.spec.ts` | 新组件登记进 token-only 目标集（+4 行） |

`plugins/` 与 `packages/` 一行未改。

## 7. 存疑 / 后续

- 视图侧仍无「打开已保存 pipeline → 回填编辑器」的入口（G08）。逆函数已经就位并有测试，接上只差一个读接口调用。**接上之前**，§5 那六项有损只是「编辑器里看不见」；接上之后它们会变成「读一次再存一次就真丢了」，所以 G08 落地时应当先给 `pattern.flags` / `rule.message` 控件，或在回填时对带有这两项的规则加只读提示。
- `concat` 的 `values`（字面量）与 `includeCurrent=false` 没有控件；`dictMap` 的 `defaultValue` 兜底同理。要不要给控件，取决于现场是否真的有人手写过这些形状。
- 无 schema 时 concat 只能用逗号分隔的回退输入（#5596 F06 已修成受控草稿，尾随逗号不再被抹）。更好的做法是让源库 503 时也能手动补一份字段名清单，但那属于 schema 获取链路，不在本次范围。
- 映射级默认值的 `null` 语义（§5.1）目前只是被钉住，没有 UI 呈现：编辑器无法区分「这一行从没设过默认值」和「设成了 null」。真做回填时要决定是否把 `null` 显示成空。
- 映射级默认值目前按**字符串**下发（需要数字就在链上接一步 `toNumber`）。`pipelines.cjs` 的 `normalizeFieldMappings` 对该字段不做类型收敛（`mapping.defaultValue === undefined ? null : mapping.defaultValue`），所以将来要支持数字/布尔只是 UI 侧的事。
