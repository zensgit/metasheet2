# 映射源字段「不存在」不再静默覆盖目标值（X02）— 验证

- 日期：2026-09-11
- 分支：`fix/transform-source-field-absent`（基于 `919582e71`）
- 本机：Windows 11，Node 在 worktree `C:\Users\zhou\Downloads\dev\metasheet-wt-g44` 内直接跑（未 `pnpm install`，未建新 worktree，未复制仓库）
- 配套设计文档：`docs/development/transform-source-field-absent-design-20260911.md`

## 1. 新增套件

`plugins/plugin-integration-core/__tests__/transform-source-field-absent.test.cjs`，8 个用例：

| # | 用例 | 钉住的事实 |
| --- | --- | --- |
| 1 | `testAbsentSourcePathLeavesTargetUnwritten` | 源路径不存在 → 目标键**不出现在 payload 里**（用 `hasOwnProperty` 断言，不是断言值为 `undefined`）；`ok` 仍为 true；`errors` 为空；`warnings` 条目逐字段比对；嵌套路径不会顺手建出父对象/父数组；空数组算不存在 |
| 2 | `testPresentButEmptyStillWrites` | `null` / `''` / `0` / `false` / 自有键持 `undefined` 五种"存在但空"照旧写，且不记 warning；嵌套与数组形式同 |
| 3 | `testDefaultsAndTransformsStillProduceValues` | `mapping.defaultValue`（含显式 `undefined`）优先级不变；`defaultValue` / `dictMap.defaultValue` / `concat.values` 造出的值照旧写；纯透传的 `trim` / `toNumber` 链则落到不写 |
| 4 | `testSkipDoesNotBypassGuards` | 3 个不安全 `targetField` 在源字段缺失时**仍然** `TRANSFORM_FAILED`；`required` 对"没写的键"照旧判 `REQUIRED`；无 `sourceField` 的常量型映射行为不变 |
| 5 | `testResolveSourcePathValueParityWithGetPath` | `resolveSourcePath().value` 与 `getPath()` 在 14 记录 × 13 路径 = **182 组**上 `Object.is` 相等；另有 6 条 `found` 的正/反例 |
| 6 | `testTargetPatchPreservesExistingValue` | 端到端：真 `metasheet:multitable` 目标适配器 + `patchRecord`，源行缺 `name` 列 → 库里 `name` 保留 `'Correct bolt'`，`quantity` 照常更新为 9，行数仍为 1（没变成插入） |
| 7 | `testRunReportsAbsenceWithCountAndFieldNames` | 3 行源数据跑完整 `runPipeline`：`rowsFailed === 0`、`rowsWritten === 3`；三条 payload 的键集逐个比对；`details.sourceFieldAbsent` 等于 `{code, rows: 2, fields:[2 对]}`；run details 整串不含 6 个源值；**run 状态仍 `succeeded`、水位仍推进到 `2026-09-10T02:00:00.000Z`**（把"本刀不改水位"钉成成文事实） |
| 8 | `testCleanRunCarriesNoAbsenceDetail` | 所有映射路径都存在（值为 `null`）的运行，`details` 里**没有** `sourceFieldAbsent` 这个键 |

套件用 `require.main === module` 守卫 + 导出 `CASES`，既能被 test-chain 以 `node __tests__/...` 整跑，也能被变异探针逐个用例跑来数精确条数。

## 2. test-chain 接线

插入位置：`plugins/plugin-integration-core/test-chain.txt` **第 33 行**，上下文是

```
31: # --- suites (order not significant; add new suites here) ---
32: node __tests__/plugin-runtime-smoke.test.cjs
33: node __tests__/transform-source-field-absent.test.cjs      <-- 新增
34: node __tests__/app-manifest.test.cjs
```

即 suites 区块的第 2 条，远在 `# --- sealed-export stage tail: S4 -> S5 -> S6-A ...`（第 224 行，插入后）之前。该文件在 `.gitattributes:69` 声明 `text eol=lf merge=union`，写入按 LF，`git diff --stat` 只有 `1 insertion(+)`，没有换行符噪声。

