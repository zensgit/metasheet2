# 映射源字段「不存在」不再静默覆盖目标值（X02）— 验证

- 日期：2026-09-11（返修轮：2026-09-11，X02 终审后；订正轮：2026-09-11，审阅人点名 dictMap `"null"` 键）
- 分支：`fix/transform-source-field-absent`（基于 `919582e71`；第一版 `c2b482c8b`，本文为其返修后的状态）
- 本机：Windows 11，Node 在 worktree `C:\Users\zhou\Downloads\dev\metasheet-wt-g44` 内直接跑（未 `pnpm install`，未建新 worktree，未复制仓库）
- 配套设计文档：`docs/development/transform-source-field-absent-design-20260911.md`

## 0. 返修摘要：第一版的门在生产路径上是空转的

终审（17 代理对抗复核）判「修完再合」，阻断项是：不写分支的第二个条件 `usedDefault` 只测 `hasOwnProperty(mapping, 'defaultValue')`，而注册表给**每一条**存库映射都塞了这个键（`pipelines.cjs:318`、`:201`），于是该条件对任何真实管道恒为真，**分支永不触发**。我复跑确认，并且发现**第二重死锁**：即使把条件换成 `defaultApplied`，原来的取值回填 `if (usedDefault) fieldValue = mapping.defaultValue` 会把 `fieldValue` 变成 `null`，`outputValue` 于是是 `null` 而不是 `undefined`，**第三个条件独立地再挡一次**。

前后对照（进程内喂真函数，源记录 `{code:'MAT-001', quantity:9}`，缺 `name`）：

| 映射来源 | 返修前（`c2b482c8b`） | 返修后 |
| --- | --- | --- |
| 内联字面量 `[{sourceField:'name',targetField:'name'}]` | `value={}`，`warnings=1` | `value={}`，`warnings=1` |
| 存库形状 `[{...,defaultValue:null}]` | `value={"name":null}`，`warnings=0` | `value={}`，`warnings=1` |
| `__internals.rowToFieldMapping({default_value:null,...})` | `value={"name":null}`，`warnings=0` | `value={}`，`warnings=1` |
| `__internals.normalizeFieldMappings([{sourceField:'name',targetField:'name',sortOrder:0}])` | `value={"name":null}`，`warnings=0` | `value={}`，`warnings=1` |

复跑方式：进程内 `require` 真模块直接喂参数，跑完即弃，未落盘到仓库。

## 0b. 审阅人订正：`dictMap` 的 `"null"` 键（本轮的核心交付物）

审阅人的原话：「#5628 的新语义可以接受，但『不会少写非空值』承诺不成立：缺失字段遇到 `dictMap: {"null":"UNKNOWN"}`，旧版写 UNKNOWN，新版跳过。」

**实读复验：审阅人是对的，我上一版那句话是假陈述。** 复现方式：把 `919582e71` 的 `transform-engine.cjs` 取到临时目录（该文件零 `require`，可独立加载），与工作区版本各喂一次同样的参数。源记录 `{code:'MAT-001', quantity:9}`（**没有** `name` 键）：

