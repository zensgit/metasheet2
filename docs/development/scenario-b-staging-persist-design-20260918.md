# 场景 B · 运行结果落备料 staging（W7-A2）设计

2026-09-18。对应 SC-01 owner 裁决的第二刀，叠在 A1（`feat/scenario-b-synthetic-bom-source`，
head `b36d23491`）之上。

## 1. 裁决原文

> 首个增量做 B：本机合成 BOM → 既有受控源运行 → 备料 staging → 页面验收。可先用合成字段，不等
> 客户真实字典；不启动 C 的环境/分页工作，不读真实 PLM/K3，不启用生产 autopersist。

A1 做了前两段（夹具 + 只读跑通）。A2 做第三段：把 A1 的 54 行结果**落进备料 staging**，并实证
写侧守卫与幂等。A3（页面验收）另派。

## 2. 为什么 flag 只在测试里开

`MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED` 的生产语义一个字没动：

- 没有改任何默认值、模板、部署清单、文档默认值；仓库里它依旧是「不设 = OFF」。
- 唯一把它置为 `'true'` 的地方是新测试套件里的 `withAutoPersist('true', …)`，作用域是一次
  `Promise`，`finally` 里逐字还原（连「原来就没设」这个状态也还原成 `delete`）。
- 套件还**正向钉住了 OFF 的形状**（`testFlagDefaultOffStaysReadOnly`）：不设时响应是只读投影、
  没有 `autoPersist` 字段、写侧 I/O 计数为 0；`'false' / '1' / 'yes' / ''` 一律不开 —— 只有精确的
  `'true'`（trim + 小写）才开。这条是「我们没有偷偷把生产打开」的可证伪证据，不是散文。

owner 裁决说的是「不启用**生产** autopersist」。本刀在开发期 flag ON 路径上落库，正是为了让 A3
的页面验收有真行可看，同时把写侧守卫在**真正会写的那条路径上**实证一遍。

## 3. 落库走的函数（本刀**没碰** `http-routes.cjs`）

任务书允许「若落库入口只在 http-routes 的分支里，就从它调用的下层函数直接驱动」。实读结论是
**不必绕**：`http-routes.cjs` 导出了 `createHandlers`（`lib/http-routes.cjs:9996` 的 `module.exports`），
测试直接拿 handler 对象调 `stockPreparationPlmBomSourceRun(req, res)` 就能驱动真 autopersist 分支。
**这是调用，不是修改** —— pin 文件一个字节没改（`git status` 只有 test-chain.txt 和新测试文件）。
所以本刀**不存在**「HTTP 层未接线」这个缺口，A3 拿到的是已接线的真路径。

链路（file:line 以本分支实读为准）：

```
handlers.stockPreparationPlmBomSourceRun            lib/http-routes.cjs:7241
  ├─ requireAccess(req,'admin')                     :7242   （:930 定义）
  ├─ 守卫①  assertStockPreparationPlmAutoPersistNoSteering(req)   :7248（:1389 定义）
  ├─ tenantId = resolveAuthUserTenantId(req)        :7256   （:1085 定义）
  │     └─ 守卫③  assertVerifiedTenantClaim(req, tenantId)        :1095 →（:1226 定义）
  ├─ loadStockPreparationReadonlySource(...)        :7257   （:4197 定义，读已批准配置）
  ├─ 守卫②  assertPlmAutoPersistSourceConfigSafe(sourceRuntime.config)  :7268
  │           （lib/stock-preparation-plm-source-persist-bridge.cjs:190 定义）
  ├─ runPlmBomReadonlySource(...)                   :7270   （A1 那条读取链，原样复用）
  ├─ targetProjectId = resolveIntegrationStagingProjectId(tenantId, undefined)  :7290（:1290 定义）
  ├─ persistInput = buildPlmSourcePersistInput({request, intake: result.intake}) :7291
  │           （lib/stock-preparation-plm-source-persist-bridge.cjs:122）
  └─ persistStockPreparationSyncRun({... lockTenantId: tenantId, targetProjectId})  :7301
              （lib/stock-preparation-sync-run-persist.cjs:625）
```

