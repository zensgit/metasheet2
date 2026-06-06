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

### 2.1 内 / 外勤分类器（authoritative）—— ⚠️ 依赖 S2-0 source 加固

- **外勤事件 = `event.source === 'outdoor_approval'`**；**内勤事件 = 其余所有 `check_in` / `check_out` 事件**。
- ⚠️ **不能用 `meta.outdoor === true` 单独判定外勤**：requireApproval 关时 client 传 `meta.outdoor` 会被忽略并按普通打卡落地（`source` 仍是 client 值），那是内勤卡。`meta.outdoor` 只是佐证。
- 🔴 **`outdoor_approval` 当前并非可信标记 —— 必须先加固（S2-0 / S3-hardening，§3 + §6）。** punch schema 的 `source: z.string().optional()`（`index.cjs:~16473`）允许 client 传任意 `source`，普通 punch 直接落 `parsed.data.source ?? 'manual'`（`index.cjs:~19080`）——**即 client 可伪造 `source='outdoor_approval'`**，被合并层当 approved 外勤误合。故分类器成立的**前置条件**是：把 `outdoor_approval` 列为 **reserved source**，**只有 S3 approve writer 可写**；`/punch`（及任何非 approve 写入路径）对 client 传入的 `source='outdoor_approval'` 一律**拒绝（422）或归一化**（落 `manual`）。S2 不得在此加固落地前实现，且必须有反向测试锁死（§5.P1）。

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

1. **approved 外勤与普通打卡同日并存，谁赢上/下班卡？** 见 §2.2：上班卡由 `internalWinsOnIn`、下班卡由 `externalWinsOnOut` 分别决定；默认两键 false ⇒ 最早 in / 最晚 out（不分内外）。分类以 `source='outdoor_approval'` 判，**须先经 S2-0 把该 source 设为 reserved/防伪造**（§2.1/§3）。
2. **pending `outdoor_punch` 是否完全不参与 summary/records？** 是，且**与 S2 无关**：S3 锁定 pending 不写 event/record；records/summary 只看已写入的事实，故 pending 永不参与（S2 前后都一样）。
3. **rejected / canceled 是否完全不参与？** 是：reject/cancel 同样不写 event/record（S3），永不参与。**只有 approved 外勤（= `source='outdoor_approval'` 的真实 event）才是 S2 的可合并对象。**
4. **check_in 与 check_out 分别口径？** 是，§2.2 两键各管一侧，**禁止只写"外勤优先"**：上班卡是 `internalWinsOnIn`、下班卡是 `externalWinsOnOut`，可独立取值。
5. **是否只影响 summary/records/report 计算、不回写 events？** 是。S2 是 record 派生口径：改变 `first_in_at`/`last_out_at`（及由其派生的 `work_minutes`/迟到/早退/status）如何**算出**；**`attendance_events` 永不被改写**。summary/report 读 records 路径不变（§2.4）。**且 record-only 既有事实受保护**：import 批量写的 record、`mode:'override'` 更正的 record **不被冲掉**，S2 只在 {当天 check 事件 ∪ 现有 record 值} 候选间重选（§2.4）。
6. **与既有 first-in/last-out 如何兼容？** 默认 `false/false` ⇒ §2.2 退化为"所有卡最早 in / 最晚 out" = 当前 append 行为，逐位一致；某键置 true 时只是把"胜出桶"从"全部"收窄到对应类型（在场时），仍走 earliest-in/latest-out。
7. **默认配置 = 现状、不回归？** 是：(a) `internalWinsOnIn=false ∧ externalWinsOnOut=false` ≡ 现状；(b) 即使两键为 true，当天**无外勤事件**时四桶只剩内勤 → 退化为现状（外勤桶空 ⇒ 内勤定卡）。故"默认 + 无外勤"双重保证基线不动。
8. **S2 runtime 完成口径？** 见 §5：真实事件组合**反向测试矩阵**（内/外勤 × in/out × 两键）+ staging smoke，全满足且 tracker `内外勤卡合并` 行翻 ✅ 才算完成。

### 2.4 计算落点 + 🔴 不得覆盖 record-only 事实（import / override 保护）