```
===== BASELINE 919582e71 =====
inline literal (no defaultValue key)           hasKey=true  value=<<undef>>   ok=true warnings=[]
registry shape (defaultValue: null)            hasKey=true  value="UNKNOWN"   ok=true warnings=[]
chain [trim, dictMap], registry shape          hasKey=true  value="UNKNOWN"   ok=true warnings=[]
dictMap map has both undefined+null keys       hasKey=true  value="FROM_NULL" ok=true warnings=[]
dictMap with args.defaultValue, registry shape hasKey=true  value="FALLBACK"  ok=true warnings=[]
dictMap miss, no args.defaultValue             hasKey=true  value=null        ok=true warnings=[]
chain [dictMap, upper], registry shape         hasKey=true  value="UNKNOWN"   ok=true warnings=[]
trim only, registry shape                      hasKey=true  value=null        ok=true warnings=[]
PRESENT but null + dictMap, registry shape     hasKey=true  value="UNKNOWN"   ok=true warnings=[]

===== HEAD 0a35028d9（订正前） =====
inline literal (no defaultValue key)           hasKey=false value=-           ok=true warnings=[SOURCE_FIELD_ABSENT]
registry shape (defaultValue: null)            hasKey=false value=-           ok=true warnings=[SOURCE_FIELD_ABSENT]   <= 少写了 "UNKNOWN"
chain [trim, dictMap], registry shape          hasKey=false value=-           ok=true warnings=[SOURCE_FIELD_ABSENT]   <= 少写了 "UNKNOWN"
dictMap map has both undefined+null keys       hasKey=true  value="FROM_UNDEF" ok=true warnings=[]                     <= 写出的值变了
dictMap with args.defaultValue, registry shape hasKey=true  value="FALLBACK"  ok=true warnings=[]
dictMap miss, no args.defaultValue             hasKey=false value=-           ok=true warnings=[SOURCE_FIELD_ABSENT]
chain [dictMap, upper], registry shape         hasKey=false value=-           ok=true warnings=[SOURCE_FIELD_ABSENT]   <= 少写了 "UNKNOWN"
trim only, registry shape                      hasKey=false value=-           ok=true warnings=[SOURCE_FIELD_ABSENT]
PRESENT but null + dictMap, registry shape     hasKey=true  value="UNKNOWN"   ok=true warnings=[]

===== 本轮（dictMap 兼容键） =====
inline literal (no defaultValue key)           hasKey=false value=-           ok=true warnings=[SOURCE_FIELD_ABSENT]
registry shape (defaultValue: null)            hasKey=true  value="UNKNOWN"   ok=true warnings=[]
chain [trim, dictMap], registry shape          hasKey=true  value="UNKNOWN"   ok=true warnings=[]
dictMap map has both undefined+null keys       hasKey=true  value="FROM_NULL" ok=true warnings=[]
dictMap with args.defaultValue, registry shape hasKey=true  value="FALLBACK"  ok=true warnings=[]
dictMap miss, no args.defaultValue             hasKey=false value=-           ok=true warnings=[SOURCE_FIELD_ABSENT]
chain [dictMap, upper], registry shape         hasKey=true  value="UNKNOWN"   ok=true warnings=[]
trim only, registry shape                      hasKey=false value=-           ok=true warnings=[SOURCE_FIELD_ABSENT]
PRESENT but null + dictMap, registry shape     hasKey=true  value="UNKNOWN"   ok=true warnings=[]
```

根因、裁决（选「让 dictMap 仍能兜底」而不是改口径）、修法与边界写在设计文档 3.8。一句话：改动前喂给链的不是 `undefined` 而是回填出来的 `null`，`dictMap` 查的键因此是 `"null"`；修法是**只把查表键**还原成改动前会查的那个键，值一个字不动，所以未命中仍然不写。

两处**上一版遗漏**在此点名：

1. 上一版「1980 组里没有任何一组从写非空值变成不写」是假陈述——网格的 transform 维度里没有任何一本字典能命中 `"null"`，这一类结构性地在网格之外。订正后的盘点见下。
2. 上一版还漏了一类**写出的值被改掉**的差异（`dictMap` 的 `"undefined"` 键在存库映射上被新的 `undefined` 意外命中），审阅人没点到，是重跑网格时发现的。本轮一并归零。

### 全量行为差异（不是抽样；本轮重建并订正）

上一版的网格脚本是进程内跑完即弃的、没有留档，所以本轮**重建**网格，并把 transform 维度补全到 17 种（新增 `dictMap:nullKey` / `dictMap:undefKey` / `dictMap:bothKeys` / `trim+dictMap:nullKey` / `dictMap:nullKey+upper` 五种，以及 `dictMap:miss`）。维度：

