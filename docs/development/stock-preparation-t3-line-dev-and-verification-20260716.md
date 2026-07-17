# 备料对接线 T3 弧收口 — 设计与验证记录（T3a → T3b → corrective-3/4/5）

日期：2026-07-16
范围：数据库/系统对接线（stock-preparation ERP/PLM approved source → 内部 MVP 表自动落库）
本弧不变量：**externalWrite=false 恒定**；无 K3 Save / Submit / Audit；无生产写；公开面 values-free。

> 本文是该线 standing 目标（"审阅剩余开发 → 并行完成 → 交付设计及验证 MD"）的收口交付物。
> 所有 PR 号 / merge SHA / 测试计数均于 2026-07-16 对 `zensgit/metasheet2` 现网核实。

## 1. 交付台账（全部 MERGED 到 main）

| PR | 角色 | merge SHA |
|---|---|---|
| #4263 | T3a 设计锁（ERP source-run 服务端自动落库） | `9e844f7df` |
| #4357 | T3a runtime（并行 Codex 会话实现） | `f49322c75` |
| #4364 | T3b 设计锁（PLM source-run 自动落库，RATIFIED） | `866efd214` |
| #4382 | T3b-1a：共享 persist false-skip / replay 硬化（非 flag-inert，独立过门） | `adeeb7666` |
| #4383 | T3b-1b：纯 intake→persist 桥（零 I/O） | `c6d5d8cf2` |
| #4391 | T3b-1c 前置：结构性 config guard（`fieldMap.target=missingChildBom` 禁映射） | `343b48bba` |
| #4398 | T3b-1c + T3b-2：route 接线（default-OFF）+ 真库 route smoke + CI 白名单 | `6789bcca7` |
| #4402 | T4-final：prep-line smoke 的 approved-source 前置（OD-6 扩展） | `5447fbcd1` |
| #4351 | corrective-3：acceptance runner 的 smoke 捕获 stdout-only 化 + AST 接线守卫 | `9ae9f94ce` |
| #4369 | corrective-4：Windows PowerShell 5.1 下 native stderr promotion 修复 | `56c6d28e6` |
| #4390 | corrective-5：有界 values-free smoke 诊断契约 + x-tenant-id 根因修复 | `3bf7292e1` |

## 2. 设计裁决摘要（两把设计锁的落地形态）

### 2.1 T3a（ERP，#4263 → #4357）
- **OD-1**：独立 default-OFF flag `MULTITABLE_STOCK_PREP_ERP_AUTOPERSIST_ENABLED`（strict-'true'）；OFF 字节等价只读。
- **OD-2**：ON 时 tenant 只取认证主体（`resolveAuthUserTenantId`）；显式 tenantId/projectId（任意载体）在 body allowlist 与一切 I/O 前以专用 code 400 拒绝；`workspaceId` 是同租户 selector，不拒。
- **OD-3/OD-4/OD-5**：空 intake 422 先于 persist；OFF 无 `autoPersist` 字段；ON 覆盖 `mode:'internal_persist'` / `evidence.internalWriteExecuted:true`，201 当且仅当真实落行；T2 persist 为 staged upsert-only 缓存填充，不声称权威全量同步。

### 2.2 T3b（PLM，#4364 → #4382/#4383/#4391/#4398）
- **OD-1**：独立 flag `MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED`，不折进 T3a、不复用 ERP flag；仅 bridge+route 片凭 default-OFF 惰性，1a 的共享 persist 硬化**不受 flag 保护**、独立审阅（已按此拆分为 #4382）。
- **OD-2 分层语义**：tenant 只取认证主体；staging target 只取 `resolveIntegrationStagingProjectId(authTenant, undefined)`；tenantId 全载体拒绝、projectId 仅 query/params 拒绝——**body `projectId` 必填保留**，它是写入行的业务项目键，永不参与 tenant/target 派生（与 T3a 刻意不同：两条路业务语义不同）。
- **OD-3**：`buildPlmSourcePersistInput` 是 intake→persist 的**唯一**投影（禁 cast/spread）；恰一 project/一 batch/≥1 line；身份交叉核对；**一行不丢**（行数守恒，任一行不合法整包 fail-closed）；bridge 输入词表固定 `imported/active/inactive/incomplete`，`imported→active` 归一，词表外值整包 422 `STOCK_PREPARATION_PLM_AUTOPERSIST_LINE_STATUS_UNSUPPORTED`（details 只含稳定字段名/词表/行计数，绝不含原始 lifecycle 值）。
- **OD-3 修正案（owner P2）**：值级 422 抓不住**组合映射绕过**（某列 target 配成内部 marker `missingChildBom` 且同时显式映射 `lineStatus`→marker 被静默丢弃、缺子 BOM 信号端到端消失）。故 route 必须在任何 source read / provisioning / persist I/O 之前对 approved config 调用纯守卫 `assertPlmAutoPersistSourceConfigSafe`；shape 全面 fail-closed（非对象/非数组/空数组/畸形 entry/非字符串 target）；error details 只含 forbidden TARGET 词表、绝不含 source 列名。**采用 Option A**（整包 422），明确否决 `missing_child_bom → incomplete` 的静默归一（Option B 丢信号）。
- **OD-4**：exact replay 才可 200 `skipped_existing`；判等用冻结 template 的**完整持久化投影**（不得退化为 `snapshotLineId+sourceFingerprint`）；orphan batch / 同 ID 异内容一律 409；有界分页全量读取（页界不可证完整 → 409）；**生产常开 barred on P4**（事务/两阶段/repair 三选一 + crash-injection 证据，或 owner 书面接受有界风险）。
- **OD-5**：OFF 字节等价；ON created=201 `internal_persist/true`；exact replay=200 `internal_noop/false`（绝不因 flag ON 谎报写入）；persist 失败返回 coarse error，不带 intake/raw row/partial counters。
- **OD-6**：T4 扩展而非重写；RC-A 只在「#4101 RC-0 最终 PASS + T3b runtime 真库证据已合 + T4 approved-source 扩展通过」三者齐备后切一次。

