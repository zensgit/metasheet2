# T3b 设计锁 — approved PLM source-run 服务端直落 project / snapshot / run

**状态：RATIFY-ready — design-lock only，owner ratification pending，authorizes no runtime。**

日期：2026-07-16
前置：T3a runtime #4357 已合；T4 非空 `prep-line` smoke #4266 已合；RC-0
corrective-4（#4369）已合并、已切 exact-SHA 包，正在 #4101 等实体机回贴。owner 已同意起草本锁，但 **ratify 与 runtime
实现仍是后续独立门**。

## 0. 目的与当前断点

现有 PLM source-run 已能执行 approved readonly config：

1. `stockPreparationPlmBomSourceRun` 调用 `runPlmBomReadonlySource`；
2. source-run 在服务端产出值面 `result.intake`；
3. `result.intake` 的真实 BOM 字段名是 **`bomSnapshotLines`**，另含
   `projects`、`bomSnapshotBatches` 与 `runRecord`；
4. HTTP 必须经 `publicReadonlySourceRunResult`，因此值面行不会跨 HTTP；
5. 独立 `/mvp/sync/persist` 路由要求调用方重新提交 `expansionResult`。

所以“approved PLM read → internal snapshot commit”目前无法由产品调用方闭环：调用方
拿不到被正确剥离的服务端行，也不应拿到后再重交。

> **基线纠正：**早期 T3a §7 写成 `intake.plmBomLines`，这是输入字段名，不是
> source-run outcome 的字段名。T3b 只能消费真实的 `intake.bomSnapshotLines`，不得按
> 旧措辞造一个不存在的字段。

## 1. 已核实的代码契约

| 接缝 | 当前真实契约 | T3b 约束 |
|---|---|---|
| PLM route | `POST /api/integration/stock-preparation/mvp/source-runs/plm-bom`，admin gate | 不新增端点 |
| source result | `runPlmBomReadonlySource` 返回内部 `intake`；公开 projector 剥离它 | 值面只在同一请求内流动 |
| intake | `projects[1]`、`bomSnapshotBatches[1]`、非空 `bomSnapshotLines`、`runRecord` | 结构不满足则整次 fail-closed |
| persist | `persistStockPreparationSyncRun` 重算 plan，再写 project / batch / line / run | 复用唯一写入口，不另造 writer |
| physical target | 4 张表均在 `<auth-tenant>:integration-core` 下，经 target-scoped records API 写入 | request 不得选择 sheet/base/target project |
| business scope | `projectId` 是行内业务项目键，不是物理写目标 | body 中允许且必填；不得误当 tenant steering |
| idempotency | 当前只要 `snapshotBatchId` 已存在就整批 `skipped_existing`；未核对 lines/run 完整性或内容身份 | T3b 必须先补 false-skip 检测，见 OD-4 |
| T4 | #4266 已证明 synthetic body 的 cache → match → generation → audit 真链 | T3b 只补 approved source → persist 前段，最终扩展 T4，不重建 T4 |

## 2. 范围

### 2.1 本级要做

在 **同一个 PLM source-run 请求**中：

1. 执行现有 approved readonly source；
2. 保留现有公开 values-free projection；
3. flag ON 时，把服务端 `intake` 经一个纯、闭形状 bridge 转成现有
   `persistStockPreparationSyncRun` 的 plan input；
4. 由现有 persist 写内部 project / snapshot batch / snapshot lines / run；
5. 返回 source evidence + values-free `autoPersist` evidence。

### 2.2 明确不做

- 不新增 PLM/K3/ERP 外部写；`externalWrite=false` 恒定；
- 不调用 K3 Save / Submit / Audit，不引入 apply-writer；
- 不开放 OD-W3-1 值面读，不把 BOM 行放进 HTTP response / log / audit；
- 不新增 raw SQL、sheetId/baseId/fieldId 请求参数；
- 不改变 approved source config、credential、host allowlist 或 connector 契约；
- 不把 T3b 折进 T3a flag，也不复用 ERP cache 的 `autoPersist` flag；
- 不声称解决现有 persist 的跨表原子性；生产启用门见 OD-4。

## 3. 目标结构