- 12 条源记录：`{}`、`{spec:'  S1  '}`、`{spec:null}`、`{spec:''}`、`{spec:0}`、`{spec:false}`、`{spec:undefined}`、`{head:{}}`、`{head:{spec:'X'}}`、`{lines:[]}`、`{lines:[{spec:'L1'}]}`、`{other:'z'}`
- 3 条路径：`spec` / `head.spec` / `lines[].spec`
- 5 种 `defaultValue` 形状：无键 / `null` / `undefined` / `''` / `'X'`
- 17 种 transform：无 / `trim` / `upper` / `lower` / `toNumber` / `toDate` / `defaultValue:D` / `defaultValue:''` / bare `concat` / `concat` 带字面量 / `dictMap` 未命中 / `dictMap` 未命中带 `defaultValue` / `dictMap` 带 `"null"` 键 / 带 `"undefined"` 键 / 两键并存 / `[trim, dictMap]` / `[dictMap, upper]`

三个版本两两比对（`919582e71` 为基线），逐组比 `{ok, 是否写了键, 值, warnings, errors}`：

```
grid: 12 records x 3 paths x 5 defaultValue shapes x 17 transforms = 3060

### baseline 919582e71 vs pre-fix HEAD 0a35028d9
combinations: 3060  diffs: 896
  [ 756] A: baseline wrote a BLANK -> now unwritten
         e.g. empty | spec | default=nokey | none :: base=<<undef>>/w[] -> new=<unwritten>/w[SOURCE_FIELD_ABSENT]
  [  84] B: baseline wrote a NON-EMPTY -> now unwritten
         e.g. empty | spec | default=null | dictMap:nullKey :: base="UNKNOWN"/w[] -> new=<unwritten>/w[SOURCE_FIELD_ABSENT]
  [  28] C-blank: written value CHANGED
         e.g. empty | spec | default=null | dictMap:undefKey :: base=null/w[] -> new="UNDEF"/w[]
  [  28] C-nonempty: written value CHANGED
         e.g. empty | spec | default=null | dictMap:bothKeys :: base="N"/w[] -> new="U"/w[]

### baseline 919582e71 vs working tree (dictMap compat)
combinations: 3060  diffs: 784
  [ 784] A: baseline wrote a BLANK -> now unwritten
         e.g. empty | spec | default=nokey | none :: base=<<undef>>/w[] -> new=<unwritten>/w[SOURCE_FIELD_ABSENT]
```

**更正后的数字**：订正前 **896 组差异**，其中 **84 组是「本来写一个非空值 → 现在不写」**（审阅人点名的那一类）、**28 组「写出的值变了」（非空 → 另一个非空）**、**28 组「`null` → 一个非空值」**。订正后 **784 组差异，全部是同一个方向**：本来写一个空值（`undefined`/`null`/`''`）→ 现在不写并记一条告警。**B 类、C 类全部归零。**

`''` 与 `'X'` 两种非空默认值仍然**零差异**（优先级未动）。784 比 756 多出的 28 组是 `dictMap` 的 `"undefined"` 键那一族，从「值被改掉」回到了「改动前写空值、现在不写」。

（顺带说明：把网格砍回 11 种 transform、剔掉全部 `dictMap` 键形状，订正前后都是 504 组差异且全是 A 类——这正是上一版看不见这一类的原因：**盲区在 transform 维度，不在记录/路径/默认值维度**。上一版报的 420 与这里的 504 不同，是因为记录/路径两维的取值不同；原脚本没留档，我不声称复刻了它。）

## 1. 套件（17 个用例：返修轮新增 6 个，本订正轮再新增 2 个）

`plugins/plugin-integration-core/__tests__/transform-source-field-absent.test.cjs`（1111 行）：

