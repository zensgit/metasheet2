# 考勤内外勤卡合并 S2 design-lock（仅设计 / 不写码）

> Date: 2026-06-05 · Status: **DESIGN-LOCK — 设计冻结，待显式 opt-in 才实现，本文不含代码**
> 执行账本：`docs/development/attendance-dingtalk-benchmark-target-and-tracker-20260601.md`（H2 项 ②「打卡策略组」中的 S2 内外勤卡合并）。
> Parent：`attendance-punch-policy-group-design-lock-20260602.md`（#2203；#2211 修正子序为 **S1→S3→S2**）。
> 前置已满足：**S3 外勤审批 runtime #2308 已落 main 且 staging-proven，S3-2 admin card #2322 已落 main** —— 外勤事实类型 `source='outdoor_approval'` 已存在，S2 才有可合并对象。
> Evidence re-grep @ `origin/main` = `f1cda9d6f`（#2322 后）。实现期先 rebase + 重新 re-grep；symbol 名优先于行号。

## 0. Hard Constraints

- **仅设计、不开工**：本文只钉 S2 口径；任何代码另起 opt-in / PR。
- **默认 = 现状，零回归**：`punchPolicy.merge` 两键默认 `{ internalWinsOnIn: false, externalWinsOnOut: false }`；该默认必须**逐位等于当前 first-in / last-out 行为**。无外勤事件的日子（requireApproval 关或无外勤）合并恒为 no-op。
- **不回写原始 `attendance_events`**：S2 是**派生层（records / summary / report 计算）**口径，绝不修改 raw 打卡事件。事件是不可变审计真相；records 的 `first_in_at` / `last_out_at` 是其派生快照。
- **不新增表 / 不新增 DDL / 不改 OpenAPI / dist-sdk**：复用既有 `punchPolicy.merge`（S0 #2204 已 latent + normalize + deep-merge）与 `attendance_events.source`。
- **不重开 S3**：S3 的 pending/approve/reject 状态流、`outdoor_punch` 创建路径、admin card 完成口径**不在本文重议**。本文只定义"approved 外勤事件如何与内勤事件合并成上/下班卡"。
- **不做移动端外勤体验 / 照片 / requirePhoto / C5 外发渠道 / dist-sdk**。

## 1. Current State @ `f1cda9d6f`（合并的真相基线）

| Area | 现状 | Evidence |
|---|---|---|
| 内/外勤事件区分 | **S3 后已存在**：approved 外勤打卡写 `attendance_events` 时 `source='outdoor_approval'`、`meta={requestId,requestType:'outdoor_punch',outdoor:true}`；普通打卡 `source` 为 client 值（`manual`/`mobile`/…）且无该 meta | `plugins/plugin-attendance/index.cjs`（S3 resolveRequest outdoor 分支，#2308） |
| 记录派生 = first-in/last-out | `computeAttendanceRecordUpsertValues` append 模式：`firstInAt = !firstInAt || update<firstInAt ? update : firstInAt`（**最早 in**）、`lastOutAt = !lastOutAt || update>lastOutAt ? update : lastOutAt`（**最晚 out**）。**增量 min/max，不区分 source**，且 record 只存 `first_in_at`/`last_out_at` 时间戳，不存"这张卡是内勤还是外勤" | `index.cjs` `computeAttendanceRecordUpsertValues`（mode `append`） |
| metrics 由 in/out 派生 | `work_minutes`/迟到/早退/status 全由 **`computeMetrics({ rule, firstInAt, lastOutAt, workDate, isWorkingDay, leaveMinutes, overtimeMinutes })`** 从 effective in/out（+ rule + 当日 leave/overtime 分钟）算出 —— **同一函数**。故"换胜出卡"只需把 in/out 喂进它即可自洽重算；in/out 不变 ⇒ metrics 不变（no-regression 的机理基础，已 grounded 非断言） | `index.cjs` `computeAttendanceRecordUpsertValues` → `computeMetrics` |
| 普通打卡写记录 | punch 路由：INSERT event + `upsertAttendanceRecord({ updateFirstInAt: check_in?occurredAt:null, updateLastOutAt: check_out?occurredAt:null, mode:'append' })` | `index.cjs` punch route |
| 外勤 approve 写记录 | S3 outdoor approve 分支：INSERT `outdoor_approval` event + 同样 `mode:'append'` upsert（**当前与内勤一视同仁地走 first-in/last-out**） | `index.cjs` resolveRequest（#2308） |
| pending / reject / cancel | **不写 event、不写 record**（S3 锁定）→ 天然不入 records/summary | `attendance-outdoor-approval-s3-design-lock-20260605.md` §4 |
| summary / report 读取 | `loadAttendanceSummary` 只读 `attendance_records`（counted-day = `is_workday OR work_minutes>0 OR status∈…`）+ 从 `attendance_requests` 取 approved leave/overtime 分钟；**export/report 亦从 `attendance_records` 派生**（`FROM attendance_records ar` → `buildAttendanceRecordReportExportItem`）；**两者都不直接读 events** ⇒ 改 records 即改 summary+report（Q5 已 verified） | `index.cjs` `loadAttendanceSummary`、`FROM attendance_records ar`（~2551）、`buildAttendanceRecordReportExportItem` |
| `punchPolicy.merge` | latent：`{ internalWinsOnIn:false, externalWinsOnOut:false }`，normalize/deep-merge 已就位，**runtime 无人读** | `index.cjs:117` + `normalizePunchPolicySetting` |