```text
POST .../source-runs/plm-bom
  require admin
  autoPersistEnabled = MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED
  if ON: reject scope steering before body normalization / any I/O
  normalize approved-source request
  tenant = ON ? authenticated principal : existing readonly resolution
  sourceResult = runPlmBomReadonlySource(...)
  publicResult = publicReadonlySourceRunResult(sourceResult)

  if OFF:
    return 200 publicResult                         # byte-for-byte existing behavior

  persistInput = buildPlmSourcePersistInput({
    request: normalized request,
    intake: sourceResult.intake,
  })                                               # pure, closed projection, no I/O

  autoPersist = persistStockPreparationSyncRun({
    ...persistInput,
    targetProjectId: derive from auth tenant,
    permission: 'admin',
    existing scoped records/provisioning APIs,
  })

  return 201|200 {
    ...publicResult,
    mode: autoPersist.persisted ? 'internal_persist' : 'internal_noop',
    evidence: {
      ...publicResult.evidence,
      internalWriteExecuted: autoPersist.persisted,
    },
    autoPersist,                                   # values-free only
  }
```

## 4. 提议裁决（ratify 时整体确认）

### OD-1 — 独立、默认关闭的 flag

**建议：GO。**唯一 flag：

`MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED`

- 仅 `String(value).trim().toLowerCase() === 'true'` 开启；
- 默认 OFF；OFF 时 route 响应、tenant 解析与 I/O 次数保持现状；
- flag 只控制 PLM source-run 的内部持久化，不控制 T3a ERP cache；
- 仅 bridge + route wiring 片可凭默认 OFF 保持新路径 inert；OD-4 的共享 persist hardening
  会无条件收紧现有 `/mvp/sync/persist` 重放语义，不受本 flag 保护，必须独立审阅与验证；
- 部署不得隐式打开本 flag。

### OD-2 — tenant、workspace 与 business project 的边界

**建议：GO，采用分层语义。**

flag ON 时：

1. tenant 只用 `resolveAuthUserTenantId(req)`；
2. staging target 只用
   `resolveIntegrationStagingProjectId(authTenant, undefined)`；
3. body/query/params 任一显式非空 `tenantId` 在 normalization 和任何 source/provisioning
   I/O 前以专用 coarse code 拒绝；
4. query/params 中的 `projectId` 同样拒绝，避免多载体歧义；
5. **body `projectId` 保留且必填**：它是写入行的业务项目键，不参与 tenant 或 sheet
   派生；
6. `workspaceId` 只允许作为认证租户内 approved config selector；它不得进入 target
   project 派生；
7. 继续依赖 `assertRowsStayInProjectScope` 逐行核对 `sourceProjectNo`，不得只查 header。

因此本锁不复制 T3a 的“拒绝所有 body projectId”：两条路的业务语义不同。T3a 是租户级
ERP cache；T3b 必须有一个业务 project handle。

### OD-3 — `intake` → persist 的唯一纯 bridge

**建议：GO，但禁止直接 cast / spread。**新增一个纯 helper（命名可在实现时微调）：

`buildPlmSourcePersistInput({ request, intake })`

它必须：

- 要求恰好一个 project、一个 snapshot batch、至少一条 snapshot line；
- 交叉核对 request / intake 的 `projectId`、`sourceProjectNo`、`syncRunId`、
  `snapshotBatchId`、`snapshotVersion`；任一不一致整次拒绝；
- 逐行要求 `projectId` 与唯一 project 一致、`snapshotBatchId` 与唯一 batch 一致；禁止
  mixed-project / mixed-batch envelope；
- 对每行只投影现有 expansion mapper 接受的闭集合；未知字段不转发；
- **不丢行**：输入行数必须等于 bridge 输出行数；任一行不合法则整个 envelope
  fail-closed，不得 `.filter()` 后部分写；
- bridge 输入词表固定为 `imported` / `active` / `inactive` / `incomplete`：`imported`
  始终归一为 `active`，其余三个 canonical 值保持。intake 已把“缺省生成 imported”和
  “source 实际映射出 imported”折叠成同一值，bridge 无法也不应伪造 provenance 区分；
- **T3b v1 选择 source lifecycle 处置 (c)**：不内建 `released` / `obsolete` / `WIP`
  等跨 PLM 猜测映射。approved config 不得把原始 lifecycle 列直接映射为 `status` 或
  `lineStatus`；只有上游已产出上述 bridge 输入词表时才允许映射；
- source-mapped `status` / `lineStatus` 出现上述 bridge 输入词表外的任何值时，整个 envelope
  必须在 provisioning / persist I/O 前以 422
  `STOCK_PREPARATION_PLM_AUTOPERSIST_LINE_STATUS_UNSUPPORTED` 拒绝；不得丢行、不得静默改成
  `active`。错误 details 只允许稳定字段名、accepted input set、canonical output set 与
  unsupported row count，
  不得包含原始 lifecycle 值或业务行内容；