| # | 用例 | 钉住的事实 |
| --- | --- | --- |
| 1 | `testAbsentSourcePathLeavesTargetUnwritten` | 源路径不存在 → 目标键**不出现在 payload 里**（`hasOwnProperty` 断言）；`ok` 仍 true；嵌套路径不建父容器 |
| 2 | `testPresentButEmptyStillWrites` | `null`/`''`/`0`/`false`/自有键持 `undefined` 五种"存在但空"照旧写、不记 warning |
| 3 | `testDefaultsAndTransformsStillProduceValues` | 非空 `defaultValue` 优先级不变；`defaultValue`/`dictMap.defaultValue`/`concat.values` 造出的值照旧写；纯透传 `trim`/`toNumber` 链落到不写 |
| 3b | `testBlankDefaultValueIsUnset` **（新）** | `defaultValue: null` 与 `defaultValue: undefined` 都是注册表编码的"未设置"，不算供值 → 不写 + 告警；`defaultValue: ''` 仍写；**路径存在**时回填优先级逐条不变 |
| 3c | `testBareConcatStillWritesEmptyString` **（新）** | 残留显式化：`{fn:'concat'}` 与 `{fn:'concat',fields:[...]}` 全缺时写 `''` 且不记告警；`{fn:'defaultValue',value:''}` 仍写 `''`（这正是不能放宽第三条件的原因）；产出非空值的 concat 照旧写 |
| 3e | `testDictMapNullKeyStillAnswersAbsentSource` **（本轮新增）** | 审阅人订正：存库形状 + `dictMap {"null":"UNKNOWN"}` 在源字段缺失时**照旧写 `UNKNOWN`**（`rowToFieldMapping` / `normalizeFieldMappings` 两种产出，字典经 `JSON.stringify` 存取）；`[trim,dictMap]`/`[upper,dictMap]`/`[dictMap,upper]` 同样命中；**未命中仍不写**；`trim`/`upper`/`lower`/`toNumber`/`toDate` 单步**仍不写**（钉住「不做全局归一化」）；无 `defaultValue` 键的字面量映射**不**被 `"null"` 条目命中、但被 `"undefined"` 条目命中（钉住「键跟着映射走」）；两键并存时命中 `"null"`；`args.defaultValue` 与非空 `mapping.defaultValue` 照旧 |
| 3d | `testEmptyArraySegmentIsAbsentByDecision` **（新）** | F02 定案：`tags[]` 对空数组 = 不存在；`tags`（数组本身）= 存在，写 `[]` 清空目标 |
| 4 | `testSkipDoesNotBypassGuards` | 3 个不安全 `targetField` 在源字段缺失时仍 `TRANSFORM_FAILED`；`required` 照旧判 `REQUIRED` |
| 5 | `testResolveSourcePathValueParityWithGetPath` | `resolveSourcePath().value` 与 `getPath()` 在 14×13 = **182 组**上 `Object.is` 相等 |
| 6 | `testTargetPatchPreservesExistingValue` | 端到端（字面量映射）：真 multitable 适配器 + `patchRecord`，缺 `name` → 库里保留 `'Correct bolt'` |
| 7 | `testRunReportsAbsenceWithCountAndFieldNames` | 3 行跑完整 `runPipeline`：`rowsFailed===0`、`details.sourceFieldAbsent={code,rows:2,fields:[2 对]}`、values-free、状态 `succeeded`、水位照推 |
| 8 | `testCleanRunCarriesNoAbsenceDetail` | 全路径存在的运行，`details` 里没有 `sourceFieldAbsent` 键 |
| 9 | `testStoredMappingShapeIsNotBlanked` **（新，本次返修的核心交付物）** | **映射由 `pipelines.__internals.rowToFieldMapping` / `normalizeFieldMappings` 产出，不含任何内联字面量**：先断言注册表确实给每条映射带 `defaultValue: null`，再跑完整 `runPipeline` 打到真 multitable 适配器，断言库里 `name` 仍是 `'Correct bolt'`、`quantity` 更新成 9、`details.sourceFieldAbsent.rows === 1`、字段对为 `{name,name}`、details 不含源值；最后断言注册表形状与字面量形状的答案**逐键相同** |
| 9b | `testDictMapCompatWritesThroughTheRunner` **（本轮新增）** | 同一件事走完整 `runPipeline` + 真 multitable 适配器：字典命中 → 库里 `name` 被写成 `UNKNOWN`、`details` 里**没有** `sourceFieldAbsent`；同一套接线换成字典未命中 → 库里 `name` 仍是 `'Correct bolt'`、`sourceFieldAbsent.rows === 1`（钉住「换键不许把写面放宽」） |
| 10 | `testDryRunReportsAbsenceAndWritesNothing` **（新）** | dry-run 分支：不写、`rowsWritten===0`、`preview.records[0].transformed` 缺那个键、`details.dryRun===true` 且 `details.sourceFieldAbsent` 与实跑同形、水位表为空 |
| 11 | `testFieldsTruncatedOnlyWhenAPairWasDropped` **（新）** | 恰好 50 个不同字段对 × 2 行 → `fields.length===50` 且**没有** `fieldsTruncated`；51 对 × 1 行 → `fields.length===50` 且 `fieldsTruncated===true` |
| 12 | `testPlannerConvergesWhenSourceFieldIsAbsent` **（新）** | C6 规划器收敛性：第 1 轮判 `update` 且写出的 payload 不含缺失字段、库里旧值保留；第 2 轮判 `skip`、不再发第二次写 |