**关键认知**：S3 之后，approved 外勤事件已经"按 first-in/last-out"一视同仁地并入了 record —— 即**当前已是 `internalWinsOnIn=false / externalWinsOnOut=false` 的合并**。S2 不是"从无到有做合并"，而是**让合并口径可按内/外勤偏好配置**，且默认不变。

## 2. 合并模型（核心，回答 8 问）

### 2.1 内 / 外勤分类器（authoritative）

- **外勤事件 = `event.source === 'outdoor_approval'`**（只由 S3 审批通过路径写入，唯一可信标记）。
- **内勤事件 = 其余所有 `check_in` / `check_out` 事件**。
- ⚠️ **不能用 `meta.outdoor === true` 单独判定外勤**：requireApproval 关时 client 传 `meta.outdoor` 会被忽略并按普通打卡落地（`source` 仍是 client 值），那是内勤卡。`meta.outdoor` 只是佐证，`source='outdoor_approval'` 才是判据。

### 2.2 上班卡 / 下班卡分别口径（两键独立，**不是一句"外勤优先"**）

把当天事件分成四桶：内勤 check_in、外勤 check_in、内勤 check_out、外勤 check_out。

- **上班卡 effective `first_in_at`** —— 由 `internalWinsOnIn` 决定：
  - `false`（默认）：**所有 check_in（内∪外）里最早的**一张 = 现状。
  - `true`：**若当天存在内勤 check_in → 取内勤 check_in 里最早的**；**否则**（当天无内勤 in）回退取外勤 check_in 里最早的。即"内勤在场则内勤定上班卡，外勤只补空缺"。
- **下班卡 effective `last_out_at`** —— 由 `externalWinsOnOut` 决定：
  - `false`（默认）：**所有 check_out（内∪外）里最晚的**一张 = 现状。
  - `true`：**若当天存在外勤 check_out → 取外勤 check_out 里最晚的**；**否则**（当天无外勤 out）回退取内勤 check_out 里最晚的。即"外勤在场则外勤定下班卡（人在客户现场收的工），内勤只补空缺"。
- 胜出桶内部仍是 **earliest-in / latest-out**；两键互相独立（上班可内勤优先、下班可外勤优先，反之亦然）。
- **"wins when present, else fallback"** 是锁定语义：胜方类型在场才赢，不在场则回退另一类型，绝不把一张卡判成空。

> **⚠️ 工时口径取舍（需 owner 显式确认，非纯机械规则）**：`internalWinsOnIn=true` 在"员工 08:00 在外勤现场上班、10:00 才回公司补内勤卡"时，effective 上班卡 = **较晚的内勤 10:00**，会**缩短计入工时**（外勤在岗的 2h 不计上班起点）。对称地 `externalWinsOnOut=true` 会让"较早的外勤下班卡"赢，亦可能缩短工时。两者都是合理的可选口径（公司可能就是要"以公司内打卡为准"），但有 payroll-adjacent 影响，**默认两键 false 不触发此取舍**；开启前 owner 须确认该侧的工时含义。

### 2.3 八问逐条回答

