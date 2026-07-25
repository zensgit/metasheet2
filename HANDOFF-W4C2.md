# HANDOFF — W4C-2 live and scheduled shadow（阶段接力注记，不随 PR 交付内容变更）

分支 `claude/w4c2-live-scheduled-shadow-20260725`（base = origin/main `aebac4f8b`）。
真库：`ms2_w4c2`（CI 同构 MIGRATION_EXCLUDE 全链迁移，本地 PG，postgres@127.0.0.1）。

**状态总览：Stage A + Stage B DONE（已 commit）。核心 cutover（Stage C-F）未开工——本文
§Plan 节是完整架构决定记录，接力 agent 从 Stage C 起工。**

---

## Stage A — #4607 门审移交批（DONE, commit `git log` 第 1 条）

1. **P3-1/P3-2/P3-5 三腿**追加进 `packages/core-backend/src/attendance/__tests__/w4c1-segment-calculator.test.ts`
   末尾新 describe 块（纯追加，零改写既有断言；76/76 绿）。P3-1 fixture 是自算的
   164+306=470 形状（门审建议的 165/305 在 per-segment rounding 下不排他——165 整除 15；
   我的 164/306 对 per-segment(450)/step30(450)/step10/5/none(470) 全排他，正确值 465）。
2. **shadow-diff 预期差异清单（P0）**：`w4c2-shadow-expected-differences.ts` + spec（4/4 绿）。
   唯一条目 `correction_applied_daily_adjusted`（W4C-1 裁量 #6：legacy computeMetrics
   ~L11369 只在 leave/OT>0 给 adjusted；W4 correction-applied 无异常日给 adjusted）。
   预期差异谓词 exact-shape fail-closed；W4 侧用真计算器证得（correction+零 leave/OT ⇒
   adjusted）；W4C-4 comparator 消费此 roster。
3. **P3-4 timezone 写入路由**：新 services port `attendanceW4SegmentCalculation`
   （core index.ts ~L2035，least-privilege 只发 plugin-attendance；类型在 types/plugin.ts）
   暴露唯一 strict IANA validator。plugin 侧 helper
   `respondUnlessStrictIanaTimezoneWrite`（index.cjs activate 内，emitEvent 定义后）+
   三处路由接线：PUT /rules/default、POST /shifts、PUT /shifts/:id。port 缺失且携带
   timezone 的写 ⇒ 503 fail-closed。新真库套件
   `attendance-w4c2-timezone-write-guard.db.test.ts`（8/8 绿，两点接线，随机 org 零共享态污染,
   `+05:00` 腿 = strict-vs-loose 判别）。
4. **P3-3 决定（二选一）**：选「接线处显式保证」——W4C-2 boundary 的 merge-policy lift 调用点
   必须先证 record 行存在（legacy 调用序 upsert 后 merge，等价流程中无记录行分支不可达）。
   **此保证落在 Stage C 的 boundary 代码 + 注释 + 一条断言腿；PR body 要写明选择理由**（不加
   `recordExists` 输入是为了不改写已落 main 的 w4c1-merge-policy 测试 fixtures——零改写纪律）。
5. 反建议照办：未为 `>2 matches` 加 stub Intl 腿。

## Stage B — outbox dispatcher（DONE, commit 第 2 条）

`w4c2-outbox-dispatcher.ts`：SKIP LOCKED 批量 claim → emit → 同事务 delivered 翻转；
at-least-once 通知、零 source/result DML；per-row 失败 containment（attempts 单调 +
线性 backoff `next_attempt_at`）；无自带 timer（调度归 caller，env-gate 姿势同 posture seam）。
真库 5 腿含 rendezvous 构造的真并发（两连接 SKIP LOCKED 扫描重叠证明）。
**生产接线未做**（归 Stage C/D）：建议在 core-backend 启动面（或 plugin activate 的
attendanceScheduler.registerJob）注册 drain 循环，用与 posture allowlist 同一 env
`ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED` 非空作为 gate（无 env ⇒ 无 worker ⇒ 字节不变）。

