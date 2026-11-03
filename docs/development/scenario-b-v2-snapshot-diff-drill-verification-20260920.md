# 场景 B 合成 v2 快照 → diff 引擎演练 · 验证 · 2026-09-20

基线 commit：`1a6663a41d4b49de143ff35bd138115c70e998d1`。
执行环境：Windows 11，Node v25.9.0，本机检出（`lib/*.cjs` 为 CRLF）。
**没有连接任何数据库**——本刀所有实跑都在进程内完成。

设计与结论见同名 `-design-20260920.md`。本文只记「跑了什么、看见了什么、哪里踩了坑」。

## 1. 夹具生成与漂移

```
$ node fixtures/scenario-b-synthetic-bom/regenerate.cjs
wrote 01-schema.sql (1036 bytes)
wrote 02-seed.sql (8132 bytes)
wrote 03-seed-v2.sql (8398 bytes)

$ git status --porcelain fixtures/
 M plugins/plugin-integration-core/fixtures/scenario-b-synthetic-bom/regenerate.cjs
 M plugins/plugin-integration-core/fixtures/scenario-b-synthetic-bom/scenario-b-synthetic-bom.cjs
?? plugins/plugin-integration-core/fixtures/scenario-b-synthetic-bom/03-seed-v2.sql
```

**`01-schema.sql` 与 `02-seed.sql` 没有出现在改动列表里**——v1 的字节没被动过（这是硬要求：v1 是
已经灌进本机 PG 的那份）。

`03-seed-v2.sql` 相对 `02-seed.sql` 的**全部**差异（`diff` 只取 VALUES 行）：

```
4c4   qty  5 -> 105                          （① 改数量）
15c15 SYN-PRT-02-05 -> SYN-PRT-02-05R，path_key 不变  （② 原位物料替换）
36d35 SYN-PRT-04-08 整行消失                （④ 删除子件）
54c53,54 末尾多出 SYN-PRT-06-09             （③ 新增子件）
```

换行：`grep -c $'\r' 03-seed-v2.sql` → `0`（纯 LF），与 `.gitattributes:103` 的
`text eol=lf` 一致。

## 2. 插件侧实跑

```
$ node __tests__/scenario-b-v2-snapshot-diff.test.cjs
scenario-b-v2-snapshot-diff
  testTwoImmutableBatchesLand OK
  testEngineClassifiesFourChangeKinds OK
  testDiffReadRoutesServeTheSameFourKinds OK
  testSameBatchRerunConflictsAndDiffIsStable OK
  testMutationRestoringDeletedChildTurnsRemovedRed OK
  testMutationRowCountOnlyDiffTurnsChangedRed OK
  testMutationUndoingSubstitutionTurnsComponentCodeRed OK
  testFlagDefaultOffStaysReadOnly OK
scenario-b-v2-snapshot-diff: all OK
```

回归（改了夹具与 A1 的漂移断言，把相邻套件都跑一遍）：

```
scenario-b-synthetic-bom-source-run               OK
scenario-b-staging-persist                        OK
scenario-b-v2-snapshot-diff                       OK
stock-preparation-snapshot-reads                  OK
stock-preparation-snapshot-diff                   OK
stock-preparation-sync-run-persist                OK
stock-preparation-plm-source-persist-bridge       OK
test-chain-completeness                           OK
sealed-export-package-provenance                  OK
```

`test-chain-completeness`：`✓ 228 suites, all executed by 'pnpm test' (0 intentional exclusions)`。
`sealed-export-package-provenance` 跑绿说明本刀没有碰到任何被 sha256 钉住的文件
（`test-chain.txt` 与 `fixtures/` 都不在 `s6a-package-provenance-pins.json` 里——已 grep 确认）。

## 3. 实证到的四类变更（引擎直调 + 两条真路由，两个来源一致）

| | 引擎直调 `planBomSnapshotDiff` | `GET /snapshot-batches/:id/diff(/rows)` |
| --- | --- | --- |
| diff 总数 | 55 | `rowCount` 55 |
| `changed` | 2 | `data-diff-type=changed` 2 |
| `added` | 1 | 1 |
| `removed` | 1 | 1 |
| `unchanged` | 51 | 51 |
| held / ready | 4 / 51 | `heldRowCount` 4 |
| `quantity_changed` | 1 | 1 |
| `component_code_changed` | 1 | **逐行读面** 1；**汇总 `changeCounts` 里没有这一格** |
| `source_fingerprint_changed` | 2 | `changeCounts.fingerprintChanged` 2 |
| 其余九个维度 | 全部 `undefined` | `unitChanged/versionChanged/pathChanged/missingChildBom` 全 0 |

算术（写进夹具的 `V2_EXPECTED_DIFF`，测试与文档共用同一份，避免两处各写一个数）：
v1 的 54 个 `pathKey` 里有 1 个在 v2 消失 → 53 对被 path 配上；53 对里 2 对有变更 → 51 对
`unchanged`；再加 v2 独有 1 行 `added` 与 v1 独有 1 行 `removed` → 共 **55** 条。

> 任务书里写的是「其余 50 行 unchanged」。**实跑是 51**，任务书那个数是估的：54 − 1（被删）= 53
> 对，53 − 2（两条 changed）= 51。断言按实跑写，不按任务书写。

base 批次是**服务端**挑的：`resolveDiffBase` 走「同业务项目、版本严格小于当前的最高版本」
（`lib/stock-preparation-snapshot-reads.cjs:284` 的 `pickPredecessor`），请求里没传
`baseSnapshotBatchId`，返回的 `baseSnapshotBatchId` 就是 v1 批次。