## 3. 运行时实现与守卫面（#4398 的接线形态）

```text
POST /api/integration/stock-preparation/mvp/source-runs/plm-bom   (admin)
  flag = MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED
  ON → assertStockPreparationPlmAutoPersistNoSteering(req)   # body allowlist 与一切 I/O 之前
  normalize body（allowlist）
  tenant = ON ? resolveAuthUserTenantId(req) : resolveTenantId(req, input)   # OFF 逐字节不变
  loadStockPreparationReadonlySource → { preparedRead, system, config, createAdapter }
  ON → assertPlmAutoPersistSourceConfigSafe(config)          # 任何 adapter 创建/读取、provisioning、persist 之前
  runPlmBomReadonlySource（值面只在本请求内）
  OFF → 200 publicReadonlySourceRunResult（无 autoPersist 字段）
  ON  → buildPlmSourcePersistInput({request, intake})        # 纯桥，OD-3
        persistStockPreparationSyncRun（1a 硬化后的唯一写入口；target=authTenant staging）
        201 internal_persist/true ｜ 200 internal_noop/false（exact replay）
```

关键锚点（对 main 现网核实）：
- 桥 shape guard 全 fail-closed：`stock-preparation-plm-source-persist-bridge.cjs:187-201`（`CONFIG_SHAPE_INVALID` / `CONFIG_TARGET_FORBIDDEN`）；`FORBIDDEN_FIELD_MAP_TARGETS = ['missingChildBom']`（:171）。
- 一行不丢：`projectExpansionRows` 行数守恒 + `row_count_mismatch` 整包拒绝（:83-110,145-148）。
- 1a replay 硬化（#4382）：batch 命中不再无条件 skip——完整投影判等 + `PERSIST_EXISTING_BATCH_INCOMPLETE` / `PERSIST_IDEMPOTENCY_CONFLICT` / `PERSIST_EXISTING_BATCH_READ_UNPROVABLE`。

## 4. corrective 弧（#4101 实体机验收的判据面修复）

实体机 RC-0 验收链的三次矫正，全部只动 runner/smoke 判据面，不动业务运行时：