- 合并在 **record 派生时**生效：check_in/check_out 事件落地（普通 punch / 外勤 approve）后，按 merge 策略算 effective in/out 写 `attendance_records`。summary/report 仍只读 records（读路径零改动）。**write-time 物化**（read-time 现算留作历史回算的未来选项）。
- 🔴 **绝不能"只读 events 重算覆盖 records"**，因为 record 的 first/last **不全来自 check 事件**：(a) **import/bulk 路径直接 `batchUpsertAttendanceRecords*` 写 records，不写 check_in/check_out events**（`index.cjs:~13898/13960/14262/14434`）；(b) **补卡/更正审批 `mode:'override'` 直接改 record 的 first/last**（`index.cjs:~20620`），只补一条 `event_type='adjustment'` 审计事件（非 check 卡）。若 S2 按"events 重算"literal 实现，**后来一张普通/外勤 punch 会把导入值或更正值冲掉**。
- **保护口径（锁定）**：S2 重算的候选集 = {当天 check_in/check_out 事件（分内/外勤）} **∪ {现有 record 的 `first_in_at`/`last_out_at`（视为受保护的既有候选，带 import/override provenance）}**。merge 策略只在候选间**重新选谁当上/下班卡**，**绝不丢弃 record-only 既有值**——即 S2 产出的 record 信息量不得低于"现有 append/override 路径"会产出的值。
- **窄触发（再保险）**：merge 的"重新选择"**仅当 (i) 对应键为 true 且 (ii) 当天同时存在内勤与外勤 check 事件**时才介入；否则（默认键 / 无外勤事件 / 纯 import / 纯 override 日）走**现有 append/override 派生不变** → record-only 事实天然不受影响。

## 3. Data Model Delta

- **无新增表、无新增列、无 DDL**。
- 复用 `settings.punchPolicy.merge.{internalWinsOnIn, externalWinsOnOut}`（S0 已 latent）。S2 仅需在 PUT settings schema 暴露这两键（参照 S3-2 暴露 outdoor 的做法），admin card 复用同一 settings section。
- 复用 `attendance_events.source`（`'outdoor_approval'` vs 其它）作分类器。**不新增"内/外勤"标记列**到 events 或 records。
- 🔴 **S2-0：`outdoor_approval` = reserved source（无 DDL，纯 write-path guard）**。`/punch`（及任何非 S3-approve 写 event 的路径）必须**拒绝/归一化** client 传入的 `source='outdoor_approval'`（落 `manual` 或 422），确保该 source 只由 S3 approve writer 产生 —— 否则分类器可被伪造（见 §2.1）。这是 S2-1 的**硬前置**。

## 4. Runtime Flow（口径，impl 期细化）

1. 触发点 = check_in/check_out 事件写入后（普通 punch 末尾、S3 outdoor approve 末尾）。**import/override 路径不触发 merge 重选**（它们直接定 record，受 §2.4 保护）。
2. **窄判**：仅当 (i) 对应键 true 且 (ii) 当天既有内勤又有外勤 check 事件时进入步骤 3-5；否则走**现有 append/override 派生**（零改动）。
3. 载入当天该 (org,user,workDate) 的全部 `attendance_events`，按 `source` 分内/外勤、按 `event_type` 分 in/out；**并把现有 record 的 `first_in_at`/`last_out_at` 取为受保护既有候选**（§2.4）。
4. 按 §2.2 在候选间算 effective `first_in_at` / `last_out_at`（不丢弃 record-only 既有值）。
5. 用 effective in/out 喂既有 **`computeMetrics({ rule, firstInAt, lastOutAt, …, leaveMinutes, overtimeMinutes })`** 重算 metrics（同一函数；leave/overtime 按 `loadApprovedMinutes` 取齐），upsert `attendance_records`。**不触碰 events。**
6. 默认键 / 无外勤事件 ⇒ 不进步骤 3-5 ⇒ 行为逐位等于现状 ⇒ 零回归。

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
10. **🔴 P1 伪造 source 锁死（S2-0）**：普通 `/punch` 传 `source='outdoor_approval'` → 被拒（422）或归一化为 `manual`；该事件**不得**被合并层当外勤；`source='outdoor_approval'` 的 event 在库里只可能来自 S3 approve。
11. **🔴 P2 import record + later punch 保护**：先 import/bulk 写一条有 `first_in/last_out` 的 record（不写 check 事件）→ 之后落一张普通 punch → 断言**导入的 first/last 不被冲掉**（受保护既有候选）。
12. **🔴 P2 missed-override + later punch 保护**：补卡/更正审批 `mode:'override'` 改 record 后，再落普通/外勤 punch → 断言**更正值不被冲掉**。

Frontend（admin card，复用 S3-2 模式，可与 backend 同 PR 或拆）：渲染两键、保存只 PUT `{ punchPolicy: { merge: {...} } }`（`toEqual` 锁 body）、文案诚实（不宣称移动端/照片/合并已"智能")。