套件用 `require.main === module` 守卫 + 导出 `CASES`，既能被 test-chain 以 `node __tests__/...` 整跑，也能被变异探针逐个用例跑来数精确条数。

### 一条被改掉的既有断言（点名）

第一版的用例 3 有一条 `defaultValue: undefined` → **照写**的断言（原 `:132-137`）。返修后它改成**不写**，理由写在设计文档 3.1：`pipelines.cjs:201` 自己就把 `undefined` 折成 `null` 存库，也就是注册表把 `undefined` 当作"没给"；再把它当"操作员明示给了值"就自相矛盾。这条路径在生产上不可达（JSON 表达不出 `undefined`，`normalizeFieldMappings` 也会折掉），所以改动面只在 JS 字面量。

**这一点与派工说明不一致，在此点名**：派工写「`:289` 的取值回填一字不动，必须保住 `:132-137` 已钉住的『`defaultValue` 键存在但值 undefined → 照写』」。实测这两条要求互相矛盾——`:132-137` 绿不绿取决于 `:297` 的第二条件，不取决于 `:289`；只要第二条件改用 `!defaultApplied`（派工的另一条硬要求），这条用例必红。而且**只改第二条件、回填一字不动，阻断项根本没修好**（变异 M9 实证）。

## 2. test-chain 接线

`plugins/plugin-integration-core/test-chain.txt` 第 33 行的接线**未改动**（返修没有新增套件文件）：

```
$ node __tests__/test-chain-completeness.test.cjs
✓ test-chain-completeness: 215 suites, all executed by `pnpm test` (0 intentional exclusions)
```

## 3. 变异自证（返修轮 9 项 + 订正轮 6 项，全部原地改 → 跑 → 还原 → sha256 核对）

计数口径：`total=17 failed=N`，逐个用例独立 try/catch，N 是**精确的红用例条数**。订正轮的对照组（无变异）：`{"total":17,"failed":0,"red":[]}`。

### 3.1 订正轮（本轮，对照组 17/17 绿）

| 变异 | 改了什么 | 文件 | 红 | 红在哪句断言 |
| --- | --- | --- | --- | --- |
| **M17** | `dictMap` 不再读兼容键（= `0a35028d9` 的行为） | transform-engine | **2 / 17** | `testDictMapNullKeyStillAnswersAbsentSource`（`the dictionary answer for an absent source is still written`）、`testDictMapCompatWritesThroughTheRunner`（`a dictMap answer for an absent source column is still written through the runner, as on 919582e71`） |
| **M18** | 兼容键写死成 `"null"`，不跟映射走 | transform-engine | **1 / 17** | `testDictMapNullKeyStillAnswersAbsentSource`（`a "null" entry does not fire for a mapping that never fed null`） |
| **M19** | 改成**全局归一化**（缺失时 `fieldValue = null`），而不是换键 | transform-engine | **13 / 17** | 含 `testStoredMappingShapeIsNotBlanked`（`a REGISTRY-SHAPED mapping must not blank the stored value either`）、`testPlannerConvergesWhenSourceFieldIsAbsent`、`testDictMapCompatWritesThroughTheRunner`（`a dictionary MISS must still leave the stored value alone`）等 —— 即本刀堵上的覆盖写整条回来 |
| M20 | 兼容键发给**每一条**映射，不限于不写分支 | transform-engine | **0 / 17** | —（**负结果**，见下） |
| **M8**（重跑） | 门的第二条件改回 `!usedDefault` | transform-engine | **6 / 17** | 返修轮那 4 条 + 本轮两条新用例 |
| **M11**（重跑） | 规划器改回比全部 `writableFields` | external-write-dry-run | **1 / 17** | `testPlannerConvergesWhenSourceFieldIsAbsent` |