**目标落点**是认证租户的 staging 项目 `<tenantId>:integration-core`，body 的 `projectId` 只作为
业务键骑在批次/项目行上，永远不选物理目标。

## 4. 三道守卫：各自在哪、正反例、变异

| # | 守卫 | 定义 / 接线 | 正例 | 反例 | 变异（内存级） |
| --- | --- | --- | --- | --- | --- |
| ① | 租户转向拒绝 | `http-routes.cjs:1389` / 接线 `:7248` | 干净请求 201 | 5 个载体（body/query/params 的 `tenantId`、query/params 的 `projectId`）全部 400 `STOCK_PREPARATION_PLM_AUTOPERSIST_STEERING_NOT_ALLOWED`，且适配器未创建、源未读、records/provisioning 零 I/O | 删掉 `:7248` 那一行接线 → 5 个载体全部不再被专用码拒 |
| ② | 配置结构守卫 | `stock-preparation-plm-source-persist-bridge.cjs:190` / 接线 `http-routes.cjs:7268` | A1 原始 `fieldMap` 放行 201 | 合成表上的组合映射（`level_no→missingChildBom` + `uom→lineStatus`）422 `..._CONFIG_TARGET_FORBIDDEN`，零 I/O；且 flag OFF 时同一配置仍是只读 200（守卫不是对只读面的新限制） | 删掉 `:7268` 接线 → 不再拒，且变异体**真的读了源**（绕过是真的，不是换个理由拒） |
| ③ | 值面租户证明 | `http-routes.cjs:1226` / 由 `:1095` 在写侧租户解析时调用 | token 真带租户声明且与 `user.tenantId` 一致 → 201，落点 = 该租户 staging | 无声明 token（`user.tenantId` 由 `x-tenant-id` 请求头填）→ 403 `OPERATOR_SCOPE_TENANT_REQUIRED`；携带租户与声明矛盾 → 403 `OPERATOR_SCOPE_TENANT_CONTRADICTED`；两者零 I/O | 把 `assertVerifiedTenantClaim` 改成立即 `return` → 无声明 token 写进去了，且**请求头填出来的租户决定了物理落点**（`tenant_evil:integration-core`）—— 这正是 x-tenant-id 请求头洞的形状 |