Staging smoke before ✅：部署 → 开一键（如 `externalWinsOnOut=true`）→ seed 同日内勤+approved 外勤两卡 → 断言 record 上/下班卡按口径归属、events 未变、summary 跟随 → 关键后复原 → cleanup residue=0。

### 5.1 后续硬化（post-#2333，非阻塞 backlog —— 不是立即 TODO）

#2333（MERGED + CI green，不回滚/不补 blocking）已落地 §2.4 record-only 保护：测试 11/12 以**直接插入 `attendance_records` row** 复现"已有 record-only fact 存在、后续 punch 触发 S2 merge"。该 proxy **有效**——真正 chokepoint 是 `applyAttendanceInOutMergePolicy`（普通 `/punch` `index.cjs:~19226`、approved `outdoor_punch` `~20828` **两路均经此**），用 `protectedRecordTime(protectedRecord?.first_in_at/last_out_at, checkIns/checkOuts)`（`~13779`）判定既有 record 值是否**非** check-event 表示、若是则保留该 record-only 候选。import/override **无需**自行调用保护（它们只 persist record-only fact；保护在后续 punch 触发 merge 时读持久化值生效，path-agnostic）。"确认 chokepoint 单点"已成立。以下为**非阻塞**硬化 backlog：

- **real-path drift guard**：补一个真实 import 或 missed-override → later punch 的 real-DB 测试。目的**不是**证明 write path 调保护（它不调，亦无需），而是防"路径建模偏差"——若未来 import/override 改成**也写一条 matching check 事件**，该 record 将不再是 record-only fact、`protectedRecordTime` 不再保留、保护静默失效，而当前直接插入式 fixture 测试**仍 green**。real-path 测试锁住"import/override 实际产出的持久化状态 == fixture 假设的状态"。
- **symmetric `last_out_at` 保护**：当前测试主要覆盖受保护的 `first_in_at`；`protectedRecordTime` 对 `first_in_at`/`last_out_at` **对称**，补一个 protected record-only `last_out_at` + later punch 的对称用例。
- **（optional，非立即 TODO）path-enumeration audit**：**仅当未来新增** record recompute/re-selection 入口时才做——审计确认没有绕过 `applyAttendanceInOutMergePolicy` / `protectedRecordTime` 的新路径（当前 chokepoint 单点，已确认普通 punch + outdoor approve 两路均经此；新增写/重算入口前不需要）。

## 6. Gated TODO（全 🔒，须显式 opt-in）

**Design**
- ✅ S2-D1 pre-flight @ `f1cda9d6f`：S3 runtime+card 已落、无外勤合并 PR/branch 冲突、`merge` latent 已就位。
- ✅ S2-D2 锁内/外勤分类器（`source='outdoor_approval'`）+ 上/下班卡两键语义（wins-when-present-else-fallback）+ 默认=现状。
- ✅ S2-D3 锁"派生层、不回写 events"+ write-time 重算落点 + 完成口径（反向矩阵 + staging）。
- ✅ S2-D4（review 加固）锁 **P1 source 伪造防护（reserved `outdoor_approval`）** + **P2 record-only 事实保护（import/override 不被冲）** + 窄触发。

**Implementation（🔒）**
- 🔒 **S2-0 source 加固（硬前置）**：`/punch` 等非 approve 路径拒绝/归一化 client `source='outdoor_approval'`；反向测试（§5.10）。**S2-1 不得早于此落地。**
- 🔒 S2-1 backend：PUT settings 暴露 `punchPolicy.merge` 两键；record 派生升级为**事件感知 + record-only 保护 + 窄触发**重算；默认逐位等于现状。
- 🔒 S2-2 frontend：admin card 暴露两键（复用 S3-2 settings section）。
- 🔒 S2-3 real-DB 反向矩阵 + web 测试 + staging smoke；staging 通过后才可把 tracker `内外勤卡合并` 翻 ✅。

## 7. Out of Scope / 明确不做

移动端外勤体验 · 照片 / `requirePhoto` 存证 · C5 外发渠道 · dist-sdk SDK 类型 · 重开 S3 完成口径 · 给 events/records 新增"内/外勤"列（用 `source` 判别，不落新列）· 历史数据回算（write-time 物化只影响新落地的 records；历史重算另议）。

## 8. References
- Parent: `attendance-punch-policy-group-design-lock-20260602.md`（#2203，子序 S1→S3→S2）
- S3 外勤审批 design-lock: `attendance-outdoor-approval-s3-design-lock-20260605.md`（#2304）；runtime #2308；staging closeout #2319；admin card #2322
- Tracker: `attendance-dingtalk-benchmark-target-and-tracker-20260601.md`