**M20 是负结果，如实标注**：把兼容键无条件发给所有映射，17 条用例一条不红。实读原因：`dictMap` 只在 `value === undefined` 时才读这个键，而链里能出现 `undefined` 的路径只有两条——「路径不存在且没真默认值」（就是被 M20 拿掉的那个条件本身），以及「键存在但持 `undefined` 且没有 `defaultValue` 键」（此时 `absentSourceLookupKey` 返回的就是 `'undefined'`，与不加兼容键**同解**）。所以那个条件今天是**作用域收窄**（把新语义关在本来就会落到不写的那条分支里），不是行为差异。保留它的理由是防御性的：日后若有人放宽回填规则，没有这个条件就会静默把兼容键漏给别的象限。没有为它造用例，因为造出来的只能是钉一个今天不存在的分支。

### 3.2 返修轮（9 项，计数口径当时是 `total=15`；本轮只重跑了 M8 / M11，见上）

| 变异 | 改了什么 | 文件 | 红 | 红的用例 |
| --- | --- | --- | --- | --- |
| **M8** | 门的第二条件改回 `!usedDefault`（= 第一版形态） | transform-engine | **4 / 15** | `testBlankDefaultValueIsUnset`、**`testStoredMappingShapeIsNotBlanked`**（`a REGISTRY-SHAPED mapping must not blank the stored value either`）、`testDryRunReportsAbsenceAndWritesNothing`、`testFieldsTruncatedOnlyWhenAPairWasDropped` |
| **M9** | 取值回填改回 `if (usedDefault) ...`（= 派工要求的"一字不动"） | transform-engine | **5 / 15** | M8 那 4 条 + `testPlannerConvergesWhenSourceFieldIsAbsent` |
| M10 | `defaultApplied` 去掉 `!== null`（空 `null` 也算供值） | transform-engine | 5 / 15 | 同 M9 |
| M11 | 规划器改回比全部 `writableFields` | external-write-dry-run | **1 / 15** | `testPlannerConvergesWhenSourceFieldIsAbsent`（`the plan converges instead of re-planning a no-op update`） |
| M12 | 计数改回"先判上限再去重" | pipeline-runner | **1 / 15** | `testFieldsTruncatedOnlyWhenAPairWasDropped` |
| M13 | 行计数改回看 `warnings.length`（不按 code 过滤） | pipeline-runner | **0 / 15** | —（**负结果**，见下） |
| M14 | 第三条件放宽成 `isBlank(outputValue)` | transform-engine | **1 / 15** | `testBareConcatStillWritesEmptyString` |
| M15 | 空数组段当作存在 | transform-engine | **1 / 15** | `testEmptyArraySegmentIsAbsentByDecision` |
| M16 | 成功路径不再 `...buildSourceFieldAbsentDetails()` | pipeline-runner | 4 / 15 | `testRunReportsAbsenceWithCountAndFieldNames`、`testStoredMappingShapeIsNotBlanked`、`testDryRunReportsAbsenceAndWritesNothing`、`testFieldsTruncatedOnlyWhenAPairWasDropped` |

（第一版的 M1–M7 见 git 历史，未在本轮重跑。）

### 判别力自证（本轮的核心要求）

**M8 是判别力证据**：把门改回第一版形态后，用例 9（映射由注册表函数产出）**红在端到端断言上**——`a REGISTRY-SHAPED mapping must not blank the stored value either`，即库里的 `'Correct bolt'` 真的被覆盖了。与此同时，**所有内联字面量的用例全部保持绿**：用例 1（`testAbsentSourcePathLeavesTargetUnwritten`）、用例 6（`testTargetPatchPreservesExistingValue`）、用例 7（`testRunReportsAbsenceWithCountAndFieldNames`）在 M8 下一条不红。这正是终审说的「214 条既有套件 + 新套件，合计 0 条能钉住真路径」——现在有 4 条能（3b 用写死的 `defaultValue: null`，9/10/11 直接用注册表函数产出映射），而原有的字面量用例仍然对真路径无判别力。