## 实跑实数（Stage A+B）

- calculator spec 76/76；shadow-diff spec 4/4；timezone guard 8/8（ms2_w4c2）；
  outbox dispatcher 5/5（ms2_w4c2）；tsc --noEmit exit 0；node --check index.cjs OK；
  plugin-tests.yml YAML parse OK。
- **CI 同构 attendance 步全量：61 files / 766 passed（753 基线 + 13 新 = 766，零红零改写）**
  于 ms2_w4c2（Stage B commit 后实跑，日志 scratchpad `w4c2-fullstep.log`）。日志内红色
  error 行是 import 套件的注入故障预期输出。复跑注意 W4C-0 handoff 未竟 43 的
  attendance-plugin auto-shift 共享库残留现象——脏库复跑该文件可能假红，用全新库判别。
- Mutation 自检（先 commit 后 mutate）：见下文 §Mutation 记账。

---

## Plan — 核心 cutover（Stage C-F，未开工；架构决定已定案如下）

### 已核实的地基事实（接力者不必重查）

- 插件 db = `context.api.database` = core 的 `poolManager`（同一 Pool）；plugin trx 有
  `__rawClient`（真 pg client）；plugin `db.query` 返回 rows 数组，registry 层要 `{rows}`
  ——boundary 内做双向 wrapper。
- W4C-0 API 全部可直接消费：`normalizeAttendanceSourceOperationEnvelopeV1`（live_punch/
  scheduled 的 payload 闭集校验 + registryInput）、`attendanceResultOperationPreflightV1`
  （四态：replay/suspended/claimed/legacy_no_operation；内部已做 witness 校验、SQL recheck、
  class-00 shared、resolver、class-10、锁下重读）、`seal/cancel/enqueueOutbox`、
  `runAttendanceResultOperationTransactionV1`（SERIALIZABLE + 合同超时 + 40001/40P01 有界重试）、
  `createAuthorizedAttendanceWriteContextV1`（host factory）、posture resolver。
- P01 站点：index.cjs `/api/attendance/punch` 路由 ~L26537 db.transaction（event INSERT +
  loadAttendanceRecordForUpdate + upsertAttendanceRecord + applyAttendanceInOutMergePolicy）；
  P02 = 同事务第二步 merge；P03 = `runAutoAbsenceForOrgDate` ~L21240 调 `generateAbsenceRecords`
  ~L21101（INSERT..SELECT NOT EXISTS）；P04 = `/api/attendance/auto-absence/run` ~L43165 同函数。
- calculations/segments 表的完整 CHECK 矩阵在迁移 zzzz20260725120000 ~L643-L900（completed 需
  attribution posture=resolved_v2 + context + count 1..3；review 全空 + effect none；shadow ⇒
  projection_effect='none'；`uq_arc_operation` 幂等 backstop；lineage 严格低版本 trigger）。

### 架构拍板（接力者照此实现，改动须在 PR 声明）

1. **boundary 属 core-backend TS**：新模块 `w4c2-live-scheduled-boundary.ts`（§8.1 的
   executeAttendanceResultOperation 面向 live_punch/scheduled 两 kind 的实现）。plugin 经
   既有 `attendanceW4SegmentCalculation` services port 拿到
   `createLiveScheduledBoundary({ legacyAdapters })` 工厂（activate 时一次性注入 legacy
   执行闭包——**不是 per-request callback**，与锁 §4.1「no route-provided source callback」
   相容：路由每次只提交纯数据 envelope）。