- 复用 intake 已生成的 `snapshotLineId` / `sourceFingerprint`，不得二次发明身份；
- 产出 `persistStockPreparationSyncRun` 的真实字段：`projectId`、`sourceProjectNo`、
  `projectName`、`sourceSystem`、`syncRunId`、`snapshotBatchId`、`snapshotVersion`、
  `expansionResult`；不产出 tenant/workspace/targetProjectId。

本约束刻意不把 `intake.bomSnapshotLines` 直接断言成 `expansionResult`。现有 persist 会再跑
expansion mapper；bridge 必须用判别测试证明该二次规范化不改变行数、id、qty、unit、
path、fingerprint 与 active/inactive/incomplete 语义。这里的状态归一不是偏好：当前
readonly intake 在源行未给状态时默认写 `imported`，有值时则原样优先读取
`lineStatus` / `status`。approved `fieldMap.target` 只受 bounded-identifier 形状约束，没有
status-target 语义 allowlist。与此同时，T4 / RC 验收使用的
`stock_preparation_bom_line_status_v1` 是管理员提供的运行时 option-source，并不提供编译期
closed-vocabulary enforcement。T3b v1 的唯一 enforcement point 是 bridge 中的 canonical
closed set；实现与验收不得依赖 config shape validation 或 records service select validation
替它拒绝原始 lifecycle 值。

因此 operator contract 明确为：若 approved source 的 lifecycle 值不是 bridge 可接受的
`imported` / `active` / `inactive` / `incomplete`，不要把该列 target 配成 `status` / `lineStatus`。需要支持
某个 PLM 的 `released` / `obsolete` / `WIP` 语义时，必须先另开具名 mapping design gate；本锁
不授权隐式映射。

### OD-4 — idempotency、不可变性与已知原子性边界

**建议：分两级。**

T3b v1 复用现有 persist 的 create-only 写路径，但 **不得原样继承“batch 命中即成功
skip”**。在第一次写或返回 `skipped_existing` 前，persist 必须完成以下闭形状核对：

- 当前 plan 的 `snapshotBatchId`、`snapshotLineId`、`runId` 各自必须唯一；重复 line key
  在任何 records/provisioning I/O 前以 422 `PERSIST_PLAN_LINE_KEY_AMBIGUOUS` 拒绝，
  不得把 duplicate path 产生的同 key 行交给底座；
- 首次 batch：201，create batch/lines/run，再按既有 contract upsert project；首次写前
  project key 查询只允许 0 或 1 行，2+ 行以 values-free conflict 拒绝，不得先种 batch；
- 已有 batch 查询只允许恰好 1 行，2+ 行为 409 `PERSIST_IDEMPOTENCY_CONFLICT`；对应
  run row 同样必须恰好 1 行；
- snapshot lines 必须按 `snapshotBatchId` 做**有界分页全量读取**，直到 short page；达到页界
  仍无法证明完整时以 409 `PERSIST_EXISTING_BATCH_READ_UNPROVABLE` 拒绝，不得只比较首屏；
- batch、run 与每条 line 都按冻结 template 的**完整持久化投影**规范化后比较：只取各自
  `*_FIELD_IDS`，忽略 records 元数据 `id/version`，按 template type 规范 string/select/number，
  丢弃 create path 同样不写的 null/undefined；line 以唯一 `snapshotLineId` 建图后逐字段比较，
  行数、key 集合和每个字段都必须一致；
- `sourceFingerprint` 只是完整 line 投影中的一个字段，**不得**用
  `snapshotLineId + sourceFingerprint` 集合替代完整内容判等。桥接归一逻辑变化时，原始
  fingerprint 可能不变而 `lineStatus` 等持久化值已变化；这种重放必须 409，而不是 false skip；
- exact replay 还必须按当前 plan 的业务 `projectId` 查到恰好 1 条 project row：0 条说明
  首次 commit 可能在 project upsert 前中断，属于 incomplete；2+ 条属于 conflict。project 是
  live pointer，不要求 `lastSyncRunId` 等于被 replay 的旧 run，也不在 replay 时 patch；
- 只有 batch/lines/run 三个完整投影相同且 project 存在且唯一，exact replay 才返回 200
  `skipped_existing`；
- batch 存在但 lines/run 缺失 ⇒ 409 `PERSIST_EXISTING_BATCH_INCOMPLETE`；同 ID 不同
  identity/content、重复既有 key ⇒ 409 `PERSIST_IDEMPOTENCY_CONFLICT`；所有错误均
  values-free、均不修补；
- 快照 batch/line/run 不 patch；project live pointer 只在首次成功 commit 后按既有 contract
  upsert；不删除旧 snapshot，不做“最新覆盖”。