用例 9 的断言顺序是刻意的：形状比对被放在端到端断言**之后**，否则一条便宜的 `transformRecord` 比对会先短路，红在一个没有说服力的地方。

### 负结果（诚实标注）

1. **M13 零红。** 把行计数改回 `warnings.length > 0` 不触发任何用例。原因实读确认：`transform-engine.cjs:359` 是本文件唯一的 `warnings.push`，`code` 恒为 `SOURCE_FIELD_ABSENT`，所以今天两种写法逐行等价——这条改动是**纯潜伏加固**，没有能让它变红的当前输入。没有为它造用例，因为造出来的只能是"给 transformRecord 打桩塞一个假 code"，那是钉桩不是钉行为。
2. **未重跑整条 215 条 test-chain。** 任务硬规则禁止（磁盘约 1.5 GB）。第一版那轮的穷举结论（M1 在 215 条上只红新套件）仍然成立且**仍然无判别力**，正是本轮补用例 9 的原因。
3. **M2–M7（第一版的变异）未在返修后重跑。**

### 字节还原

每次变异后按原字节写回并核对 sha256，两轮跑完全部 `OK`。订正轮结束后工作区的字节（Windows 检出，CRLF；入库按 `.gitattributes` 归一成 LF）：

```
lib/transform-engine.cjs                          a14d102bbc4c458e618663a3635936bd64a4b2188c33e04aa35f9f0835bc3f75
lib/pipeline-runner.cjs                           8f0a1bddb4c4c7e28e61fdb43dca780ec1d0b07f830317514e4ce9b90aa8dfe1
lib/external-write-dry-run.cjs                    7f0465f4bc94a90e4d9a0bcb75c9520d375713c00e15ab254dbda4db6adc24d9
__tests__/transform-source-field-absent.test.cjs  828fbb2e99cd07a4172b1d61dbf421acf6918940b0d9bcaef3c6344b71101b91
```

本轮对三个 lib 的改动面：`transform-engine.cjs` 是**代码**改动（兼容键）；`pipeline-runner.cjs` 与 `external-write-dry-run.cjs` 只改了**注释里指向 `transform-engine.cjs` 的行号**（代码行移位了），没有可执行语句变化——`git diff` 可核。返修轮记录的哈希（`67a738f3…` / `646115c4…` / `d18f6a3b…`）因此全部作废，以上为本轮收尾字节。

## 4. 套件与检查的实际数字

### 受影响套件（逐个实跑，exit code）

订正轮逐个重跑（**本轮的数字**）：

```
transform-source-field-absent        exit=0   (17/17 cases)
transform-validator                  exit=0
pipeline-runner                      exit=0
external-write-dry-run               exit=0   (1373 行既有套件，规划器改动下仍全绿)
http-routes                          exit=0
pipelines                            exit=0
k3-df-t1-target-payload-preview      exit=0
e2e-plm-k3wise-writeback             exit=0
k3-raw-row-intake-aliases            exit=0
metasheet-multitable-target-adapter  exit=0
data-source-sql-readonly-source-adapter exit=0
df-n2-2c-provenance-read             exit=0
http-routes-plm-k3wise-poc           exit=0
k3-external-write-permanent-fence    exit=0
k3-wise-c6-write-profile             exit=0
k3-write-approval-posture            exit=0
outbound-http-write-gate             exit=0
k3-wise-adapters                     exit=1   MODULE_NOT_FOUND @metasheet/mssql-readonly-utils（本机缺件）
k3-save-body-composer.parity         exit=0
test-chain-completeness              exit=0   (215 suites)
```

套件选择不是拍脑袋：对 `__tests__/` 全量 grep `transform-engine|transformRecord|external-write-dry-run|pipeline-runner`，命中 15 个文件，逐个跑完。

两条红，**均为本机缺件、与本次改动无关**：