2. **legacyAdapters 形状**（plugin activate 时注入，全部收 plugin-shaped trx wrapper）：
   - `applyLivePunchLegacy(trx, args)` — 现 db.transaction 体逐字搬移（event INSERT →
     loadForUpdate → freeze V1 meta → upsert → merge lift）；args = 路由已算好的
     { userId, orgId, workDate, timezone, rule, eventType, occurredAt, source, location,
     meta, punchWorkDateResolution, isWorkday, settings }。**P3-3 显式保证落点**：merge
     调用前 record 必已由 upsert 存在（断言腿 + 注释）。
   - `applyScheduledAbsenceLegacy(trx, args)` — generateAbsenceRecords 的同字节 INSERT。
   - `resolveLiveCandidate(trx, args)` / `resolveScheduledCandidate(trx, args)` — §8.2 步 4/7
     的事务内重解析（复用 resolvePunchWorkDateByShiftWindow / resolveWorkContext /
     scheduledAdapters；shadow 分支用）。
3. **事务形状**：两阶段单事务——`runAttendanceResultOperationTransactionV1` 包整个 preflight
   +分支（legacy 分支也在 SERIALIZABLE 内跑同字节 DML；40001 重试 = 整事务重放，随机 UUID
   在闭包内生成）。若门审判 legacy 分支必须保持原 isolation，改为 preflight 探测后二次开
   plugin db.transaction——两读呈裁点，默认取前者（顺序测试下不可观测）。
4. **响应字节红线**：路由的响应组装保持逐字节（result.event/record/workDateResolution 形状
   不动；emitEvent 仍在路由 post-commit 同步发——legacy 分支不写 outbox）。
5. **scheduled run 身份（裁量，PR 必须声明）**：runId 决定性推导
   UUIDv5(新命名 namespace 常量, initiator("cron"|"admin_run") + NUL + orgId + NUL + workDate)；
   cron 与 admin 分 run（congruence 比 actor，同 run 异 actor 会 409 毒化）；
   `expectedRunVersion` 恒 1，`scheduledAbsenceSource` = initiator 常量。durable replay =
   registry 层（重启后同 runId ⇒ 同 per-user UUIDv5 ⇒ replay 零 DML）；`skipDedup` 只跳
   in-memory key，永不能绕 registry replay。legacy 姿态下 scheduled 全 null-ID（零 operation
   行，字节不变）；W4 姿态下逐 user 一个 scheduled 单命令 envelope（batch kinds 只有
   import/integration——Stage A 常量核实过）。
6. **shadow 分支序**（§8.2 步 3-16 的 live/scheduled 摘要）：claim 后 → legacy source DML
   （经 legacyAdapters，= prepared legacy projection 的执行）→ class-11 target 锁 →
   事务内重解析 attribution/context → V2 builder（见下）→ w4c1 calculator →
   calculation+segments INSERT（mode='shadow'、projection_effect='none'、outcome per §6.2）→
   outbox enqueue（**seal 前**）→ seal(item, response=路由响应快照)。
   W2 ambiguous / 姿态矩阵三腿 / offset-less legacy time ⇒ 按 §12.3 的 review/拒绝分支。
7. **V2 attribution builder**（最深的未决工程）：新模块 `w4c2-frozen-attribution.ts`。
   输入 = W2 winner 的完整 candidate（含 absoluteWindow/attributionWindow——resolver lib
   ~L659-L681 已构造但 public result 收窄丢弃；需给 resolver 加 opt-in 返回完整 winner 的
   additive 出参，零现行为变化）+ timezone + tail policy + OT windows。用 w4c1-strict-time
   重建每个边界（无 buildZonedDate/UTC fallback），与 candidate 窗口逐 instant 比对，
   不一致 ⇒ review_required；`windowEvidenceFingerprint` = canonical JSON hash（tail policy +
   OT window IDs/versions/anchors）。V1/missing/ambiguous/unresolved 永不 cast V2。
8. **collector curated 更新**（Stage D）：删 P01/P02/P03/P04 四条 debt entry；其站点
   （op/upsertAttendanceRecord/generateAbsenceRecords）改由新「canonical-adapter claim」类目
   认领（认领谓词 = 同 (relPath,symbol)，类目字段标 `canonicalizedBy: 'W4C-2'`）——
   unclaimed=0 检测不被绕；pinned baseline artifact 字节不动（其重生成只读 pinned ref）。
   注意 collector 测试第 2 条（byte-reproducible）不受影响，第 1 条（exact-head scan）需要
   新类目生效。`table-classification.cjs` 的 `w4_canonical` 路径前缀需加 `w4c2-*.ts`。