## 4. 变异（全部内存级，磁盘零改动）

| # | 变异 | 预期 | 实跑 |
| --- | --- | --- | --- |
| ① | v2 把被删的子件放回去（改这次源运行看到的行集） | `removed` 断言红 | `byDiffType.removed` 从 1 → `undefined`；`unchanged` 51 → 52；`added`/`changed` 不变（说明不是「整条链跑不起来」） |
| ② | diff 引擎换成「只比行数」（`planBomSnapshotDiff` 两侧行数相等就返回零 diff） | `changed` 断言红 | 55 条 diff → 0 条；`quantity_changed`/`component_code_changed`/`added`/`removed` 全部 `undefined`；`status` 从 `held` 变 `ready`（变异体把一份有 4 处变更的对账报成「没事」）。同一对输入喂给**真**引擎仍是 55 条 —— 变异确实拿掉了能力，不是输入本身就没差异 |
| ③ | v2 把替换件改回原件号 | `component_code_changed` 断言红 | 从 1 → `undefined`；`source_fingerprint_changed` 2 → 1；`changed` 2 → 1，`unchanged` 51 → 52。**这条证明「替换」不是被指纹变化顺带报出来的** |

### 踩到的坑：跨行变异锚点在本机永远命不中

第一版的变异 ② 用了跨行锚点：

```
'function planBomSnapshotDiff(input = {}) {\n  const normalized = normalizeInput(input)'
```

本机直接红在 `变异锚点必须唯一命中一次 … 0 !== 1`。原因：`lib/*.cjs` 在这台 Windows 检出下是
**CRLF**（`file lib/stock-preparation-snapshot-diff.cjs` → `with CRLF line terminators`），
源码里的行分隔是 `\r\n`，锚点里的 `\n` 命不中。

这个坑的危险在于它**只在本机红**——CI 的 LF 检出下会命中，于是一个「在开发机上根本没跑过」的
探针会以绿色通过 CI。修法：变异锚点一律只占**一行**（`A2` 的三个守卫探针本来就是这么写的），
替换体里的换行随便用 `\n`（那是新生成的 JS 源码，不受检出换行影响）。已把这条写进测试文件头。

## 5. 页面侧

```
$ node ../../node_modules/vitest/vitest.mjs run tests/StockPreparationScenarioBAcceptance.spec.ts --reporter=dot --watch=false
 ✓ tests/StockPreparationScenarioBAcceptance.spec.ts (6 tests) 217ms
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

新增的是用例 ⑥（原有 ①–⑤ 未改）。`src/` 一个字都没改：用例只喂契约形状，断言读的是既有的
`data-testid` / `data-kind` / `data-diff-type` 属性。

`vue-tsc -b`：

```
$ ./node_modules/.bin/vue-tsc.CMD -b
EXIT=0
```

**但这条绿不覆盖本刀的 spec**：`apps/web/tsconfig.app.json` 的 `include` 只有
`["src/**/*.ts", "src/**/*.tsx", "src/**/*.vue", "src/**/*.d.ts"]`，`tests/**` 整个目录不在任何
`vue-tsc` 工程里（同仓已有两份 `tsconfig.verification-*.json` 就是为 `verification/` 补这个洞建
的，`tests/` 还没有对应的一份）。所以 spec 的类型正确性目前只由 `vitest run` 的实跑担保——这是
既有缺口，不是本刀引入的，已列入残余。

## 6. 值面与写面自检

- HTTP 响应体（批次列表 / 汇总 diff / 逐行 diff / held 过滤，共 4 个）逐个断言不含
  `SYN-`、`SYN-PRJ-B1`、`SYN-ASM-ROOT`、项目名、替换前/后件号、新增件号。
- 引擎 `evidence` 同样断言 values-free，且 `evidence.valuesFree === true`。
- 正例自检在断言 1：那些业务值**确实**到了内部写侧（否则「HTTP 里没有」可能只是因为整条链
  根本没跑起来）。
- 外部写：`externalWriteCalls.length === 0`（两次源运行 + 读面全程）。
- autopersist flag：只在测试进程内被置为 `'true'`，`withAutoPersist` 跑完即还原；另有一条断言钉住
  「不设 = OFF，一行都不写」。

## 7. 残余

1. `material_changed` 这一维度未被演练——夹具没有 `material` 列。给 v1 加列会改动已灌库的
   `02-seed.sql` 字节，本刀拒绝这么做。补法：下一刀给 v2 单独加一列 + 一条 `FIELD_MAP` 映射，
   或者在 `prep_line` 层的 diff 面一起做。
2. 汇总 `changeCounts` 的词表落后于引擎词表（缺 `componentCodeChanged` / `materialChanged`）。
   本刀把它钉成了断言（后端 + 前端各一条），但**没有修**——改词表要同时动
   `lib/stock-preparation-snapshot-reads.cjs`、openapi 契约与前端，属于另一刀，且是页面可见行为
   变化，宜单独评审。
3. `apps/web/tests/**` 不在任何 `vue-tsc` 工程里。补法与 `tsconfig.verification-*.json` 同形。
4. 双轨对账本身：老侧结果还没有可寻址的批次形状（见设计文档 §与真实双轨对账的差距第 2 条）。
   这是第 3 步真正的第一道工，本刀没碰。
5. 本刀只跑了相邻 9 支插件套件，没跑完整的 228 支链（本机跑全链耗时过长）。CI 是裁判。
