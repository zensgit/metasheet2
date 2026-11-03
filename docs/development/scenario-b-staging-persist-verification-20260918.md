# 场景 B · 落 staging（W7-A2）验证记录

2026-09-18。设计见 `scenario-b-staging-persist-design-20260918.md`。
分支 `feat/scenario-b-staging-persist`，基线 A1 `b36d23491`。

## 1. 套件与命令

```
plugins/plugin-integration-core/__tests__/scenario-b-staging-persist.test.cjs
$ node __tests__/scenario-b-staging-persist.test.cjs
```

`test-chain.txt` 只加了一行（末行 `node __tests__/scenario-b-staging-persist.test.cjs`），
`package.json` 未动，`http-routes.cjs` 等 pin 文件未动（`git status` 只有 test-chain.txt 一处修改
外加两份新文档与一个新测试文件）。

## 2. 实跑输出（原样）

```
scenario-b-staging-persist
  testFiftyFourLinesLandInStaging OK
  testGuard1TenantSteeringRejected OK
  testGuard1MutationTurnsRed OK
  testGuard2ConfigShapeRejected OK
  testGuard2MutationTurnsRed OK
  testGuard3ValuePlaneTenantProof OK
  testGuard3MutationTurnsRed OK
  testIdempotentReplayCreatesNoDuplicateRows OK
  testChangedRowRerunIsImmutableAndFailsClosed OK
  testFlagDefaultOffStaysReadOnly OK
scenario-b-staging-persist: all OK
```

邻近既有套件回归（未受影响，原样输出末行）：

```
$ node __tests__/scenario-b-synthetic-bom-source-run.test.cjs
scenario-b synthetic BOM source-run tests: PASS
$ node __tests__/stock-preparation-plm-source-persist-bridge.test.cjs
all stock-preparation-plm-source-persist-bridge tests passed
$ node __tests__/stock-preparation-sync-run-persist.test.cjs
stock-preparation-sync-run-persist.test.cjs: 57 passed, 0 failed
$ node __tests__/http-routes.test.cjs
http-routes: REST auth/list/upsert/run/dry-run/staging/replay tests passed
```

## 3. 「去掉守卫测试就红」——变异探针（原样）

探针在 scratchpad（不落仓库），做法是把三道守卫逐个从 **http-routes 的内存编译体**里拿掉，
再把**同一批守卫断言**对着变异体重跑。对照组先证明这三个断言在未变异的真模块上是绿的 ——
否则「变红」什么也证明不了。磁盘上的 `http-routes.cjs` 一个字节都没改。

```
  testGuard1TenantSteeringRejected OK
CONTROL  GREEN  守卫① 租户转向（接线 http-routes.cjs:7248）
  testGuard2ConfigShapeRejected OK
CONTROL  GREEN  守卫② 配置结构（接线 http-routes.cjs:7268）
  testGuard3ValuePlaneTenantProof OK
CONTROL  GREEN  守卫③ 值面租户证明（http-routes.cjs:1226）
MUTANT   RED    守卫① 租户转向（接线 http-routes.cjs:7248）
         body.tenantId: 转向被拒
MUTANT   RED    守卫② 配置结构（接线 http-routes.cjs:7268）
         Expected values to be strictly equal:
MUTANT   RED    守卫③ 值面租户证明（http-routes.cjs:1226）
         Expected values to be strictly equal:

变异转红 3/3
```

套件内部另有三条常驻的同源断言（`testGuard*MutationTurnsRed`），它们不只断言「不再拒」，还断言
**绕过真的发生了**：守卫② 的变异体确实读了源（不是换个理由拒）；守卫③ 的变异体确实把行写进了
`tenant_evil:integration-core`（请求头填出来的租户决定了物理落点 —— x-tenant-id 请求头洞的形状）。

三个变异锚点都带 `assert.equal(occurrences, 1)` 唯一性自检：锚点漂移会让探针自己先红，
不会变成一个恒真的假探针。

## 4. 守卫逐条实证