9. **§12.3 门→落点映射**（PR body 模板骨架）：live 三姿态矩阵/replay/posture split 双侧
   独立腿/claim+suspension 先于 first DML(call-order mutation)/scheduled direct-insert
   mutation/P01-P04 removal 对账/forged witness 四腿/promotion blocked+accepted_write_posture
   不可 rebase(可复用 E1/E3 已证面+新增 boundary 腿)/suspension replay 零 DML。
   「web decision UUID / verified channel replay」诸腿属 registry 协议面（W4C-0 已证）+
   3b cutover——PR body 引用而非重做，误差自报。

### Stage 顺序建议（接力）

- Stage C：boundary + V2 builder + plugin 四点 cutover（index.cjs 换调用 + adapters 注入）。
- Stage D：collector curated 更新 + dispatcher 生产接线（env-gate）。
- Stage E：真库门矩阵（三姿态矩阵逐腿/replay/TOCTOU 双连接/call-order mutation 腿）。
- Stage F：mutation 轮 + PR（body 照 #4606/#4607 形制 + §11.1 六项 + 薄弱环节自报）。

## Mutation 记账（Stage A+B 已跑部分；Stage F 汇总成表）

先 commit 后 mutate、`git checkout -- <精确文件>` 还原（全部已实跑，ms2_w4c2）：

| # | 变异 | Flip set（实测） | 还原核验 |
|---|---|---|---|
| MA1 | index.cjs 删默认规则路由的 strict 检查 | **恰 2 红**：default-rule 的 `+05:00` 与 `Not/AZone` 腿；6 绿（含 shift 全部腿 + 双正控）——排他 | git checkout 还原后 8/8 |
| MA2 | helper 改用本地 loose `isValidTimeZoneIdentifier` | **恰 3 红**：三条 offset-form 腿（rule `+05:00` / shift create `+05:00` / shift update `+08:00`）；`Not/AZone`/`Mars/OlympusMons` 腿保持绿（loose 也拒它们）——证明 offset 腿判别 strict-vs-loose | 同上 |
| MB1 | dispatcher SQL 去掉 `SKIP LOCKED`（**首刀误中 doc 注释 = 真空变异 5/5 绿，已察觉并重打到 SQL 行**——教训：mutate 后核对命中位置） | **恰 1 红**：并发腿 rendezvous 10s 超时；4 绿 | git checkout 还原后 5/5 |
| MB2 | dispatcher 不 emit 直接 delivered | **3 红**：crash-recovery（emitted 空）/emit-failure（poisoned 被假投递）/并发（ordinals 空）；2 绿（validation+wiring 腿不断言 emission，属预期） | 同上；两套件合跑 13/13 复绿 |

## 呈裁/薄弱点（PR body 必列）

1. P3-4 使默认规则/shift 的 timezone 写从「任意字符串静默入库」变为 4xx——sanctioned 行为
   变化（锁 §12.2 末句 + owner 把它列为 W4C-2 明写门）；`legacy_projection_only` 响应字节
   红线不覆盖该写入面（新增拒绝面 ≠ 已有响应变形）。
2. port 缺失 ⇒ 503 fail-closed 的姿势沿 S7 先例；非 core host 不存在，风险低。
3. dispatcher 的 at-least-once（emit 后 commit 前 crash ⇒ 重发通知）是有意读法——锁只禁
   重复 source/result DML。
4. scheduled runId 推导 namespace 是新常量（非锁文字面）——裁量呈裁。
5. Stage A/B 未动 P01-P04 站点——debt 移除对账在 Stage C/D 之后才成立；本阶段 PR 若先行，
   body 须明说 P01-P04 removal 未完成（或等 cutover 完成后一并开 PR——**建议后者**）。
