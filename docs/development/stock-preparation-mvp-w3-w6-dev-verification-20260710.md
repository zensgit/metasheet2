# 备料 MVP(#3751)W2 收尾 + W3/W4/W5/W6 波次 — 开发与验证记录(2026-07-09/10)

> 「数据库及系统连接」线(260702 → 260709 续)的 /goal 目标池执行记录。
> 范围:W2-persist 列车收尾、W3 确认路由阶梯、W4 生成/异常运行时 + FE 视图 3/4、
> W5 队列读面(+ FE 视图 5/6 与审计门在途)。前序 = `stock-preparation-mvp-design-20260707.md`
> (设计)与 Wave 1+2 记录(#3996)。**本文是记录,不是授权**;owner-gated 池见 §7。

## 1. 落地台账(全部 MERGED on main,按落地顺序)

| PR | 切片 | 对抗审阅 |
|---|---|---|
| #3995 | W2-persist:sync-run plan 提交持久化(9 内部表,幂等/不可变;staging/business 双项目分裂修正) | owner 亲审(P1 staging 定位修复)+ 过闸 |
| #4002 | View-2 后端:快照批次 LIST + 计数 DIFF(completeness = lineCount>0 且 run 行存在) | owner 亲审 |
| #3997 | FE 视图 2:BOM 快照批次与差异(只读) | owner 亲审 |
| #4015 | **W3b confirm-writes**:映射候选同步(create-only)/映射确认(XOR)/退役 + 单位规则确认(tri-XOR)/退役 | APPROVE,0×P1/P2,7/9 mutation KILLED;4 P3/NIT 已修 |
| #4017 | View-2 follow-ups:incomplete 徽标 + view1→view2 共享 projectId;**捞获 CI 盲区**(3 个 StockPreparation spec 原零 workflow 跑→补进 integration-guard) | APPROVE;P3-1 防御纵深注记;CI flake 根因修复(宏任务竞速→waitForSelector 轮询) |
| #4019 | **W3a**:BLOCKING_CHANGE_TYPES 导出 + diff 基准对选择(404/409/400)+ 逐行 diff 浏览(11 键闭合投影,2000 cap) | APPROVE;**P2-A1 已修**(幽灵 current + 显式 base 绕过项目门→fail-closed 404) |
| #4021 | **W3c confirm-reads**:映射 summary/候选队列 + 单位 summary/候选(计算不存)四条只读路由 | APPROVE;P2-C1/C2 测试硬化 + P3 matchMethod unknown 折叠已修 |
| #4026 | **FE 视图 3+4**:物料映射确认 + 单位换算确认(双向 wire 契约逐字节对齐;43 spec) | APPROVE,零 findings,5/5 mutation KILLED |

**续落(MERGED on main;实现 PR 合计 12 个):**

| PR | 切片 | 对抗审阅 |
|---|---|---|
| #4024 | **W4a generation-runtime**:生成 run(prep 行 UPSERT 显式清空 + 异常 create-only + run 台账 patch-on-rerun)+ 异常单/批决议(same-reason 闸) | REQUEST_CHANGES 5×P2(混血行/prep_generate 词表/台账冻结/双守卫未测)全修 → 复核 **APPROVE**(6/6 mutation KILLED;null-patch 语义对真 records 服务核实) |
| #4027 | **W5a 队列读**:异常队列 LIST(message 绝不过线)+ 备料明细 values-free summary LIST(值面 owner-gated OD-W3-1) | APPROVE-with-hardening(P2 谓词 fixture 对称 + 403 循环 + AND 种子,全修) |
| #4029 | **W5b 审计轨(#3890)**:migration 066 + append-only store(结构性 values-free 闸)+ 8 写 handler 审计 + GET /audit;无 store 时写路由 501 拒绝 | APPROVE-with-hardening(P2 501 零测→8 路由 fail-closed 测试落;迁移锁测试;key 不回显;workspace 过滤)全修。**落地时 test(20.x) 红=DingTalk 共享 DB flake,rerun 洗绿(非本 PR)** |
| #4030 | **FE 视图 5+6**:备料明细(值面注记 owner-gated)+ 异常确认队列(same-reason 前端镜像,server 409 为准);壳 union 合并 #4026(视图 1-6 全挂) | APPROVE(零 P1/P2;P3 ready 镜像 asymmetric fixture + prune-on-reload fixture 已补;guard 43 文件/598 测绿) |

**在途(第 13 个实现 PR,owner REQUEST_CHANGES 修复中,fresh-green 后合并):**

| PR | 切片 | 审阅 |
|---|---|---|
| #4038 | **W6 postdeploy smoke**:脚本 + dispatch-only workflow + 脚本测试;61 断言链(不变量翻转/human_preserved 幸存/审计 8/8/fail-closed 探针/leakScan;scratch harness 驱动真实 createHandlers) | opus4.8 APPROVE(P3-2 非空背板已补)→ **owner 复审 REQUEST_CHANGES 两 P2**:① workflow 缺 concurrency 串行闸;② 输出层非 values-free by construction(mode/code/field 原样透传可泄业务值)——修复=固定 concurrency group + 输出注册集投影 + 毒值负测 |


## 2. 端点地图(本轮新增,全部 `requireAccess(req,'admin')` + staging/business 分裂)

```
读(queryRecords-only,values-free):
  GET  …/snapshot-batches/:id/diff?baseSnapshotBatchId=   ← W3a 基准对选择
  GET  …/snapshot-batches/:id/diff/rows                   ← W3a 逐行浏览(11 键投影)
  GET  …/material-mappings/summary|candidates             ← W3c(FE-pinned 形状)
  GET  …/unit-conversions/summary|candidates              ← W3c(单位候选=计算不存)
  GET  …/exceptions                                       ← W5a(view 6;message 不过线)
  GET  …/prep-lines                                       ← W5a(view 5;值面 owner-gated)
  GET  …/audit                                            ← W5b(审计轨读,values-free by construction)

写(multitable-internal only,服务端戳):
  POST …/material-mappings/candidates/sync|confirm|retire ← W3b
  POST …/unit-conversions/confirm|retire                  ← W3b
  POST …/generation/run                                   ← W4a
  POST …/exceptions/resolve|bulk-resolve                  ← W4a
```

## 3. 承重不变量(全部 mutation/negative 测试钉死)

1. **服务端 ready 不变量(#3888/#3890 共享锁)**:`ready === engine 'ready' && 未解决 blocking 异常数 === 0`,
   持久化后重算、含既往行——前端只镜像,永远无法自造 readiness。
2. **单位候选算不存(毒性不对称)**:`selectUnitRule` 先 scope 排序后查确认 → 持久化的未确认
   material-scope 规则会遮蔽已确认 generic 规则;因此唯一落表的规则 = 人工显式确认那一刻的行。
   映射候选持久化无害(`selectConfirmedMapping` 先 exactly-one matched)。
3. **服务端戳**:confirmedBy/At、resolvedBy/At = 路由 user 身份 + 模块时刻;body 供给 = 未知字段 400
   (闭合 allowlist,每路由独立 Set)。
4. **human_preserved 结构性保护**:候选同步/生成 run 对确认戳/决议三元组结构性剥离;已决议异常行
   永不被重跑克隆或覆盖;确认行永不被系统写自动反确认(版本换代 = 新 pending 行,双策略测试钉死)。
5. **UPSERT 显式清空**:prep 行刷新对 fresh row 缺席的模板字段置 null(混血身份行守卫;null=清除
   语义已对真 records 服务 `normalizeFieldValue` 核实,无 mock 漂移)。
6. **same-reason 闸(#3890)**:批量决议所有目标须同一 exceptionType,任何 patch 前 409;≤200。
7. **values-free 全域**:counts/enum/boolean/sha16 handle;异常 message、图号/数量/单位符号(OD-W3-1
   owner-gated)不过线;junk 存储枚举折叠为 `unknown` 且原串不过线;每 PR 种哨兵扫描。
8. **结构性内部写**:一切写经 `createTargetScopedRecordsApi` 绑定冻结 9 表 + staging 项目;
   零 apply-writer/K3/外部写 import(C4 #2253 未触碰)。
9. **fail-closed 批次门**:显式批次必须存在+归属本项目+完整(run 行+非空行);最新完整批次
   auto-pick 跳过孤儿;幽灵 current + 显式 base = 404(W3a P2-A1)。

## 4. 对抗审阅机制实录(供复盘)

- **每 PR 独立对抗审阅(非自审)**,refute-first + mutation:W3b 9 发(7 KILLED,2 survivor 判非承重)、
  W4a 15 发(首轮 8 SURVIVED → 5×P2 修后复核 6/6 KILLED)、#4026 5/5、W3a/W3c 合审逐门。
- **审阅真抓到的实弹**:W3a 幽灵 current 绕项目门(P2-A1,runtime 探针实证)、W4a 混血 UPSERT 行 +
  runType 词表外 + run 台账冻结(双实证)、W3c 对称 fixture 掩盖谓词反转。**证明该闸值回票价。**
- 模型分派:实现+审阅主力 = Fable 5(Opus 限额窗口内以 fable 顶 adversarial-reviewer 有效);
  FE 切片 = fable subagent(worktree 隔离)。
- 落地力学:stacked 链每段落地 → `rebase --onto origin/main <旧父tip>` + retarget;「列车司机」
  monitor(90s update-branch + 红检报警)贯穿全程;auto-merge 只在审阅 APPROVE 后 arm。

## 5. 测试与 CI 姿态(诚实声明)

- **CI 口径更正**:plugin-integration-core CJS 测试链**已由 integration-guard.yml 执行**
  (`pnpm --filter plugin-integration-core test`,非 required check)——收尾规划 B1 的 guard lane
  已成立;本文早稿的"零 CI"表述过时。required 集(contracts×3/pr-validate/test 20.x)仍不含该链,
  故每个 PR body 附本地验证命令 + 主循环落地前实跑全链的纪律保留。
- apps/web StockPreparation specs 由 #4017 起纳入 **非 required** 的 integration-guard(red 可见
  但不硬阻 admin-merge);required web-tests 白名单不含它们。
- 新增测试:W3b 24 · W3a +3(reads 12)· W3c 8→10 · W4a 8 · FE 43(#4026)+ 35(#4017)。

## 6. Open Decisions(不臆造,owner 待答;代码已双策并举不被阻塞)

OD1 图号/版本字段口径 · OD2 versionPolicy 默认(API 每请求必填,无服务端默认)· OD3 领料单位
口径 · OD4 取整/最小领料量 · OD5 备料行确认粒度 · OD6 异常 blocking/warning 分级(现=全 blocking
保守姿态,决议仅显式 action)· OD-W3-1 值面操作员读(图号/数量/单位)是否开 gated+audited 读 ·
OD-W3-2 退役审计字段(归 W5b)。

## 7. Owner-gated 池(冻结即完成,不建)

- `sp-export-import-templates`(等 OD1/3/4 客户口径)
- C4 ERP/K3 apply/外部写(#2253)· K3 Save/Submit/Audit · `stockPrepApplyProduction` 开关
- 中央 rbac(红线;W5b 只做模块级门)
- 值面操作员读(OD-W3-1)

## 8. 收官声明(2026-07-10)

> 本节保留 2026-07-10 当时的在途状态；最终实体机验收结论见 §9 addendum。

**代码侧完成口径(更正版):W2 尾段 + W3/W4/W5 全波 + F follow-ups = 12 个实现 PR 已 MERGED
on main;第 13 个(#4038 smoke)在途,owner REQUEST_CHANGES 修复后 fresh-green 合并。**
落地定序(owner 指定):#4038 fresh-green 合并 → **实体机 dispatch PASS** → 本 MD 补 PASS 记录。
**实体机 PASS 之前只称"代码侧完成",不称"全线闭环"。** decision-clean 池已清空;剩余 =
owner-gated 池(§7)+ Open Decisions(§6)+ 实体机执行。

补充审计轨说明(W5b):8 action 决策面审计 + 结构性 values-free 闸(migration 066);
provisioning/ensure/sync-persist 面保留各自 run 记录,刻意不进本轨。
FE 侧六视图全挂 StockPreparationWorkspace(壳 union 含 #4026/#4030 双波),
integration-guard 收录全部 7 个 StockPreparation spec(43 文件/598 测)。

## 9. 实体机验收 addendum(2026-07-17)

W6 postdeploy smoke 已由 #4038 合入 main(`d11c1afac`)。最终 Windows on-prem 验收使用已校验的
corrective-6 release `stock-prep-onprem-rc0-corrective6-20260717-f5c449782`，源码 SHA 为
`f5c4497828915f861a948a9e08326b88ff4497e3`。完整 values-free 证据记录在 #4101；本节只固化
关闭判据，不记录 tenant、credential、host、路径、业务值或原始日志。
corrective-4 与 corrective-5 pre-release 均已标记 `[SUPERSEDED→corrective-6]`；corrective-6 是本弧
唯一通过实体机验收的 canonical RC-0 package。

首次 corrective-6 执行在 AUTH 后的 PROVISIONING 阶段 fail-closed。后续 bounded 澄清证明同一
admin principal 被使用，但 runner 未收到非空 `-TenantId`。该失败因此归类为调用参数遗漏，不是
包、迁移或 runtime 新缺陷。operator 使用同一已校验 release，从全新 stage 1 仅纠正本地 tenant
参数后执行一次；未改包、未安装额外依赖、未使用 `MIGRATION_EXCLUDE`、未绕过 packaged runner，
也未补跑 manual smoke。

最终结果：

```text
releaseAssetChecksum=PASS
remoteStagingChecksum=PASS
packageProvenanceShaMatch=PASS
packageShaMatch=PASS
migrationStatus=PASS
pm2RestartCommand=PASS
pm2StableOnline=PASS
healthcheck=PASS
mvpSmoke.pass=true
mvpSmoke.auditActionsCovered=8/8
mvpSmoke.selfScanClean=true
mvpSmoke.failureClass=NONE
mvpSmoke.lastCompletedPhase=RESPONSE_LEAK_SCAN
mvpSmoke.firstFailedCheck=NONE
mvpSmoke.failedCheckCount=0
mvpSmoke.responseLeakScanStatus=PASS
externalPlmK3ErpWrite=false
postRunCredentialHygiene=PASS
postRunReadOnly.deployedProvenanceMatch=PASS
postRunReadOnly.postSmokeStabilityCheck=PASS
postRunReadOnly.healthcheck=PASS
postRunReadOnly.independentCredentialHygiene=PASS
postRunReadOnly.migrationExcludeAbsent=PASS
postRunReadOnly.lingeringAcceptanceProcess=false
failedStage=none
repeatability=1/1
overallAcceptance=PASS
```

**结论：W3-W6 on-prem package/runtime 验收弧 PASS，#4101 已按该范围 CLOSED。** 此结论只关闭本文定义的
实体机运行时验收，不授权 §6/§7 的 owner-gated 产品决策、外部 PLM/K3/ERP 写、生产 rollout 或
额外实体机执行。#4423 的 bounded HTTP failure diagnostics 是后续预防性加固，不是本次 PASS 的
来源或关闭前置；本次验收不需要 corrective-7 package。
