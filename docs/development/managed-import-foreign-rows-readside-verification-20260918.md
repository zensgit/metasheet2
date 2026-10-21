# 托管表野行读侧打标 — 验证（GOV-05，2026-09-18）

配对设计件：`managed-import-foreign-rows-readside-design-20260918.md`。基线 `origin/main` @ `62fd24461`。本机 Windows Git Bash，`node --test` CJS；`date` = 2026-09-18 10:46 CST。

## 1. 新套件

`plugins/plugin-integration-core/__tests__/stock-preparation-foreign-existing-rows-readside.test.cjs`（7 件，已加进 `test-chain.txt` suites 段，`package.json` 未动）。

| # | 件 | 盯什么 |
| --- | --- | --- |
| 1 | vocabulary | `EXISTING_MISSING_KEY_CONFLICT_TYPES` 全集 = 两个 token，冻结；保留键是 Symbol |
| 2 | unmapRecordFields | `record.createdBy` 上 Symbol 键；不在 `Object.keys` / JSON / `stableStringify`；展开复制后仍在；NULL → 键缺席；空白不算；`data.createdBy` 单元格伪造不了 |
| 3 | planner split | 1 插件行 + 1 野行 → 两类各 1；2 + 1 不对称批次 → `{2,1}`；`counts` 键集不变；actor 不泄进 plan / evidence |
| 4 | keyed foreign row | 带键的野行仍走 keyed 路径（skip），无 `existingRowsMissingKey` 段 |
| 5 | buildRevision golden A | 无野行批次 revision == 改前 pin `fcfc3b7d…5214` |
| 6 | buildRevision golden B | 同一 plan 下，打标行与未打标行 revision 相等（保留键在哈希外） |
| 7 | end-to-end dry-run | 假 recordsApi 返回一行带 `createdBy` 的记录 → `evidence.plan.existingRowsMissingKey = {1,1}`、`conflictTypes` 含新 token、`counts.add = 1`、`canApply = true`、状态仍 `manual_confirm_required`、actor 不泄出 |

## 2. 红 → 绿

- 改前（仅新测试，lib 未动）：`# pass 0 / # fail 7`。
- 改后：`ℹ pass 7 / ℹ fail 0`。

## 3. buildRevision golden

pin 的取法：在未改动的 `62fd24461` 上，对固定输入（1 行 keyed 既有行 + 1 行无键无 `createdBy` 既有行、1 行 keyed 展开行、`actionId = plm.stock-preparation.pull-bom.v1`）跑 `planStockPreparationConflicts` → `buildRevision`，得 `fcfc3b7dd2702ceb0cd79e54db097457cf1da160ff21b1600ad24c01f0ce5214`。改后同输入相等（件 5）。

含野行的同形输入改前为 `d64cb83b…4fbf`，改后不等——原因是 `summary.conflictTypes` 多了新 token（设计件 §5 最后一行），不是保留键进了哈希（件 6 证明）。**这条按设计件 §5 记为已知、有界的一次性失配，只影响当下已含野行的批次。**

## 4. 变异三条（内存级，`Module.prototype._compile` 钩子改源码文本，不落盘；探针脚本在 scratchpad `wt-gov05/gov05-mutate.cjs`）

| 变异 | 位置 | 结果 |
| --- | --- | --- |
| M1 摘掉 `unmapRecordFields` 的 `createdBy` 透传 | `table-actions.cjs:973` → `if (false)` | 红：件 2、件 7（`pass 5 / fail 2`） |
| M2 把 NULL / 非 NULL 判反 | `conflict-planner.cjs:133` 取反 | 红：件 3（不对称批次 `{2,1}` 变 `{1,2}`）、件 5、件 6（`pass 4 / fail 3`） |
| M3 把保留键放进 `buildRevision` 的 `existingRows` 输入（映成字符串键） | `table-actions.cjs:1439` | 红：件 6（`pass 6 / fail 1`） |
| M4 新 token 改名（词表漂移） | `conflict-planner.cjs:128` | 红：件 1、件 3、件 7（`pass 4 / fail 3`） |

无变异对照：`pass 7 / fail 0`。

## 5. 相邻

改后逐个跑：`stock-preparation-conflict-planner`、`-table-actions`、`-confirmation-decisions`、`-apply-writer`、`-carry-plan-wiring`、`-carry-hardening`、`-pack-aware-refresh`、`-customer-pack-rehearsal`、`-structure-exact-rehearsal`、`-project-subtree-bridge`、`-ext-field-mapping`、`-pack-install-readback`、`-pack-sandbox-target`、`-synthetic-sql-fixture`、`-bom-expansion`、`-carry-policy`、`-conflict-policies`、`test-chain-completeness`、`sealed-export-package-provenance`：**全 OK**。

中途一次红并修正：`existingRowsMissingKey` 最初无条件写进 summary，打红了两个**整 plan** golden（`carry-plan-wiring` 件 (i) 与 `pack-aware-refresh` 控制 digest `10bb6cbb…`）。改为仅在 `existing.missing` 非空时展开后两者恢复绿——这正是仓库既有「spread CONDITIONALLY so legacy evidence stays byte-identical」的约定。

全链 `node scripts/test-chain.cjs`（224 套）：停在 `sealed-export-s3-private-ingestion-migration`；把我的 lib 改动 `git stash` 后同样红（exit 1）。把该点之后的 19 套单独跑完，另 4 套红：`gip-sqlserver-snapshot-paged-read-profile`、`stock-preparation-department-fields-and-write-scoping`（`python3 ENOENT`）、`sealed-export-s4-generation-migration`、`sealed-export-s6a-source-authority-adapter-projection`——四套在 stash 后同样红，属记忆里「只在 Windows 上红、CI 才是裁判」那类。其余全绿。

`grep` 零命中自检：`missing_existing_idempotency_key` 在 `apps/`、`packages/` 代码里零命中，正例 `lib/stock-preparation-conflict-planner.cjs` 命中（三份 docs 命中为历史设计件，不是消费者）。

## 6. 字节与 pin

- `grep -cP '\x08'` 新测试与两份 lib：0 / 0 / 0。
- 三份改动文件与 `test-chain.txt` 工作树无 `\r`（index 为 LF）。
- `sealed-export-package-provenance.test.cjs` OK → `package.json` 与 pins.json 未动，无需重打 pin。
- `http-routes.cjs`、`packages/core-backend/src/`、`.github/` 未动。