```
b2a-trial-registry-wiring                    exit=1  MODULE_NOT_FOUND @metasheet/mssql-readonly-utils
k3-sqlserver-external-write-fence-parity     exit=1  MODULE_NOT_FOUND @metasheet/mssql-readonly-utils
k3-wise-adapters                             exit=1  MODULE_NOT_FOUND @metasheet/mssql-readonly-utils
```

（`k3-wise-adapters` 在返修轮的清单里没有，是本轮补跑时才跑到的；它在 `require` 阶段就崩，连本刀改的代码都没加载。）

（本 worktree 未 `pnpm install`，按任务硬规则不装；这两条属于第一版验证里记录的 16 条本机环境红之一类。）

### 语法检查

`node --check` 四个改动文件（3 个 lib + 1 个套件）全部通过（订正轮重跑了改动过的 `transform-engine.cjs` 与套件）。

### 溯源 pin

改动的四个文件都不在 pin 清单里，**没有重打 pin**：`lib/sealed-export/vectors/s6a-package-provenance-pins.json` 共 **66** 个 pin 键，无 `transform-engine` / `pipeline-runner` / `external-write-dry-run` / `test-chain.txt` 相关键。

订正轮复核：pin 文件**一字未改**，叶子键数仍是 **66**，`sealed-export-package-provenance.test.cjs` `exit=0`。

### type-check

- 本次改动**没有 TS/Vue 文件**。
- **没跑**：仓库级 `pnpm -r type-check` 与 `pnpm -r lint`（无 TS 改动 + 磁盘约 1.5 GB、禁止 `pnpm install`）。以 CI 为准。

## 5. 我没跑 / 没做的事

1. `pnpm -r type-check`、`pnpm -r lint`。
2. 整条 215 条 test-chain（任务硬规则禁止；只跑了 18 条相关套件 + completeness 守卫）。
3. `apps/web` 的任何测试：本刀没有改前端。`details.sourceFieldAbsent` 在运行历史面板上的渲染**仍然没有**——设计文档 §6 第 6 条记录了原因与正确的一刀在哪。
4. 真实数据库 / 222 上机验证：没做，全部是进程内假件。
5. `external-write-dry-run` 的 `counts` / `rowErrorTypes` 没有新增 `source_field_absent` 口径（只做了收敛性修复）。
6. `sourceFieldAbsent.rows` 没有抬进 `metrics`：那会牵动落库形状（`run-log.cjs:45-52` 只透传 5 个键，且它们是**独立列**不是 JSONB），按派工要求"只登记不做"。
7. bare `concat` 的**行为**没有修正（只钉住现状 + 订正文档口径），留下一刀。
8. 那两条 `MODULE_NOT_FOUND` 的本机红没有修（环境缺件，且禁止安装）；订正轮补跑时又撞到第三条同因的 `k3-wise-adapters`，同样没修。

### 订正轮（本轮）额外没跑 / 没做的

1. **没有复刻上一版那个 1980 组的脚本**：它是进程内跑完即弃的，没有留档。本轮是**重建**网格（3060 组）并把 transform 维度补全，所以本轮的 A 类条数（784）与上一版报的 420 不可直接相减；两者的记录/路径维度取值不同。能直接对照的是**同一份新脚本**跑出的三个版本结果。
2. **没有把 `dictMap` 未命中时的口径改回去**：改动前写 `null`（存库映射）/ `undefined`（字面量映射），现在不写。这属于本刀的目标行为，不是回归。
3. **`concat` 没有拿到兼容键**：它今天对缺失部件的答案是 `''`（不是 `undefined`），本来就会被写出去，与本轮的洞无关；bare `concat` 的残留仍见设计文档 3.4。
4. **M20 零红**（把兼容键无条件发给所有映射）：如实标注为负结果，原因见 3.1 末。
5. **没跑** 整条 215 条 test-chain、`pnpm -r type-check`、`pnpm -r lint`、真库/222 上机；订正轮跑的是 20 条相关套件（含 completeness 与 pin 两条守卫）。
6. **没有改 `apps/web`、没有改 pin、没有改 `test-chain.txt`**（本轮没有新增套件文件，两条新用例挂在既有套件里）。