守卫③ 受 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED` 控制，测试同样只在进程内临时置位并还原。

变异探针实现：`readMutatedModule()` 读源码 → **断言锚点唯一命中一次**（否则探针自己是假的）→
替换 → `Module._compile` 编出独立模块。磁盘文件零改动，并发反驳者不会互撞。

## 5. 幂等键与两条实测

- **批次幂等键** = `snapshotBatchId`（`stock-preparation-sync-run-persist.cjs:83`，来自冻结模板
  `BATCH_TEMPLATE.keyFields[0]`）。
- **行级幂等键** = `snapshotLineId`（同上 `:84`，`LINE_TEMPLATE.keyFields[0]`），由 intake 从
  `pathKey` 派生 —— 54 行的键互不相同，这是「重跑不重复」在键面上的来源，不是靠落点去重。

两条结果：

1. **同一批次重跑**：源又读了一遍，落库侧 200 `internal_noop` / `skipped_existing`，
   `created.lines = 0`，写侧零新建，行数仍是 54。
2. **改一行源数据重跑**：**与任务书「只更新该行」的措辞不同，按实跑写** —— 这条路径是**不可变**的，
   它从不 patch 快照行。同一个 `snapshotBatchId` 下内容变了 → 409 `PERSIST_IDEMPOTENCY_CONFLICT`
   `{target:'snapshot_line', reason:'content_mismatch'}`，既有行逐字节不变、零新建、零 patch。
   「只更新该行」在这条路径上的**正确形状**是开一个新批次（新 `snapshotBatchId` + 递增
   `snapshotVersion`）：新批次独立落 54 行，旧批次原样不动，新旧逐 `pathKey` 比对**只有被改的那一行**
   `designQty`（及其 `sourceFingerprint`）不同，项目行按 `projectId` 幂等地 patch 活指针到新 run，
   不产生第二行项目。

## 6. 账本形状

这条路径写的是**备料 MVP 的四张内部表**，不是 pipeline run / 死信表（`deadLetterStore` 在本路径上
一次都没被碰过）：

| 角色 | objectId | 键 | 本刀断言 |
| --- | --- | --- | --- |
| 批次 | `plm_stock_preparation_bom_snapshot_batch` | `snapshotBatchId` | 1 行；`projectId` = 业务项目；`syncRunId` 指回本次 run |
| 快照行 | `plm_stock_preparation_bom_snapshot_line` | `snapshotLineId` | 54 行；两层父子 6/48；**无 `projectId` 字段**（通过 `snapshotBatchId` 归属批次） |
| run 账本 | `plm_stock_preparation_run` | `runId` | 每次真落库 +1 行；只写模板里有的字段（`runId,runType,status,startedAt,finishedAt,inputShape,resultShape,createdBy`） |
| 项目 | `plm_stock_preparation_project` | `projectId` | 始终 1 行；活指针 `lastSyncRunId` patch 到最新 run |

四张表在**同一个工作单元**里提交：`runStockPreparationPersistUnitOfWork` 调用一次、
`tenantId` = 认证租户、`sheetIds` 四张齐全。没有死信写入路径。

值面：响应逐项断言 values-free（合成哨兵 `SYN-ASM-ROOT` / `SYN-PRJ-B1` / 项目名 / `SYN-SUB-01` /
`SYN-PRT-01-01` 一个都不过 HTTP），并带**正例自检** —— 先证明同一次扫描能在内部写侧扫到哨兵，
再证明它在响应里扫不到。零命中断言不能自己给自己背书。

## 7. A3 接口（页面验收要什么）

- **staging 表名**：上表四个 `objectId`，都在项目 `<tenantId>:integration-core` 下。页面要展示的
  「备料行」是 `plm_stock_preparation_bom_snapshot_line`，按 `snapshotBatchId` 过滤到一个批次。
- **查询入口**：`lib/stock-preparation-snapshot-reads.cjs`（它的文件头已写明这些表挂在 staging 项目
  而非业务项目）。页面侧现成服务：`apps/web/src/services/integration/stockPreparation/stageOverview.ts`。
- **本刀落下的可验收数据**：`projectId = business_project_scenario_b`、
  `sourceProjectNo = SYN-PRJ-B1`、批次 `scenario_b_batch_1`、run `scenario_b_run_1`、54 行。
  （这是测试内存里的形状；真要在库里看见，得按 A1 的 `fixtures/scenario-b-synthetic-bom/README.md`
  灌库并在开着 flag 的本机实例上打一次这条路由。）
- **值面租户证明**：A3 的读取入口必须走同样的 operator-scope，不能用 `user.tenantId` 路由值面。

## 8. 本刀未做 / 不确定

- 没连真 PG：落库侧用的是内存 records/provisioning 替身。真 PG 的 `DATABASE_URL`-gated 用例**未加**
  （既有 `packages/core-backend/tests/integration/stock-preparation-t3b-plm-autopersist-realdb.test.ts`
  已覆盖同一条 persist 的真库形状，本刀不重复造）。
- 没上 222、没开生产 flag、没动前端、没读真实 PLM/K3、没做页面验收。
- A1 §6 的「悄悄钳制盲区」**本刀不消**（owner 待裁）：它是读侧契约问题，落库侧不改变它的性质 ——
  一个悄悄钳制的源会让 staging 里落下一个**内容自洽但不完整**的批次，而且因为批次不可变，
  后续只能靠开新批次修正。这一点 A3 之前值得 owner 知道。