1. **approved 外勤与普通打卡同日并存，谁赢上/下班卡？** 见 §2.2：上班卡由 `internalWinsOnIn`、下班卡由 `externalWinsOnOut` 分别决定；默认两键 false ⇒ 最早 in / 最晚 out（不分内外）。
2. **pending `outdoor_punch` 是否完全不参与 summary/records？** 是，且**与 S2 无关**：S3 锁定 pending 不写 event/record；records/summary 只看已写入的事实，故 pending 永不参与（S2 前后都一样）。
3. **rejected / canceled 是否完全不参与？** 是：reject/cancel 同样不写 event/record（S3），永不参与。**只有 approved 外勤（= `source='outdoor_approval'` 的真实 event）才是 S2 的可合并对象。**
4. **check_in 与 check_out 分别口径？** 是，§2.2 两键各管一侧，**禁止只写"外勤优先"**：上班卡是 `internalWinsOnIn`、下班卡是 `externalWinsOnOut`，可独立取值。
5. **是否只影响 summary/records/report 计算、不回写 events？** 是。S2 是 record 派生口径：改变 `first_in_at`/`last_out_at`（及由其派生的 `work_minutes`/迟到/早退/status）如何**从当天事件算出**；**`attendance_events` 永不被改写**。summary/report 读 records 的路径不变（§2.4）。
6. **与既有 first-in/last-out 如何兼容？** 默认 `false/false` ⇒ §2.2 退化为"所有卡最早 in / 最晚 out" = 当前 append 行为，逐位一致；某键置 true 时只是把"胜出桶"从"全部"收窄到对应类型（在场时），仍走 earliest-in/latest-out。
7. **默认配置 = 现状、不回归？** 是：(a) `internalWinsOnIn=false ∧ externalWinsOnOut=false` ≡ 现状；(b) 即使两键为 true，当天**无外勤事件**时四桶只剩内勤 → 退化为现状（外勤桶空 ⇒ 内勤定卡）。故"默认 + 无外勤"双重保证基线不动。
8. **S2 runtime 完成口径？** 见 §5：真实事件组合**反向测试矩阵**（内/外勤 × in/out × 两键）+ staging smoke，全满足且 tracker `内外勤卡合并` 行翻 ✅ 才算完成。

### 2.4 计算落点（write-time 重算，read 路径不变）

- 合并在 **record 派生时**生效：每当一个 check_in/check_out 事件落地（普通 punch 或外勤 approve），按 merge 策略**读当天该用户的全部事件、分类、算出 effective in/out**，写进 `attendance_records`。summary/report 仍只读 records（读路径零改动）。
- 这要求把派生从"增量 min/max"升级为"**事件感知重算**"（默认口径下重算结果 == 增量 min/max，故无行为差）。
- **替代（仅记录，不选）**：纯 read-time 重算（summary 时从 events 现算 effective in/out）。本设计选 **write-time 物化**以保持现有"records 即真相、summary 读 records"模型不变；read-time 留作未来若需历史回算再议。

## 3. Data Model Delta

- **无新增表、无新增列、无 DDL**。
- 复用 `settings.punchPolicy.merge.{internalWinsOnIn, externalWinsOnOut}`（S0 已 latent）。S2 仅需在 PUT settings schema 暴露这两键（参照 S3-2 暴露 outdoor 的做法），admin card 复用同一 settings section。
- 复用 `attendance_events.source`（`'outdoor_approval'` vs 其它）作分类器。**不新增"内/外勤"标记列**到 events 或 records。

## 4. Runtime Flow（口径，impl 期细化）

1. 触发点 = 任一 check_in/check_out 事件写入后（普通 punch 末尾、S3 outdoor approve 末尾）。
2. 载入当天该 (org,user,workDate) 的全部 `attendance_events`（含本次），按 `source` 分内/外勤、按 `event_type` 分 in/out。
3. 按 §2.2 算 effective `first_in_at` / `last_out_at`。
4. 用 effective in/out 重算 `work_minutes` / 迟到 / 早退 / status —— **直接喂既有 `computeMetrics({ rule, firstInAt, lastOutAt, …, leaveMinutes, overtimeMinutes })`**（与现状同一函数），入参只把 in/out 换成 effective 值；当日 leave/overtime 分钟须按现有 `loadApprovedMinutes` 口径取齐，确保默认重算 == 现状逐位一致（impl 须以"默认口径 metrics 不变"为回归基线）。
5. upsert `attendance_records`（覆盖 first_in/last_out/metrics）。**不触碰 events。**
6. 默认口径下步骤 3 的结果 == earliest-in/latest-out，步骤 4 == 现状 ⇒ 零回归。