| 守卫 | 正例 | 反例 | I/O 位置证据 |
| --- | --- | --- | --- |
| ① 转向（`:1389` / 接线 `:7248`） | 干净请求 201 | 5 个载体全 400 `STOCK_PREPARATION_PLM_AUTOPERSIST_STEERING_NOT_ALLOWED` | 适配器未创建、源未读、records/provisioning 计数 0 |
| ② 配置结构（bridge `:190` / 接线 `:7268`） | A1 原始 fieldMap 201 | `level_no→missingChildBom` + `uom→lineStatus` 422 `..._CONFIG_TARGET_FORBIDDEN`；响应点名 target、不含源列名 | 同上全 0；flag OFF 时同配置仍 200 只读 |
| ③ 值面租户证明（`:1226`，由 `:1095` 调用） | 声明与 `user.tenantId` 一致 → 201，落点 = 该租户 staging | 无声明 token → 403 `OPERATOR_SCOPE_TENANT_REQUIRED`；矛盾 → 403 `OPERATOR_SCOPE_TENANT_CONTRADICTED` | 两者 records/provisioning 计数 0 |

## 5. 幂等两条结果

1. **同一批次重跑**：源重读一次；HTTP 200 / `mode:'internal_noop'` /
   `autoPersist.mode:'skipped_existing'` / `created.lines:0`；写侧新建计数不变（仍是
   `1 batch + 54 lines + 1 run + 1 project = 57`）；快照行仍是 54 行；54 个 `snapshotLineId` 互不相同。
2. **改一行源数据重跑**：
   - 同批次 ID → **409 失败关闭** `PERSIST_IDEMPOTENCY_CONFLICT {target:'snapshot_line',
     reason:'content_mismatch'}`；既有 54 行 `JSON.stringify` 逐字节不变；零新建、零 patch。
   - 新批次 ID + version 2 → 201，独立落 54 行（总 108）；旧批次逐字节不变；新旧按 `pathKey` 比对
     **只有 1 行** `designQty` 不同（且 `sourceFingerprint` 随之改变）；项目行仍 1 行，
     `lastSyncRunId` patch 到 `scenario_b_run_2`（`project.mode:'patched'`）。

   任务书写的是「只更新该行」；实跑结论是这条路径**不可变、从不 patch 快照行**，所以「只更新该行」
   的正确形状是新批次差异化，而不是原地改。这条写进设计文档 §5，供 A3/owner 对齐预期。

## 6. 账本形状

- 四张 MVP 表（batch / line / run / project），落在 `<tenantId>:integration-core`；
  工作单元调用 1 次、`tenantId` = 认证租户、`sheetIds` 四张齐全。
- run 账本行只写模板字段（断言 `Object.keys(runRow)` 无模板外的键）；批次行 `syncRunId` 指回本次 run。
- **死信：这条路径不写。** `deadLetterStore` 在本套件里是「碰一下就抛」的桩，全程零调用。

## 7. 值面（values-free）

响应逐项断言不含合成哨兵 `SYN-ASM-ROOT` / `SYN-PRJ-B1` / 项目名 / `SYN-SUB-01` / `SYN-PRT-01-01`，
并带**正例自检**：同一次 `JSON.stringify` 扫描先在内部写侧扫到 `SYN-ASM-ROOT`（证明扫描有效），
再证明它在 HTTP 响应里扫不到。零命中不自证。

## 8. 字节与卫生

- `__tests__/scenario-b-staging-persist.test.cjs`：0x08 计数 **0**，CR 计数 **0**（纯 LF）。
- `test-chain.txt`：0x08 计数 **0**，CR 计数 **0**，共 262 行。
- 变异探针内存级（`Module._compile`），不落盘、不改文件，并发反驳者不会互撞。
- 环境变量 `MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED` /
  `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED` 只在测试进程内临时置位，`finally` 逐字还原。

## 9. 未做 / 不确定

- 未连真 PG；落库侧是内存 records/provisioning 替身。真库形状由既有
  `packages/core-backend/tests/integration/stock-preparation-t3b-plm-autopersist-realdb.test.ts` 覆盖，
  本刀未新增 `DATABASE_URL`-gated 用例。
- 未开生产 flag、未上 222、未动前端、未做页面验收、未读真实 PLM/K3。
- A1 的「悄悄钳制盲区」按裁决**不在本刀消**。落库侧不改变它的性质：一个悄悄钳制的源会让 staging
  落下一个内容自洽但不完整的批次，而批次不可变 —— 只能开新批次修正。A3 之前值得 owner 知道。
