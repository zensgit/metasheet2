# 映射源字段「不存在」不再静默覆盖目标值（X02）— 验证

- 日期：2026-09-11（返修轮：2026-09-11，X02 终审后）
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

### 全量行为差异（不是抽样）

12 条源记录 × 3 条路径 × 5 种 `defaultValue` 形状（无键 / `null` / `undefined` / `''` / `'X'`）× 11 种 transform = **1980 组**，把 `919582e71` 的 `transformRecord` 与返修后的逐组比对：

```
combinations: 1980 diffs: 420
[140] nokey | {has:true, v:<<undef>>, w:[]} -> {has:false, w:[SOURCE_FIELD_ABSENT]}
[140] null  | {has:true, v:null,      w:[]} -> {has:false, w:[SOURCE_FIELD_ABSENT]}
[140] undef | {has:true, v:<<undef>>, w:[]} -> {has:false, w:[SOURCE_FIELD_ABSENT]}
```

三个桶，方向一致：**本来写一个空值 → 现在不写并记一条告警**。`''` 与 `'X'` 两种非空默认值**零差异**（优先级未动）；没有任何一组从「写了一个非空值」变成「不写」。与第一版 `c2b482c8b` 相比是 **280 组**（只有 `null`、`undefined` 两桶），即返修新增的行为面恰好就是被终审点名的那两种形状。

## 1. 套件（15 个用例，返修新增 6 个）

`plugins/plugin-integration-core/__tests__/transform-source-field-absent.test.cjs`（932 行）：

| # | 用例 | 钉住的事实 |
| --- | --- | --- |
| 1 | `testAbsentSourcePathLeavesTargetUnwritten` | 源路径不存在 → 目标键**不出现在 payload 里**（`hasOwnProperty` 断言）；`ok` 仍 true；嵌套路径不建父容器 |
| 2 | `testPresentButEmptyStillWrites` | `null`/`''`/`0`/`false`/自有键持 `undefined` 五种"存在但空"照旧写、不记 warning |
| 3 | `testDefaultsAndTransformsStillProduceValues` | 非空 `defaultValue` 优先级不变；`defaultValue`/`dictMap.defaultValue`/`concat.values` 造出的值照旧写；纯透传 `trim`/`toNumber` 链落到不写 |
| 3b | `testBlankDefaultValueIsUnset` **（新）** | `defaultValue: null` 与 `defaultValue: undefined` 都是注册表编码的"未设置"，不算供值 → 不写 + 告警；`defaultValue: ''` 仍写；**路径存在**时回填优先级逐条不变 |
| 3c | `testBareConcatStillWritesEmptyString` **（新）** | 残留显式化：`{fn:'concat'}` 与 `{fn:'concat',fields:[...]}` 全缺时写 `''` 且不记告警；`{fn:'defaultValue',value:''}` 仍写 `''`（这正是不能放宽第三条件的原因）；产出非空值的 concat 照旧写 |
| 3d | `testEmptyArraySegmentIsAbsentByDecision` **（新）** | F02 定案：`tags[]` 对空数组 = 不存在；`tags`（数组本身）= 存在，写 `[]` 清空目标 |
| 4 | `testSkipDoesNotBypassGuards` | 3 个不安全 `targetField` 在源字段缺失时仍 `TRANSFORM_FAILED`；`required` 照旧判 `REQUIRED` |
| 5 | `testResolveSourcePathValueParityWithGetPath` | `resolveSourcePath().value` 与 `getPath()` 在 14×13 = **182 组**上 `Object.is` 相等 |
| 6 | `testTargetPatchPreservesExistingValue` | 端到端（字面量映射）：真 multitable 适配器 + `patchRecord`，缺 `name` → 库里保留 `'Correct bolt'` |
| 7 | `testRunReportsAbsenceWithCountAndFieldNames` | 3 行跑完整 `runPipeline`：`rowsFailed===0`、`details.sourceFieldAbsent={code,rows:2,fields:[2 对]}`、values-free、状态 `succeeded`、水位照推 |
| 8 | `testCleanRunCarriesNoAbsenceDetail` | 全路径存在的运行，`details` 里没有 `sourceFieldAbsent` 键 |
| 9 | `testStoredMappingShapeIsNotBlanked` **（新，本次返修的核心交付物）** | **映射由 `pipelines.__internals.rowToFieldMapping` / `normalizeFieldMappings` 产出，不含任何内联字面量**：先断言注册表确实给每条映射带 `defaultValue: null`，再跑完整 `runPipeline` 打到真 multitable 适配器，断言库里 `name` 仍是 `'Correct bolt'`、`quantity` 更新成 9、`details.sourceFieldAbsent.rows === 1`、字段对为 `{name,name}`、details 不含源值；最后断言注册表形状与字面量形状的答案**逐键相同** |
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