这是一项 T3b 前置的共享 persist hardening：它只把既有 false-success 改成显式冲突，不
新增写面。判等只在服务端读闭形状字段，不把 line id/fingerprint/业务值放进 response、
error details、log 或 audit。

当前 main 的 persist 是 batch-first 的多表顺序写；若进程在 batch 后、lines/run 前退出，
当前实现会因 batch 已存在而 false skip。上述 hardening 落地后，retry 必须改为 409
`PERSIST_EXISTING_BATCH_INCOMPLETE`，但孤儿 batch 仍会保留且不会自动修复。T3b 设计不得
把这一行为写成“原子”或“可自动修复”。裁决：

- route wiring 可在 default-OFF 下 inert 合并；共享 persist hardening **不是 inert**：它会让
  现有 `/mvp/sync/persist` 的 orphan/conflict replay 从 200 false skip 变为 409，必须作为
  独立 PR 对现有 route 做兼容回归、真库证据与 owner review 后再合；
- RC-A 可在隔离实体机窗口临时 ON 做一次受控验收；
- **生产常开保持 barred**，直到独立 P4 完成事务 / 两阶段状态 / repair protocol
  之一并有 crash-injection 证据，或 owner 另行书面接受该有界风险；
- T3b 测试至少证明 mid-failure 返回 coarse failure；retry 对孤儿 batch 明确 409 而非
  false skip；全程无外部写，且不把 partial counts / identity values 暴露到公开面；不
  虚称已解决或自动修复孤儿 batch。

### OD-5 — 响应与失败语义

**建议：与 T3a 保持同一公开阶梯。**

- OFF：现有 `publicReadonlySourceRunResult` 逐字节不变，无 `autoPersist`；
- source empty / required shape missing：沿用 422，persist 零调用；
- bridge invalid：422 coarse code，persist 零调用；
- 首次 created：201，覆盖 `mode:'internal_persist'`、
  `evidence.internalWriteExecuted:true`；
- exact replay `skipped_existing`：200，必须是 `mode:'internal_noop'`、
  `evidence.internalWriteExecuted:false`，不得因 flag ON 就谎报发生写入；
- 两条成功路径都附现有 values-free persist result；
- persist failure：返回现有 coarse error，不返回 intake、raw row、业务值或 partial
  counters；
- `externalWriteExecuted`、`productionWrite`、`k3SaveSubmitAudit`、`plmExternalWrite`
  保持 false。

### OD-6 — T4 与 RC-A 的关系

**建议：扩展而非重写。**

#4266 已证明 synthetic plan body 后半链。T3b 落地后只给现有 T4 增加一个
approved-source 前置模式：

1. 临时打开 T3b flag；
2. 调 PLM approved source-run；
3. 证明 project/batch/line/run 非空且 response values-free；
4. 继续复用现有 cache/match/unit/generation/exception/audit 判据；
5. summary 固定 `externalWrite=false`；
6. run 后恢复 flag，禁止把该 flag 常开写入生产模板。

corrective-4 的 #4101 实体机结果与 T3b 开发并行；**RC-A 只在**以下三者齐备后切一次：

- corrective-4 实体机验收结果已回贴并完成 owner 判读；
- T3b runtime + 真库证据已合；
- T4 approved-source 扩展通过。

## 5. 实现与验证门

### 5.1 HTTP / pure contract tests

至少覆盖：

1. flag OFF byte-equivalence + persist 零调用；
2. ON 下 body/query/params tenant steering 在 normalization / source I/O 前拒绝；
3. body `projectId` 正常通过，但 query/params `projectId` 拒绝；
4. auth tenant 决定 staging target，workspace/body project 都不能改 target；
5. bridge 精确一对一，未知行整 envelope 拒绝；
6. `imported → active`（同时覆盖缺省 imported 与 source-mapped imported），canonical
   active/inactive/incomplete 保真；
7. source-mapped raw lifecycle（至少覆盖 released/obsolete/WIP）以专用 422 拒绝，persist /
   provisioning 零调用；错误 details 不含 raw lifecycle；把任一已 canonical 的 source status
   映射进来则正常通过；
8. source/intake identity mismatch 拒绝且零写；
9. 201 created=`internal_persist/true`；exact replay 200
   skipped_existing=`internal_noop/false`；same-id-different-content 与 orphan batch 均 409
   且零后续写；判别测试必须在保持 `snapshotLineId + sourceFingerprint` 不变时分别改变
   `pathKey`、`designQty`、`designUnit`、`lineStatus`，证明完整投影任一字段漂移都会冲突；
10. plan line key 重复、已有 batch/run/line key 重复均 fail-closed；line replay 读取覆盖至少
    两页，并证明达到 page bound 时不会拿部分结果判 exact replay；