## 5. Tests Required Before Merge（完成口径）

Backend real-DB **事件组合反向矩阵**（构造真实 events，断言派生 record，而非 fixture）：

1. **默认零回归**：`merge` 默认。仅内勤两卡 → 现状 first/last；内+外勤混合 → 仍最早 in / 最晚 out（与 S2 前逐位一致）。
2. **internalWinsOnIn=true**：同日有内勤 check_in(09:05) + 更早的外勤 check_in(08:50) → effective in = **内勤 09:05**；当天只有外勤 check_in → effective in = 外勤（回退）。
3. **externalWinsOnOut=true**：同日有外勤 check_out(18:30) + 更晚内勤 check_out(19:00) → effective out = **外勤 18:30**；当天只有内勤 check_out → effective out = 内勤（回退）。
4. **两键独立**：`internalWinsOnIn=true ∧ externalWinsOnOut=true` 的混合日，上班卡取内勤、下班卡取外勤，互不串。
5. **不参与项**：pending / rejected / canceled 外勤（无 event）对 record/summary 零影响。
6. **events 不被改写**：合并前后查 `attendance_events` 行数 + 字段不变（只 records 变）。
7. **work_minutes 随 effective in/out 重算**：换胜出卡后 `work_minutes`/迟到/早退随之变化且自洽。
8. **summary 跟随**：上述各情形 `loadAttendanceSummary` 的 counted-day/工时随 effective record 变化。
9. **settings wire**：PUT→GET round-trip `punchPolicy.merge` 两键；partial update 保 `unscheduled`/`outdoor` sibling。

Frontend（admin card，复用 S3-2 模式，可与 backend 同 PR 或拆）：渲染两键、保存只 PUT `{ punchPolicy: { merge: {...} } }`（`toEqual` 锁 body）、文案诚实（不宣称移动端/照片/合并已"智能")。

Staging smoke before ✅：部署 → 开一键（如 `externalWinsOnOut=true`）→ seed 同日内勤+approved 外勤两卡 → 断言 record 上/下班卡按口径归属、events 未变、summary 跟随 → 关键后复原 → cleanup residue=0。

## 6. Gated TODO（全 🔒，须显式 opt-in）

**Design**
- ✅ S2-D1 pre-flight @ `f1cda9d6f`：S3 runtime+card 已落、无外勤合并 PR/branch 冲突、`merge` latent 已就位。
- ✅ S2-D2 锁内/外勤分类器（`source='outdoor_approval'`）+ 上/下班卡两键语义（wins-when-present-else-fallback）+ 默认=现状。
- ✅ S2-D3 锁"派生层、不回写 events"+ write-time 重算落点 + 完成口径（反向矩阵 + staging）。

**Implementation（🔒）**
- 🔒 S2-1 backend：PUT settings 暴露 `punchPolicy.merge` 两键；record 派生升级为事件感知重算；默认逐位等于现状。
- 🔒 S2-2 frontend：admin card 暴露两键（复用 S3-2 settings section）。
- 🔒 S2-3 real-DB 反向矩阵 + web 测试 + staging smoke；staging 通过后才可把 tracker `内外勤卡合并` 翻 ✅。

## 7. Out of Scope / 明确不做

移动端外勤体验 · 照片 / `requirePhoto` 存证 · C5 外发渠道 · dist-sdk SDK 类型 · 重开 S3 完成口径 · 给 events/records 新增"内/外勤"列（用 `source` 判别，不落新列）· 历史数据回算（write-time 物化只影响新落地的 records；历史重算另议）。

## 8. References
- Parent: `attendance-punch-policy-group-design-lock-20260602.md`（#2203，子序 S1→S3→S2）
- S3 外勤审批 design-lock: `attendance-outdoor-approval-s3-design-lock-20260605.md`（#2304）；runtime #2308；staging closeout #2319；admin card #2322
- Tracker: `attendance-dingtalk-benchmark-target-and-tracker-20260601.md`