执行到位的证据（不是自述，是仓内守卫算出来的）：

```
$ node __tests__/test-chain-completeness.test.cjs
✓ test-chain-completeness: 215 suites, all executed by `pnpm test` (0 intentional exclusions)
```

改动前是 214。另外直接解析 `test-chain.txt` 确认命令序号：

```
total commands: 215
index of new suite: 1
node __tests__/transform-source-field-absent.test.cjs
```

## 3. 变异自证（7 项，全部原地改 → 跑 → 还原 → 字节核对）

计数口径：`CASES total=8 failed=N`，逐个用例独立 try/catch，所以 N 是**精确的红用例条数**（不是"第一条就中断"）。另外同时跑 6 个相关既有套件看有没有连带红。

| 变异 | 改了什么 | 新套件红用例 | 红的用例名 | 既有套件 |
| --- | --- | --- | --- | --- |
| M1 | 把缺陷放回去：`if (false && !resolved.found && ...)`，即照旧写 `undefined` | **5 / 8** | Absent…Unwritten、Defaults…、SkipDoesNotBypassGuards、TargetPatchPreserves…、RunReportsAbsence… | 6 个全绿 |
| M2 | 保留"不写"，删掉 `warnings.push({...})` 这个编码信号 | **5 / 8** | 同上 5 条（含 run details 那条） | 6 个全绿 |
| M3 | 把 `null` / `''` 也当成"不存在"（`found = false`） | **1 / 8** | ResolveSourcePathValueParity… | 6 个全绿 |
| M4 | "不写"分支里删掉 `parseTargetPath(targetField)`，让跳过写入顺带跳过路径守卫 | **1 / 8** | SkipDoesNotBypassGuards（`__proto__: unsafe target path still fails`） | 6 个全绿 |
| M5 | 成功路径不再 `...buildSourceFieldAbsentDetails()` | **1 / 8** | RunReportsAbsence…（`run details carry the COUNT…`） | 6 个全绿 |
| M6 | 保留计数，把 `fields` 置空（只报数不报字段名） | **1 / 8** | RunReportsAbsence… | 6 个全绿 |
| M7 | 让缺失计入 `metrics.rowsFailed += 1`（即擅自动水位语义） | **1 / 8** | RunReportsAbsence…（`absence is not a row failure`） | 6 个全绿 |

同跑的 6 个既有套件：`transform-source-field-absent`、`transform-validator`、`pipeline-runner`、`http-routes`、`external-write-dry-run`、`k3-df-t1-target-payload-preview`。

对照组（无变异）：`CASES total=8 failed=0`。

每次变异后都把文件按原字节写回，并核对 sha256：

```
397381458d203031a23e9d17e5440dda55092c28c1b2bf639805527a38642111  lib/transform-engine.cjs
374e589b245cf86a00fa4d938b40e87c82a751086124c8328209f085ad6eb8fa  lib/pipeline-runner.cjs
21857fc868f08572b946816a81e27a15d547d959e325c631a85c1f330415795b  test-chain.txt
```

七轮跑完后三项全部 `OK`（`sha256sum -c`）。

### 负结果（诚实标注）

**M1（把缺陷原样放回去）在整条 215 条 test-chain 上只让 1 个套件变红，就是新加的那个。** 这一条是穷举跑出来的，不是抽样：

```
MUTATION M1 over the FULL chain
  chain: 215 commands, 198 pass, 17 fail        （基线是 199 pass / 16 fail）
  newly red vs baseline (1):
    __tests__/transform-source-field-absent.test.cjs
  no longer red (0): []
  restored sha: 397381458d203031a23e9d17e5440dda55092c28c1b2bf639805527a38642111
```

也就是说：改动前的 214 条既有套件里，没有一条钉住这条行为——这正是它能以"静默"形态存活的原因。M2–M7 我只在上表那 6 个套件范围内看了连带情况（都绿），没有对每一条变异都跑满 215 条，所以对 M2–M7 只能说"这 6 个没红"，不能推广。