11. 首次 commit 前 project key 2+ 行须在 batch create 前拒绝；exact replay 下 project 0 行
    判 incomplete、2+ 行判 conflict、恰好 1 行才允许 skip，且 replay 不 patch project；
12. 成功与错误双向 leak-bait，公开 JSON 不含项目名、项目号、图号、数量、单位、
   fingerprint 原值、config/system id、credential；
13. 所有 bridge/steering/plan 拒绝路径 records/provisioning/persist 调用计数为 0；已有数据
    冲突路径只允许完成证明冲突所需的 scoped reads，写调用计数必须为 0。

### 5.2 真 PostgreSQL / real service smoke

新测试必须显式加入 required `plugin-tests.yml` 白名单，避免 skip-green：

- 用真实 provisioning 建冻结表，fieldId 从 `meta_fields` 交叉核对；
- 走真实 route + approved-source adapter facade，不直接调用 helper 冒充路由；
- ON：project/batch/line/run 物理行落地，行数与 intake 相等；
- replay：行数不增；
- OFF：四表零新增且公开响应与旧路径一致；
- bridge invalid / source empty：零写；
- target 只在认证租户 staging；
- response / artifacts values-free；
- 无任何外部写模块调用。

### 5.3 必杀 mutation

- 去掉 flag gate；
- 用 `resolveTenantId(req,input)` 替换 auth-principal tenant；
- 允许 request tenant 改 staging target；
- 把 bridge 改为逐行 drop；
- 去掉 identity cross-check；
- 把 `imported` 原样写入 select contract；
- 放行任意 source-mapped lifecycle，或把 unsupported lifecycle 静默改成 `active`；
- 把 unsupported lifecycle 的原始值放进 error details；
- 把 existing-batch completeness/content conflict 恢复成无条件 skip；
- 把完整 line 投影判等退化成 `snapshotLineId + sourceFingerprint` 判等；
- 只读取 existing lines 第一页，或把 page-bound 当成完整结果；
- 允许重复 plan/existing key 取第一行继续；
- existing batch 完整但 project row 缺失时仍返回 successful skip；
- 断开 persist 调用；
- created 不覆盖 dry-run / internalWrite evidence，或 replay 仍硬报 internal write；
- 把业务行或 config/system id 注入 response；
- 从 `plugin-tests.yml` 移除真库测试。

每个 mutation 必须先证明修改实际落地，再证明对应测试变红，最后恢复并重跑。

## 6. 交付阶梯

| 级 | 交付 | 门 |
|---|---|---|
| T3b-0 | 本 design-lock | 本 PR 仅 RATIFY-ready；owner ratify 前不授权 runtime |
| T3b-1a | shared persist false-skip hardening + existing `/mvp/sync/persist` 回归 | owner RATIFY 后；非 flag-inert，独立 PR |
| T3b-1b | pure bridge + focused contract tests | owner RATIFY 后；可与 1a 并行，零 I/O |
| T3b-1c | source-run route flag/guard + 1a/1b integration | 1a + 1b 通过；default-OFF inert |
| T3b-2 | real-DB route smoke + CI whitelist + 对抗审阅 | T3b-1c 通过 |
| T4-final | 现有 #4266 approved-source 扩展 | T3b-2 合入 |
| RC-A | 单次 exact-SHA 包 + 实体机验收 | #4101 corrective-4 判定 + T4-final |
| P4 | persist 原子性 / repair hardening | 独立设计门；生产常开前置 |

## 7. Ratify checklist

owner ratify 本锁即表示同意：

- [ ] OD-1：独立 default-OFF PLM auto-persist flag；
- [ ] OD-2：auth tenant 决定物理 target，body projectId 仅作业务键；
- [ ] OD-3：纯 bridge，一行不丢；bridge 输入 `imported → active`，canonical
  active/inactive/incomplete 保真；其它 raw lifecycle mapping 在 v1 明确 out-of-scope，并以专用
  values-free 422 在 persist 前 fail-closed；bridge 是唯一 option enforcement point；
- [ ] OD-4：exact replay 才可 skip，orphan/content conflict 必须 409；生产常开 barred on P4；
- [ ] 交付拆分：共享 persist hardening 非 flag-inert，独立审阅；pure bridge 可并行；route
  wiring 等两者通过后再接；
- [ ] OD-5：OFF byte-equivalent；ON created=`internal_persist/true`、replay=`internal_noop/false`；
- [ ] OD-6：扩展现有 T4 后只切一次 RC-A；
- [ ] 本锁不授权外部写、OD-W3-1 值面读或 runtime 自行合并。