- **corrective-3（#4351）**：`POWERSHELL_NATIVE_STDERR_PROMOTION` —— PS 7.3+ 在 `$ErrorActionPreference=Stop` 下把 native stderr 提升为异常，runner 曾把「smoke 有 stderr 输出」误判成执行失败。修复为 stdout-only 捕获（`2>$null`）+ `Invoke-SmokeCapture` summary-only 边界 + AST 接线守卫（防 fixture 与调用方一起漂移）。
- **corrective-4（#4369）**：实体机证明 Windows PowerShell 5.1 下 `2>$null` 仍不充分——改为把 `$ErrorActionPreference='Continue'` 限定在唯一一次 native 调用周围并在 finally 恢复（`stock-preparation-onprem-acceptance.ps1:411-420` 一带）。实体机 1/1 复跑证明 runner 捕获成立，但 packaged smoke 本身 exit 1（`auditActionsCovered=N/8`），暴露诊断面不足。
- **corrective-5（#4390）**：两件事。
  1. **有界 values-free 诊断契约**：smoke 侧 13 相位冻结枚举（`AUTH → PROVISIONING → SYNC_PERSIST → PROJECTS → SNAPSHOT_DIFF → MAPPINGS → CONVERSIONS → GENERATION_RUN → FAILCLOSED_PROBES → ERP_CACHE_SYNC → CLEANUP_RETIRES → AUDIT_TRAIL → RESPONSE_LEAK_SCAN`）+ 5 个诊断输出（`failureClass / lastCompletedPhase / firstFailedCheck / failedCheckCount / responseLeakScanStatus`，全部固定枚举或整数，exit 1 时也随 summary 传播）；runner 侧 `$Summary` 由 9 → 14 个白名单字段，`Test-SmokeOutcome` 对枚举做 allowlist 钳制（词表外→`UNKNOWN`，非枚举形→`NOT_RUN`）；末相位只有 `leakScanClean` 为 boolean 才算完成（防「误报最终阶段已完成」）。
  2. **实体机 N/8 根因修复**：smoke 原来只在 query string 携带租户，而租户加固后的写路由只认 `x-tenant-id` 头 → 首个写 400 `TENANT_REQUIRED` → 提前返回 → `N/8`。修复为 `buildRequestHeaders` 统一注入 `x-tenant-id`（`stock-preparation-mvp-postdeploy-smoke.mjs:449-452`），并以可注入 `fetchImpl`（:457-458）把该头钉进测试（删除该头 → `pass 24 / fail 2`，mutation KILLED）。

## 5. 验证证据

### 5.1 单测 / 契约面（本地，全部对 main 或 PR head 实跑）
- plugin-integration-core 全链 `pnpm test` exit 0（~95 文件串行链）。
- `http-routes.test.cjs`：T3b-1c 新增 6 测试——ON 全链（双向 leak-bait：正控证明哨兵值确实抵达内部写沉降面，再证明其绝不过 HTTP；行落沉 2/2；`imported→active` 在写沉降面证明且原词 `imported` 不落）、steering 5 向量 + body `projectId` 必填 + staging 形状 body projectId 不可转向物理 target、config guard 前置（adapter 创建/读取、records、provisioning 计数全 0）、raw lifecycle（released/obsolete/WIP）与 Option A 值级整包 422（details 不含原值）、OFF 双拼写（unset/'false'）响应 deepEqual 字节等价、mid-persist 注入失败 → coarse error 无哨兵泄漏。
- `stock-preparation-mvp-postdeploy-smoke.test.mjs`：`tests 26 / pass 26 / fail 0`（逐字）。
- PowerShell 契约/行为面（pwsh 7.6.2, macOS）：contract `ALL CONTRACT CHECKS PASS`；behavior `ALL 40 BEHAVIOURAL CHECKS PASS`；ps51 套件 11/12——唯一 FAIL 是「host 必须为 Windows PowerShell 5.1 Desktop」的环境守卫（macOS 上结构性不可满足；该套件的目标环境是 CI `windows-latest` 步骤，见 `plugin-tests.yml` 的 PS 5.1 arm）。
- core-backend `tsc --noEmit` exit 0。
- T4-final harness（#4402）：prep-line smoke 契约测试 17/17（10 基线 + 7 新行为测试，经可注入 `req/must/registerSentinels` 驱动——happy path、dry_run(flag OFF)必败、replay 谎报写入必败、外写证据污染必败、steering-free 请求、哨兵注册契约必需即抛）；W6 冻结面零改动且其测试仍 26/0；两 PR（#4398/#4402）均经独立 Opus 对抗审阅（APPROVE，0 P1 / 0 P2；#4402 的 P3-1 hardening 当场闭合）。

### 5.2 真库（本地 PostgreSQL，CI 同款 MIGRATION_EXCLUDE 迁移）
`stock-preparation-t3b-plm-autopersist-realdb.test.ts`（新，走**真 route handler + 真 provisioning/records**，物理 fieldId 从 `meta_fields` 交叉核对、拒绝逻辑 id 自证）4/4：
1. ON：1 project / 1 batch / 2 line / 1 run 物理落行于 `<authTenant>:integration-core`；`imported→active` 在物理行上证明；响应对 7 类哨兵（行值/项目号/项目名/credential/config id/system id）全 clean；exact replay 200 `internal_noop` 零增行。
2. OFF：dry_run、无 `autoPersist`、四表零增行。
3. raw lifecycle 422 零写、错误面无原值。
4. forbidden `missingChildBom` target 422 零写、**adapter 创建计数 0**、错误面无 source 列名。

同跑 T3a realdb（3/3）与 T3b-1a replay-hardening realdb（1/1）无回归；三文件 8/8。新文件已加入 required `plugin-tests.yml` 真库白名单步（与兄弟切片同一步）。