## 3. 变异自证（9 项，全部原地改 → 跑 → 还原 → sha256 核对）

计数口径：`total=15 failed=N`，逐个用例独立 try/catch，N 是**精确的红用例条数**。对照组（无变异）：`{"total":15,"failed":0}`。

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

1. **M13 零红。** 把行计数改回 `warnings.length > 0` 不触发任何用例。原因实读确认：`transform-engine.cjs:321` 是本文件唯一的 `warnings.push`，`code` 恒为 `SOURCE_FIELD_ABSENT`，所以今天两种写法逐行等价——这条改动是**纯潜伏加固**，没有能让它变红的当前输入。没有为它造用例，因为造出来的只能是"给 transformRecord 打桩塞一个假 code"，那是钉桩不是钉行为。
2. **未重跑整条 215 条 test-chain。** 任务硬规则禁止（磁盘约 1.5 GB）。第一版那轮的穷举结论（M1 在 215 条上只红新套件）仍然成立且**仍然无判别力**，正是本轮补用例 9 的原因。
3. **M2–M7（第一版的变异）未在返修后重跑。**

### 字节还原

每次变异后按原字节写回并核对 sha256，9 轮跑完三个文件全部 `OK`：

```
lib/transform-engine.cjs        67a738f3ab6bc23855a10fe5010234b880d02b3b559c0794fea06b193a70ea6d
lib/pipeline-runner.cjs         646115c41848f51aac91979cbaf214eda41ebad093f9bfd8fe9ddadb887d9363
lib/external-write-dry-run.cjs  d18f6a3ba1ff56fdeb78464b69df6b93ae18d31825622ba7f369f4baedd0dde7
```

## 4. 套件与检查的实际数字

### 受影响套件（逐个实跑，exit code）

```
transform-source-field-absent        exit=0   (15/15 cases)
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
test-chain-completeness              exit=0   (215 suites)
```

套件选择不是拍脑袋：对 `__tests__/` 全量 grep `transform-engine|transformRecord|external-write-dry-run|pipeline-runner`，命中 15 个文件，逐个跑完。

两条红，**均为本机缺件、与本次改动无关**：

```
b2a-trial-registry-wiring                    exit=1  MODULE_NOT_FOUND @metasheet/mssql-readonly-utils
k3-sqlserver-external-write-fence-parity     exit=1  MODULE_NOT_FOUND @metasheet/mssql-readonly-utils
```

（本 worktree 未 `pnpm install`，按任务硬规则不装；这两条属于第一版验证里记录的 16 条本机环境红之一类。）

### 语法检查

`node --check` 四个改动文件（3 个 lib + 1 个套件）全部通过。

### 溯源 pin

改动的四个文件都不在 pin 清单里，**没有重打 pin**：`lib/sealed-export/vectors/s6a-package-provenance-pins.json` 共 **66** 个 pin 键，无 `transform-engine` / `pipeline-runner` / `external-write-dry-run` / `test-chain.txt` 相关键。

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
8. 那两条 `MODULE_NOT_FOUND` 的本机红没有修（环境缺件，且禁止安装）。