代价：这条线的回归保护落在 `transform-source-field-absent.test.cjs` 一个套件上，它一旦掉出 test-chain 就等于保护消失（所以第 2 节把"链条确实执行到它"单独取证）。

## 4. 套件与检查的实际数字

### 受影响套件（逐个）

```
transform-validator                PASS
pipeline-runner                    PASS
external-write-dry-run             PASS
http-routes                        PASS
k3-df-t1-target-payload-preview    PASS
e2e-plm-k3wise-writeback           PASS
k3-raw-row-intake-aliases          PASS
transform-source-field-absent      PASS（新增）
```

### 整条 test-chain

`node scripts/test-chain.cjs` 是 fail-fast，在本机第 1 条就停（见下），所以另外用一个 continue-on-failure 的执行器把 215 条全部跑了一遍：

```
chain: 215 commands, 199 pass, 16 fail   (real 0m50.471s)
```

16 条红全部是**本机环境缺件**，与本次改动无关：

- 8 条 `MODULE_NOT_FOUND @metasheet/mssql-readonly-utils`（该 workspace 包在本 worktree 的 `node_modules` 里没有链接；`packages/mssql-readonly-utils` 存在，但本 worktree 未 `pnpm install`，按任务硬规则不装）
- `MODULE_NOT_FOUND mssql`、`MODULE_NOT_FOUND pg` 各 1 条
- `spawnSync python3 ENOENT` 1 条（real-DB step contract 守卫 fail-closed）
- `vitest.config.ts must ... exclude ...` 2 条、`AssertionError` 2 条（sealed-export S3/S4/S6-A 系列，同属缺件环境）

**不是自述，是对照跑出来的**：把 `lib/transform-engine.cjs` 与 `lib/pipeline-runner.cjs` 临时换成 `HEAD` 版本（按 autocrlf 写回 CRLF），这 16 条**逐条仍然 exit=1**；随后按原字节还原并核对 sha256 通过。

CI 才是裁判——这 16 条在 CI 上的结论以 CI 为准。

### 溯源 pin

改动的三个文件都不在 pin 清单里，**没有重打 pin**：

- `lib/sealed-export/vectors/s6a-package-provenance-pins.json` 共 **66** 个 pin 键，无 `transform` / `pipeline-runner` / `test-chain.txt` 相关键。
- `lib/sealed-export/sealed-export-package-provenance.cjs:223-231` 的注释明确写着 `test-chain.txt` 故意不 pin（pin 的是 `scripts/test-chain.cjs`，本次未改）。
- `node __tests__/sealed-export-package-provenance.test.cjs` → `OK`（exit 0）。

### type-check

- 本次改动**没有 TS 文件**，也没有 `.ts` / `.vue` 引用 `transform-engine`（全仓 grep 为空）。
- `plugins/plugin-integration-core/package.json` **没有** `type-check` 也没有 `lint` 脚本，所以 `pnpm -r type-check`（根 `package.json` 的定义）本来就跳过这个包。
- 实际做的是 `node --check` 三个改动/新增文件，全部通过。
- **没跑**：仓库级 `pnpm -r type-check` 与 `pnpm -r lint`。原因：无 TS 改动 + 磁盘只剩约 1.8 GB、禁止 `pnpm install`。这一项以 CI 为准。

## 5. 我没跑 / 没做的事

1. `pnpm -r type-check`、`pnpm -r lint`（理由同上）。
2. `apps/web` 的任何测试：本刀没有改前端，也刻意没碰 `errorCodeLabels.ts`。
3. 真实数据库 / 222 上机验证：没做，全部是进程内假件。
4. `external-write-dry-run` 的 dry-run 报告口径：没有把 `SOURCE_FIELD_ABSENT` 加进它的 `counts` / `rowErrorTypes`（后续单）。
5. `preview`（dry-run 的 `{ records, errors }`）没有新增 `warnings` 数组——dry-run 同样会走 `finishRun`，所以 `details.sourceFieldAbsent` 对 dry-run 也成立，就没有再动 preview 的形状。这一点没有被新套件覆盖到 dry-run 分支，属于缺口。
6. 16 条本机红的套件本身没有修（环境缺件，且禁止安装）。