### 5.3 Mutation 台账（纪律：先 commit，改 → RED 逐字 → 恢复 → GREEN）

| # | Mutation（route 级，#4398） | RED 证据（逐字） |
|---|---|---|
| M1 | flag gate 恒 ON | `503 !== 200` |
| M2 | steering guard 移除 | `body.tenantId: steering rejected` / `500 !== 400` |
| M3 | config guard 移除 | `forbidden marker target rejects the whole run` / `500 !== 422` |
| M4 | config guard 挪到 source I/O 之后 | `config guard fires before any source adapter exists` |
| M5 | persist 调用切断 | `200 !== 201` |
| M6 | replay 硬报 internal write | `+ 'internal_persist'` / `- 'internal_noop'` |
| M7 | 物理 target 采用 body projectId | `the body projectId can never move the physical target` |
| M8 | ON 路径 tenant 换回 `resolveTenantId(req,input)` | **route 级 green（如实记录）**：steering guard 封死全部显式载体后该交换不可观测；承重防线 = M2 + 既有 resolver-differ 直测（T3a ratified 先例） |

T4-final（#4402）smoke 侧 mutation：TM1 放宽接受 dry_run → `✖ ... a 200 dry_run (T3b flag OFF) FAILS the prelude`；TM2 请求携带 query steering 载体 → `✖ ... steering-free requests`；HM1 删哨兵注册调用 → 16/1 RED；均恢复后复绿。
corrective-5 侧关键 mutation（#4390 复审轮已 KILL）：删 `x-tenant-id` 头 → `pass 24 / fail 2`；伪造末相位完成 → P2-1 gate RED；`fieldMap` 空数组/畸形 entry 放行 → guard 单测 RED。
白名单移除类 mutation（`plugin-tests.yml` 去行）为**文档化声明**：兄弟切片（T3a/T3b-1a realdb）同无 wiring-guard，遵循同模式如实记录，未虚称已被测试钉死。

### 5.4 本地真实服务预演（corrective-5 发包前置门，owner 要求）
本地起真实服务 + 真库，完整重放验收轮：`mvpSmoke.pass=true`、`auditActionsCovered=8/8`、`selfScanClean=true`、`responseLeakScanStatus=PASS`（48 个响应逐个 leak-scan clean）。达标后才切包。

### 5.5 发布与执行指针
- Release：`stock-prep-onprem-rc0-corrective5-20260716-3bf7292e1`（**Pre-release**，14 assets）；`BUILD_PROVENANCE.gitCommit == 3bf7292e16cdfcdf24bbf0857a9cbc5d653831d4`（= #4390 merge SHA，逐字节核对）。
- #4101（OPEN）最新权威指令 = corrective-5 values-free 执行指针（issuecomment-4993413137）：stage 1 起完整重跑 + 五条 PASS 判据；corrective-4 release 在实体机 PASS 前**不**标 `[SUPERSEDED]`。

## 6. 冻结面与剩余门（如实边界）

- **实体机纯等待中**：corrective-5 包/runner/smoke 冻结；PASS → corrective-4 标记 `[SUPERSEDED]`、关 #4101；FAIL → 保留现场，按 5 个诊断字段定位相位/检查点。本文不将实体机结果计为已达成。
- **T4-final**（OD-6 扩展）：harness 已交付（#4402）——`--approved-source-config-id` 可选前置，独立盐化 id 空间证明 approved source → project/batch/line/run 前段，合成链判据原样保留。**活体端到端执行按锁归 RC-A 的单次受控窗口**（operator 临时开 flag → 跑 → 恢复；本文不将其计为已执行）。
- **RC-A**：单次 exact-SHA 包 + 实体机验收，三前置见 OD-6；reviewed FAIL 不解锁。
- **P4**：persist 原子性/repair 硬化，独立设计门；此前**生产常开保持 barred**（本弧从未声称跨表原子或孤儿 batch 可自愈——1a 只是把 false-success 改成显式 409）。
- 部署模板不写死任何 auto-persist flag；两 flag 均 default OFF。

## 7. 结论

T3 弧的代码侧交付按阶梯全部落 main：T3a（锁+runtime）、T3b-0/1a/1b/1c/2（锁 + persist 硬化 + 纯桥 + 结构守卫 + route 接线 + 真库 smoke）、T4-final（approved-source 前置 harness）、corrective-3/4/5（判据面三修 + 有界诊断契约 + 根因修复 + 本地全量预演 + 发包/指针）。剩余为**门控项**而非开发缺口：实体机 RC-0 终判、RC-A 单切（含 T4-final 活体执行）、P4 设计门。
