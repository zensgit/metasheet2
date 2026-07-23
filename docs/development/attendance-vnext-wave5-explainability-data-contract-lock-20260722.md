# 考勤 vNext Wave 5 · 结果解释（explainability）数据合同 design-lock — 2026-07-22

> **Status: PROPOSED（未生效——owner ratify 为唯一生效凭据；ratify 前 W5-0 及一切 Wave 5 runtime
> 不得开工）。**
> 本锁是章程 §15「Wave 5 explainability = DATA-CONTRACT-GATED」这道门的解锁提案：章程台账行逐字为
> 「| Wave 5 explainability | 本总纲仅定义范围 | 未开始 | 未开始 | DATA-CONTRACT-GATED |」（L554），
> W4 锁 header 亦裁定「Wave 5（explainability）维持 DATA-CONTRACT-GATED，不与 Wave 4 并开」（W4 锁
> L47）。前置态势（对 `origin/main` 实证）：W4 三 runtime 切片已全部合入
> （W4-0 #4541 = `b9495af18`、W4-1 #4542 = `2365d977a`、W4-2 #4543 = `bbcb8caf3`），W4 波次验证 MD
> 已入 main（#4544 = `f55d99e12`，`attendance-vnext-wave4-w40-w42-development-verification-20260722.md`）
> ——「不与 Wave 4 并开」的串行约束由 W4 收口满足；W4 完成定义余项（若有）是否构成 W5-0 开工前置，
> 属 owner ratify 时确认（§10）。
> 上位文档：`attendance-vnext-dingtalk-benchmark-ux-development-charter-20260720.md`（RATIFIED；
> §4.6/§6.2/§7-Wave5/§8.1/§9/§11/§13）。对标账本
> `attendance-dingtalk-benchmark-target-and-tracker-20260601.md` 中**不存在** explainability 专项行
> （全文 grep `解释|explain|可解释` 零命中，实证）——章程 §7-Wave5 是本波的唯一上游授权，本锁不
> 凭记忆补写对手行为细节（章程 §1.2 L47-48 + OD-VX4 双重禁止，沿 W4 锁 §1-7 同款边界）。
> **锚点基线 = `bbcb8caf3`**（§11.1；本锁分支基 `f55d99e12`，漂移账 `bbcb8caf3..f55d99e12` = 仅
> +1 份 docs 文件（W4 验证 MD），考勤 runtime 文件零漂移 ⇒ 全部锚点在分支基上继续有效）。
> 引用纪律：`plugins/plugin-attendance/index.cjs`（~43k 行）与 `AttendanceView.vue`（~28k 行）为高频
> 改动文件，行号在后续 merge 后必然漂移——W5-0 实现开工时必须按当时 HEAD 重验锚点（W4 锁 §11.1-附
> 的勘误纪律同样适用于本锁）。

---

## 0. 红线（一等公民，覆盖本锁一切条款）

每个 runtime 切片的完成门必须含对应负向断言（§9）。R2/R4 的措辞根基是章程 §7-Wave5 逐字原句：

> 「交付顺序：先只读决策轨迹，再上下文帮助；任何缺少权威 provenance 的结果不得由前端猜规则原因。」
> （L364）
> 「完成门：每类解释都能指向真实来源、版本/生效日和操作记录；没有数据时显示“无法确定依据”，
> 不生成貌似合理的解释。」（L368-369）

| # | 红线 | 本锁的落地形态 |
|---|---|---|
| R1 | **解释面只读（零写）** | 六类 trace 全部是纯读端点；只读用 Postgres `READ ONLY` 事务做**结构约束**（先例 `runAttendanceSetupReadinessReadOnly`，`attendance-admin.ts:457`；W4-0-G2 三条必拒测试同型复用，§9 W5-0-G3）。解释面不修复、不重算、不回写任何 status/balance/assignment |
| R2 | **依据必须指向真实存储记录** | 依据链每环 = 真实表行/冻结快照/审计行的引用（§3 逐类点名真源）；**禁前端猜规则原因、禁任何 LLM 式/模板式补全**——前端纯模块只做后端 discriminated 形状的白名单映射（先例 `useAttendanceSetupReadiness.ts:55,93-100` 严格解析、未知形状 fail-closed 为 null） |
| R3 | **脱敏 by construction（响应层白名单）** | 后端在响应组装层白名单投影（遮罩清单 §5.1 显式列举：managerChainIds / ip_address / user_agent / 裸内部 id / env 名等），**不是**前端挑字段（memory 教训「客户端 values-free 要边界解析」）；契约测试锁响应键集合恒等 + 禁字段零出现 |
| R4 | **版本缺口如实暴露** | 无版本化的规则显示**「当前规则（无历史版本）」**（§3.1 posture=`current_live_no_history`），绝不虚构版本号、绝不由 `expires_at−granted_at` 之类反推「当时配置」并指认为版本（memory 教训「审计面禁止编造值」）；依据链任一环缺失 ⇒ 该环 `undeterminable`，显示「无法确定依据」（章程 L368 逐字） |

章程同源条款：§5-4「未知状态 fail-closed：不得把未知/加载失败/缺配置显示为成功、正常或 all-clear」
（L232）；§4.4「审计信息以“发生了什么、谁操作、依据什么、如何恢复”组织，不按内部 event code 直接堆给
业务用户」（L196）；§9 指标「解释完整性 | 已覆盖状态全部来自权威字段/审计，不由前端猜测」（L427）；
§3.2 主管边界「不得暴露超出其组织/assignment/scheduler scope 的数据或管理动作」（L132）。

## 1. Grounded problem statement（六类 + 横切，全部对 `bbcb8caf3` 实证）

章程 §7-Wave5 逐字：「首批覆盖：今日状态、迟到/早退、缺卡、加班分段、调休余额、审批人来源。」（L366）
逐类现状与缺口如下。**总括结论**：本仓的一致设计是**「决策时落快照」而非「策略版本化」**——账务/审批类
的权威事实链完整且大多自带 fail-closed 语义；状态类（今日状态/迟到早退/缺卡）则**只存派生结果、不存
规则快照**。策略活体（`system_configs` 单键 `attendance.settings`，SETTINGS_KEY `index.cjs:291`，
`saveSettings :13749-13759` 单行 upsert 无历史）与规则表（`attendance_rules`/`attendance_overtime_rules`
等，原地 UPDATE/DELETE、仅 created_at/updated_at）**均无版本/生效日历史**——因此解释面永远只能说
「本次决策当时快照如此」或「当前规则（无历史版本）」，说不出「策略版本 X 自 Y 生效」。

1. **今日状态。** 权威事实 = `attendance_records` 行（`(user_id, work_date, org_id)` 唯一；status 8 值
   CHECK `normal/late/early_leave/late_early/partial/absent/adjusted/off`，建表
   `zzzz20260114090000_create_attendance_tables.ts:71-75`、`off` 扩展
   `zzzz20260114120000_add_attendance_scheduling_tables.ts:85`）。派生引擎 = `computeMetrics`
   （`index.cjs:11081-11133`，纯函数：rule{起止/宽限/时区/取整/跨夜} + 首末打卡 + isWorkingDay ⇒
   status/minutes）；规则解析 = `resolveWorkContext`（`:14347-14394`，优先级 rotation > shift
   assignment > default rule（`loadDefaultRule :13992-14023`，读 `attendance_rules` is_default 行，
   跨 org 回退 `'default'`、最终回退内存 `DEFAULT_RULE`），holiday 翻转 isWorkingDay，
   `calendarPolicy.overrides` 再叠加；context 携 `source: 'rotation'|'shift'|'rule'`）。
   **缺口**：记录写入（`upsertAttendanceRecord :18642-18720`，INSERT 列清单 `:18684-18705`）**只落
   派生结果**（status/三分钟数/is_workday/meta），不落 rule id、不落 shift id、不落 `source`、不落
   规则快照——「当时按哪套规则判的」在库中不存在；任何后续重算（后续打卡/导入/审批改记录
   `:29965-30033`）都按**当时的现行规则**重算。解释面对状态类的「版本/生效日」只能诚实呈现
   `current_live_no_history` 或 `undeterminable`（OD-W5-8：是否立前置票给 record 落规则 provenance）。
2. **迟到/早退。** 阈值语义在 `computeMetrics`：`lateThresholdAt = 班次开始 + lateGraceMinutes`、
   `earlyThresholdAt = 班次结束 − earlyGraceMinutes`（`:11119-11123`；status 判级 `:11125-11128`）；
   分钟数落行。迟到分级
   （severe/absence tier）**是半个快照**：每次 upsert 按**当时** rule 阈值计算并冻结进
   `meta.severe_late_count/severe_late_minutes/absence_late_count`（`computeLateTierCounts` 调用点
   `:18822-18830`；阈值列 `attendance_rules.severe_late_threshold_minutes/absence_late_threshold_minutes`，
   `zzzz20260622000000_add_attendance_late_tier_thresholds.ts`）——但阈值**值本身**不落行，legacy 行
   无这些 key（`:18824-18825` 注释逐字「Legacy records that predate this never carry these keys」）。
   人工更正已有**删除免疫**审计：`attendance_record_result_edits`
   （`zzzz20260627120000`：不可变 before/after 快照 + actor + reason + idempotency，**显式无 record FK**
   ——migration 注释逐字「the audit outlives the record it corrects」）+ 记录 `meta.manual_result_edit`
   标记与 reviewConflict 指纹（`:18768-18821`）。**缺口**：该审计表**无任何读 API**（唯一路由是写面
   `POST /api/attendance/anomaly-result-edits` `:26574`；表上其余 SELECT 均为幂等重放内查
   `:19191/:19319`）——「谁在何时把这天从迟到改成正常、依据什么」有权威行却无读面。
3. **缺卡。** 单侧缺卡 = `partial`（`computeMetrics :11103-11105`）；全天旷工 `absent` 行由
   auto-absence 作业**材料化**：`runAutoAbsenceForOrgDate`（`:20365-20425`）→
   `generateAbsenceRecords`（`:20312-20333`，INSERT **零 meta**）；`settings.autoAbsence` 默认
   OFF（`DEFAULT_SETTINGS` `:296-300`，调度门 `:20429`）。已有 values-free 归因先例：
   `classifyOwedPunchRecord`（`:25932-25956`，`{owedPunch, missingSide, owedPunchReason}` 闭集
   reason code）与 `suggestRequestType`（`:26427-26436`，GET `/api/attendance/anomalies` `:26362` 内）。
   补救链有**真快照**：补卡 MP-2/MP-3——`deriveMakeupAnomalyFacts`（`:13293-13338`，server-side
   truth、fail-closed 空 facts）+ `buildMakeupPunchPolicySnapshot`（`:13366-13383`，`version:1` +
   quota/cycle/submitWindow + `matchedAnomalyTypes` + `requestEvaluatedAt` 冻入请求）+ 终审
   adjustment 审计事件携快照（`:30077-30097`）。**缺口**：materialized `absent` 行与任何其他 absent
   行不可区分——无 job/run 标记、作业运行本身零持久痕（仅 `emit('attendance.absence.generated')` +
   log，`:20412-20422`；dedup key 在内存 `lastAutoAbsenceKey`）——「谁在何时判我旷工」对 absent 行
   `undeterminable`。
4. **加班分段。** 六类中 provenance 最完整：快照自描述——
   `OVERTIME_SEGMENTATION_ENGINE='attendance_overtime_segmentation_v1'` + `VERSION=1` +
   `buildOvertimeSegmentationSnapshot`（`:10597-10660`；day-type 判定 `:10612-10635` 携完整
   provenance：effectiveSource/policyId/holidayName/holidaySource/holidayRefId）；跨午夜守恒分摊、
   缺日历 fail-closed 422 `OVERTIME_SEGMENTATION_UNRESOLVED`（`:10669-10715`）；规则归一
   `applyOvertimeRule`（`:10581-10595`）。计算点：提交时写 `metadata.overtimeSegmentation`
   （`:28043-28053`），规则字段提交时冻入 `metadata.overtimeRule`（`:28024-28033`）；**终审时按
   审批当日日历重建并覆盖提交时快照**（`:29706-29717`）。读出 = `readOvertimeSegmentationSnapshot`
   （`:10737-10750`，version+engine 严格校验、不匹配 ⇒ null = 现成 fail-closed 合同）；汇总
   `loadAttendanceSummary`（`:12366-12407`，三 day-type 分钟 + `overtime_segmentation_version`）；
   record meta 富化（`:2952-2961` + `buildApprovedOvertimeSegmentationMeta :10880-10893`）。开关默认
   OFF（`DEFAULT_SETTINGS.overtimeSegmentation :403-407`；门 `maybeBuildOvertimeSegmentationSnapshot`
   `:11000-11003`）。**缺口**：①无解释形读 API——客户端只能解析原始 request metadata；②规则表
   `attendance_overtime_rules`（`zzzz20260120112000:12-32`）与开关无版本/生效日历史（原地 UPDATE
   `:30815`/DELETE `:30868`）；③审批覆盖提交时快照 ⇒ 无双时点记录，无法解释「提交与审批之间日历
   变了」；④周期结算面（convertible/must-pay per source）**无任何读 API**
   （`scripts/ops/staging-attendance-overtime-bank-v18-smoke.mjs:7` 自证 settlements「have NO API read
   surface until the v1-5d read exit lands」；全仓仅 INSERT `:12320` 与 LIMIT-1 存在性检查
   `:37418/:37502`）；⑤口径差：`summary.overtime_minutes` 按 `metadata->>'minutes'` 求和
   （`:12351-12362`）而分段仅累计有快照行——legacy 混布 org 会出现「总加班 > Σ分段」。
5. **调休余额。** 账本 = `attendance_leave_balances`（grant-LOT 台账）+
   `attendance_leave_balance_events`（强制 +/- 流水，符号 CHECK；`zzzz20260603120000:25-76`；
   `reverse` 事件型 `zzzz20260622150000:16-18`；`overtime_source` 列 `zzzz20260624160000:13`）。
   计提点在 OT 终审事务内（dormant 单 lot `:29784-29803`；bank 启用 →
   `partitionOvertimeBankGrantLots :10780-10820`，statutory_holiday 永不入池、**无快照 ⇒ FAIL CLOSED
   池空** `:10797-10799`；月度 cap `:17603-17618` + advisory lock `:29832` + per-source lot 写入
   `:29860-29879`）；`expires_at` 授予时物化（`:10834-10853`/`:29774-29790`）。扣减 FIFO 每 lot 一条
   deduct 事件（`:17530-17573`）；销假回冲 `:17629+`；过期 = `AttendanceExpiryService.ts:30-78`
   （原子 UPDATE + expire 事件）；调度双门 env opt-in（`AttendanceScheduler.ts:311/:379-385`——与
   章程 §2.1 L78「计提与 overtime bank 依赖显式 policy/scheduler opt-in，默认不执行」一致）。
   读面先例：`GET /api/attendance/leave-balances`（admin `:42771-42805`）与 `/me`（自助
   `:42807-42846`，token-subject-locked）→ `readAnnualLeaveBalanceForUser :42722-42768`——其 L5a
   注释（`:42775-42777`）自称返回 summary+lots+events「so a balance is EXPLAINABLE」，且支持
   `leaveTypeCode=comp_time`。周期结算快照 = `snapshotCycleSettlementOnClose`（`:12285-12328`，
   冻结期 + closed_at + policy JSONB，代码注释（`:12293`）逐字「fix the effective policies at close
   so a later policy change can't reback this settlement」，ON CONFLICT DO NOTHING 不可覆写）。
   **缺口**：①Web UI 三处硬编码 `leaveTypeCode='annual'`（`AttendanceView.vue:24106/:24155/:24435`）
   ——comp_time 余额解释**有 API 无 UI**；②admin/self 读的 activeLots SELECT（`:42739-42744`）不含
   `overtime_source`——per-source 银行 provenance 连 API 都不可见；③流水**无 actor 列**
   （migration `:60-69`）、expire 事件无 job/run 标识——时间线能答 what+when 答不了 who；
   ④comp_time 无手工调整原语（登记簿 `:18129-18156` 硬编码 `'annual'` `:18132`；
   `bulkBalanceAdjust.ts:14-15` G1 显式 OUT）；⑤结算快照 write-only 无读面；⑥事件表 FK
   `ON DELETE CASCADE`（migration `:63`）——lot 删则流水随删，审计面**非删除免疫**（对照
   `attendance_record_result_edits` 的无-FK 设计，两种姿态并存）；⑦`OVERTIME_BANK_CAP_EXCEEDED`/
   池空 fail-closed 均发生在写入时且**不落任何行**——被拒/未入池的加班日后无迹可解释。
6. **审批人来源。** 三层权威链在真实代码：(1) 门控——flag env
   `ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED`（`index.cjs:119`，默认 OFF）、三 kind 闭集
   `direct_manager/dept_head/manager_at_level`（`:124`）、`assertApprovalStepsContract`（`:157`，五段
   422）、运行时 fail-closed（`:247`）。(2) 解析——host 端口 `buildApprovalAssigneeResolverPort`
   （`packages/core-backend/src/index.ts:973-978`，仅注入 plugin-attendance `:1925-1926`）；目录读取
   `resolveApprovalRequesterOrgRelations`（`ApprovalDirectoryOrg.ts:201`，READ-ONLY）。(3) 冻结+指派
   ——创建时 freeze（`index.cjs:20745/:20806/:20823/:20841`，调用点 `:20928-20930`）落
   `approval_instances.requester_snapshot`（组装 `:21065`，冻结字段 `:21093-21130`，INSERT
   `:21164-21179`）；步进只读冻结快照（`:29616-29623`）；**「为何是此人」的机器可读依据** =
   `approval_assignments.metadata.resolvedFrom {kind, level}`（`:20934` 起，三 kind 各自
   `:20968-20975/:20993-20998/:21027-21031`，写库 `:21211-21240`）。wire 面：审批详情
   `UnifiedApprovalDTO` 已携 `assignments[].metadata`（`types/approval-product.ts:371-379`）与完整
   requester（`ApprovalProductService.ts:1708/:1733/:1749`）。**缺口**：①解析失败原因不可追溯——
   host 端口算出的 unresolved reason（no_manager_linked/self_manager/… `index.ts:~1012-1070`）在
   plugin 冻结封装（`index.cjs:20745-20800`）被丢弃，创建被阻断 = 零持久化；②冻结 id 无目录证据链
   （裸 user id，不记来源关系与目录同步时间）；③`attendance_approval_flows` 无版本列
   （`zzzz20260120113000:12-23`），flow steps 快照进 request `metadata.approvalFlow`
   （`:25545/:28036/:28865`）但**不带修订标识**；④`approval_assignments` 的 ON CONFLICT DO UPDATE
   会就地覆写同一 assignee 的 metadata/node_key（`:21224-21231`）——指派轨迹**非严格 append-only**，
   审计时间线必须以 `approval_records`（append-only，attendance 写入点
   `:28695/:29145/:29246/:29653/:30233`，含 actor/comment/from_to/ip/ua）为准；⑤前端零消费
   resolvedFrom；唯一 kind→中文标签映射在产品线 `apps/web/src/approvals/assigneeSource.ts:19-31`，
   但其 default 分支 `JSON.stringify(source)`（`:29-30`）不合「无法确定依据」纪律；legacy 兜底
   （role admin + source_queue `:21056-21060`）与静态步 metadata 无 kind，须单独映射且不得伪装成
   resolver 决策。
7. **横切：`AttendanceDecisionTrace.vue` 与「无法确定依据」均不存在于代码。** 全树 grep
   `AttendanceDecisionTrace` 唯一命中 = 章程 §6.2 组件表行（L265，逐字
   「| explainability | `AttendanceDecisionTrace.vue` | 规则依据与审计时间线展示 | 权威数据加载与字段脱敏 |」）；
   「无法确定依据」字符串代码零命中（仅章程 L368）。可直接推广的 fail-closed 三件套先例已在：
   (a) 类型化 posture 含 `'undeterminable'` + `source:'none'`
   （`AttendanceSetupReadinessAggregate.ts:69-93`——W4-0 已合入的四态 effectiveTime 单一真源常量）；
   (b) 前端白名单严格解析、未知形状 fail-closed 为 null（`useAttendanceSetupReadiness.ts:55,93-100`）；
   (c) 审批链 never-fabricate 文案（`apps/web/src/approvals/routePreviewSummary.ts:8-16`
   「（审批人待定）」——注释逐字「names come server-enriched with an honest id fallback, so this
   function never re-guesses」；`assigneeSource.ts:56`「（未配置审批人）」）。

## 2. Scope

**IN（v1，ratify 后按 §9 切片序）**：六类只读决策轨迹（decision-trace）读合同与端点（W5-0）；
`attendance_record_result_edits` 的只读历史读面（迟到/早退与状态更正的「操作记录」环，今天有表无读，
§3.3②）；`AttendanceDecisionTrace.vue` + 纯模块 `attendanceDecisionTrace.ts`（W5-1；章程 L267-268
逐字「纯逻辑优先落到独立 `.ts`：……decision-trace mapping。纯模块必须有完整判别矩阵，不允许再把分支
埋回 Vue template」）；§4.6 四类上下文帮助（W5-2）。

**OUT（显式）**：任何**写路径**（R1——含「顺手修复」记录/余额/指派）；策略/规则**版本化 schema 变更**
（OD-W5-3 呈 owner，若立项走独立前置票）；resolver 决策/失败原因**持久化**（OD-W5-2 同上）；record
规则快照**回填/新增写入**（OD-W5-8 同上）；被拒写入事件（422 fail-closed）落库（OD-W5-4 同上）；
`balance_events` FK CASCADE 修复（OD-W5-5 独立修复票）；comp_time 手工调整原语（既有 G1 OUT 边界，
本锁不重开）；S7 flag / scheduler env / 任何默认 OFF 开关的翻转（staged opt-in 纪律；「引擎关闭」
在本合同中是**要如实解释的策略事实**，不是要修的缺陷）；对手行为细节对照（§1 header）；移动原生/
硬件（章程红线 9）。

## 3. 数据合同（核心，R2/R4 执行面）

### 3.1 通用 trace 形制（六类同构）

每类解释的响应 = 单一 discriminated 结构（仅布尔/非负计数/闭集枚举/ISO 时间戳/白名单文本，
values-free by construction，§5.1 遮罩清单约束一切文本字段）：

```
{
  category,                       // 六类闭集：'today_status'|'late_early'|'missing_punch'|
                                  //   'overtime_segmentation'|'comp_time_balance'|'approver_source'
  conclusion: { ... },            // 该类的 values-free 结论（§3.3 逐类定义；全部来自存量权威字段）
  basis: [                        // 依据链（有序；§3.3 逐类点名每环真源）
    {
      source: { kind, ref },      //   kind = 环类型闭集（'record'|'snapshot'|'rule_live'|'ledger'|
                                  //     'audit'|'policy_gate'）；ref = values-free 来源标识
                                  //     （表/快照名 + 自述 version/engine 若有），绝不含用户值
      version: {                  //   版本/生效日 —— 四态 posture，形制沿 W4 effectiveTime 先例
                                  //     （{source, posture, effectiveAt?}，
                                  //      AttendanceSetupReadinessAggregate.ts:69-93）：
        posture,                  //     'snapshot_frozen'        决策时冻结快照/物化结果在库
                                  //     'current_live_no_history' 活体规则行、无版本历史
                                  //         ——UI 显示「当前规则（无历史版本）」（R4）
                                  //     'not_in_effect'          引擎/策略未启用（默认 OFF /
                                  //         org 未 opt-in）——策略事实，不是数据缺失
                                  //     'undeterminable'         该环依据缺失 ⇒「无法确定依据」
        asOf?,                    //     snapshot_frozen 必携锚点时刻（§3.2 逐类规定锚哪个时刻），
                                  //     其余 posture 禁携（不得伪造时点）
        snapshotVersion?          //     快照自述版本（如 overtimeSegmentation version/engine、
                                  //     makeup snapshot version:1）——仅快照自带时透出，绝不编造
      },
      auditRef?: { kind, at }     //   操作记录引用（审计行类型闭集 + 时刻）；行内值不透出，
                                  //     who 经 §5.1 名册解析或诚实省略
    }
  ],
  confidence                      // 置信档闭集：'grounded'（所有必要环 snapshot_frozen/权威行在）
                                  //   | 'partial'（存在 current_live_no_history / not_in_effect 环）
                                  //   | 'undeterminable'（任一必要环缺失）
                                  //   —— 由 basis 判别矩阵纯派生，绝非独立断言字段
}
```

**硬规则**：
1. **依据链任一环缺失 ⇒ 该环 `posture='undeterminable'`**，且该环参与 confidence 判别——「没有数据时
   显示“无法确定依据”，不生成貌似合理的解释」（章程 L368-369 逐字）。**绝不**允许后端或前端用当前
   策略反推缺失环（例：禁由 `expires_at−granted_at` 反推 validityDays 并呈现为「当时配置」；禁由
   当前 `attendance_overtime_rules` 行重算 legacy 请求的分段）。
2. **`not_in_effect` 与 `undeterminable` 是两个判别值、两套文案**（§5.2 语义细节②）：dormant org 的
   零调休余额，其解释是「调休计提策略未启用」（策略事实，`compTimeFromOvertime.enabled=false`
   `:377-380`），不是「无法确定依据」——混同二者会给 dormant org 生成貌似合理的假解释或假故障。
3. **枚举 enum-strict**：`category/posture/confidence/source.kind/auditRef.kind` 全部闭集；请求侧
   category 非法值 ⇒ 4xx 拒绝（静默 fallback 到默认值 = 契约 bug）；响应侧由契约测试锁值域穷尽。
4. 结论与依据链**只准引用存量权威字段**——本合同不发明新计算；六类的结论字段逐一对应 §1 点名的
   存量列/快照键（R2）。

### 3.2 「版本/生效日」逐类锚点（snapshot_frozen 的 `asOf` 规定，不得任选）

| 类 | snapshot_frozen 环 | asOf 锚点 | 依据 |
|---|---|---|---|
| 加班分段 | `metadata.overtimeSegmentation` + `metadata.overtimeRule` | **`resolvedAt`（终审时刻）** | 终审按审批当日日历重建并**覆盖**提交时快照（`:29706-29717`）——锚 created_at 是错的（§5.2①） |
| 缺卡补救 | makeup `snapshot`（version:1） | `requestEvaluatedAt` | 快照自携（`:13379`） |
| 调休余额 lot | lot 行物化结果 | `granted_at`（expires_at 一并呈现为物化事实） | 授予时物化（`:29774-29790`） |
| 周期结算 | settlements policy JSONB | `closed_at` | 关账冻结、不可覆写（`:12285-12328`） |
| 审批人来源 | `requester_snapshot` + `metadata.approvalFlow` | `approval_instances.created_at` | 创建时冻结（`:21164-21179`）；**只能表述「创建时冻结 @ created_at」**，无修订标识可指认 |
| 状态更正 | `attendance_record_result_edits` before/after | 审计行 `created_at` | 不可变审计（migration 注释） |
| 迟到分级 tier | `meta.severe_late_count` 等（结果冻结、阈值不冻结） | 记录 `updated_at`（如实标注「结果快照，阈值无快照」） | `:18822-18830` |

状态类（今日状态/迟到早退/缺卡本体）的规则环**没有** snapshot_frozen 可用——posture 恒为
`current_live_no_history`（当前 `resolveWorkContext` 推演所依据的活体规则身份）或 `undeterminable`
（行不存在/legacy meta 缺 key）。UI 必须显示「当前规则（无历史版本）」并显式声明**它可能不同于
决策当时的规则**，绝不把当前规则呈现为「当时依据」。

### 3.3 六类逐类合同（结论 / 依据链 / fail-closed 断环条件）

**① 今日状态（today_status）**
- 结论：`{workDate, status(8 值闭集), isWorkday, workMinutes, lateMinutes, earlyLeaveMinutes}`
  （全部为 `attendance_records` 存量列）。
- 依据链：E1 记录环（record 行；auditRef：`source_batch_id` 导入批次存在性 + `meta.manual_result_edit`
  标记存在性——只透出「被人工更正过」布尔与时刻，不透出编辑内容，详情走 E3）；E2 规则环
  （`current_live_no_history`：当前 `resolveWorkContext` 的 source 判别 `'rotation'|'shift'|'rule'` +
  该来源的 values-free 参数投影，§5.1）；E3 更正环（`attendance_record_result_edits` 只读历史，
  W5-0 新增读面）；E4 生成来源环（absent 行：恒 `undeterminable`——§1-3 无 run 标记）。
- 断环 ⇒ fail-closed：record 行不存在 ⇒ 整类 `undeterminable`（**禁**由 `attendance_events` 前端
  自行推导状态）；`off`/非工作日按 status 如实呈现，不算断环。
**② 迟到/早退（late_early）**
- 结论：`{lateMinutes, earlyLeaveMinutes, severeLateCount, severeLateMinutes, absenceLateCount,
  status}`。
- 依据链：E1 记录环（分钟列 + tier meta keys——tier 环按 §3.2 末行「结果快照，阈值无快照」如实
  标注）；E2 阈值环（`current_live_no_history`：当前生效 rule/shift 的宽限与 tier 阈值投影）；
  E3 更正环（同①E3，AE-1 审计不可变、无 FK、删除免疫——这是全仓「操作记录」环的姿态标杆）；
  E4 补救环（time_correction 补卡请求及其 MP-3 快照，`snapshot_frozen @ requestEvaluatedAt`）。
- 断环：legacy 行无 tier keys ⇒ tier 环 `undeterminable`（**禁**把 report 侧的 fallback-0 读作
  「无严重迟到」证据——那是计数约定不是事实断言）。
**③ 缺卡（missing_punch）**
- 结论：`{missingSide('check_in'|'check_out'|'both'), owedPunchReason(闭集), isWorkday,
  suggestedRequestType(闭集|null)}`——直接复用 `classifyOwedPunchRecord`（`:25932-25956`）与
  `suggestRequestType`（`:26427-26436`）的既有闭集，**不新造词表**。
- 依据链：E1 记录环（partial/absent + 空侧列）；E2 应出勤环（record.is_workday 存量值 = 写入时
  冻结的结果；当前 holiday/calendar 仅作 `current_live_no_history` 参考环）；E3 生成来源环
  （absent 材料化：恒 `undeterminable`，文案「无法确定生成来源」；`autoAbsence` 引擎关闭时该环
  = `not_in_effect`）；E4 补救环（makeup 请求 + 快照 + 终审 adjustment 审计事件 `:30077-30097`）。
- 断环：无 record 且 `resolveWorkContext` 不可解析 ⇒ 整类 `undeterminable`
  （`deriveMakeupAnomalyFacts` 的 fail-closed 空 facts 先例 `:13293-13338` 同款语义）。
**④ 加班分段（overtime_segmentation）**
- 结论：`{workdayMinutes, restdayMinutes, holidayMinutes, totalMinutes, segmentationVersion}`
  （summary 存量列 `:12366-12407`）。
- 依据链：E1 快照环（`readOvertimeSegmentationSnapshot` 严格读出，`snapshot_frozen @ resolvedAt`，
  携 engine/version/workDate/calendar decision provenance——day-type 判定的
  effectiveSource/policyId/holidaySource 属白名单可透出的规则性标识，holidayName 按 §5.1）；
  E2 规则环（冻结 `metadata.overtimeRule` = `snapshot_frozen`；现行 `attendance_overtime_rules` 行
  = `current_live_no_history`，二者**并列呈现、显式区分**）；E3 操作记录环
  （`metadata.approvalFlow/resolution`：actor/resolvedAt 经 §5.1 处理，comment 员工面不透出）；
  E4 引擎门环（`overtimeSegmentation.enabled=false` ⇒ `not_in_effect`）。
- 断环：快照缺失（O2 前 legacy 行 / 后开启 org / version/engine 不匹配 ⇒ 既有 null 路径）⇒ 分段环
  `undeterminable`——**这正是既有 fail-closed 合同的解释面延伸**；被拒提交（422 UNRESOLVED 等）
  无行可引 ⇒ 恒 `undeterminable`（OD-W5-4）。**口径差强制声明**：`overtime_minutes` 合计与 Σ分段
  并排出现时，响应必须携 `coverageNote` 判别值（`'full'|'partial_legacy'`），UI 据此显式声明口径差，
  **禁**静默对齐（§5.2④）。
**⑤ 调休余额（comp_time_balance）**
- 结论：L5a 既有形状（summary + active lots + recent events，`:42722-42768`）的 comp_time 投影 +
  lot 级 `{grantedAt, expiresAt, sourceType, overtimeSource?}`。
- 依据链：E1 台账环（lot 行 = `snapshot_frozen @ granted_at`，expires_at 为物化事实——文案只说
  「授予时定为 X 到期」，**禁**反推 validityDays 指认配置版本）；E2 流水环（balance_events：
  what+when 权威；who **无 actor 列** ⇒ who 子环 `undeterminable` 或经 source_id 反链 request/登记簿
  可解析时按 §5.1 透出；**删除免疫边界必须入合同注记**：FK CASCADE 使流水随 lot 删除而消失——
  解释面以流水为凭据时如实声明该边界，OD-W5-5）；E3 策略环（现行 bank/comp-time 策略 =
  `current_live_no_history`；引擎关闭 ⇒ `not_in_effect`——dormant org 零余额的解释是**策略事实**）；
  E4 结算环（settlements 快照 = `snapshot_frozen @ closed_at`，读面是否入 v1 = OD-W5-6）。
- 断环：per-source provenance（`overtime_source`）今天不在读投影（`:42739-42744`）⇒ 该子环在读面
  扩展落地前 `undeterminable`（OD-W5-9）；被 cap 拒绝/池空未入池 ⇒ 无行可引，恒 `undeterminable`
  （OD-W5-4）。
**⑥ 审批人来源（approver_source）**
- 结论：每审批步 `{stepIndex, assigneeResolved(bool), sourceKind(闭集：三动态 kind + 'static' +
  'legacy_fallback' + 'unknown'), level?}`——`sourceKind` 直接来自
  `assignments.metadata.resolvedFrom`；静态步与 legacy 兜底**单独映射**，绝不伪装 resolver 决策。
- 依据链：E1 指派环（resolvedFrom = 决策结果记录；**因 ON CONFLICT 覆写非严格 append-only**，
  合同显式声明其为「当前有效指派的决策标记」）；E2 时间线环（`approval_records` append-only =
  唯一审计时间线真源——「审批时间线以 approval_records 为准」入合同）；E3 冻结环
  （requester_snapshot = `snapshot_frozen @ created_at`，文案只能说「按创建时组织目录冻结」——
  无目录 as-of 版本可指认）；E4 规则环（flow steps 快照 = `snapshot_frozen`（无修订标识，如实
  标注）；活体 flow 行 = `current_live_no_history`）；E5 门环（dynamic flag OFF ⇒ 动态 kind 相关
  解释 = `not_in_effect`）。
- 断环：**解析失败历史恒 `undeterminable`**（reason 被丢弃 + 创建阻断零持久化，§1-6①；是否落
  持久 trace = OD-W5-2——在其裁决与落地前，本合同只解释**已创建实例的既成指派**，不解释「为什么
  当时解析不出」，也**不**提供「按当前目录重新推演」的伪历史）。

## 4. 端点与权限合同（R1/R3 执行面）

**4.1 宿主与受众（受 OD-W5-1 裁决约束，本节先锁不随裁决变化的部分）**：无论挂 admin 面、self 面
还是两者，以下恒成立——
- **不选 plugin 路由**：plugin 侧 `getOrgId(req)` 信任客户端传入（`index.cjs:6215-6223`，W4 锁
  §1-5 已实证的缺口），对解释面（读他人考勤事实）不可接受；trace 端点落
  `packages/core-backend/src/routes/attendance-admin.ts` router（router 级
  `rbacGuard('attendance','admin')` `:492` + `user_orgs` org-membership 门
  `canReadAttendanceDirectoryReadiness :383-407`（平台 admin 直通 `:389`、双 is_active）原样复用
  ——S7-5（调用点 `:508`）与 setup-readiness（调用点 `:537`，端点 `:527`）已两度复用同门的先例）。
- **员工 self 面（若 OD-W5-1 裁入 v1）**：主体**永远是 token subject**（`/api/attendance/leave-balances/me`
  的 token-subject-locked 先例 `:42809-42831`——注释逐字「the subject is ALWAYS the authenticated
  requester」），不接受 userId 参数；响应走 §5.1 员工档遮罩。
- **主管面不入 v1**：章程 §3.2 的 scope 约束（assignment/scheduler scope）需要独立的授权推导，
  超出只读合同范围——显式 OUT，防 scope 放大。
**4.2 只读结构约束**：全部 trace 查询在 `READ ONLY` 事务内（`runAttendanceSetupReadinessReadOnly`
先例 `:457`）；禁首词/正则式「只读校验」；W4-0-G2 的 writable-CTE 与多语句必拒测试同型复用
（§9 W5-0-G3）。
**4.3 响应白名单 by construction**：响应在后端组装层白名单投影——**尤其禁止**把
`UnifiedApprovalDTO.requester` 整包（含 managerChainIds，`ApprovalProductService.ts:1733` 已在
wire 上过曝）透传进 trace；trace 只含被选中审批人的显示名与 sourceKind。契约测试：响应键集合恒等
锁定 + §5.1 禁字段零出现断言（S7-5 单测先例
`packages/core-backend/tests/unit/attendance-admin-directory-readiness-s7-5.test.ts:82-189` 的
SQL values-free 断言同型）。
**4.4 错误档**：400 参数（含 category 非法值 = enum-strict 4xx）/ 401 / 403 / 404（目标记录不存在
且无从解释时区分于 200+undeterminable：**行在但依据环缺 ⇒ 200 + undeterminable；行不在 ⇒ 404**，
两者不得混同）/ 503 `DB_NOT_READY` / 500 泛化文案（S7-5 端点档位姿态复用：
`attendance-admin.ts:498-518`——400 `ORG_ID_REQUIRED` / 401 / 403 / 500 values-free，注释逐字
「Values-free seam: never leak raw DB / driver messages to the client」）。错误体 values-free
（只 code/enum/count，不回显用户值）。

## 5. 脱敏与诚实口径（R3/R4 执行面）

### 5.1 遮罩清单（响应层白名单的显式负清单；两档受众）

| 字段/信息 | admin 面 | 员工 self 面 | 依据 |
|---|---|---|---|
| `requester_snapshot.managerChainIds`（完整管理链） | **禁**（只显示被选中者） | **禁** | wire 已过曝（`ApprovalProductService.ts:1733`），trace 不得放大 |
| `approval_records.ip_address` / `user_agent` | 不入 trace（留在既有审批详情面） | **禁** | 员工面无正当用途 |
| `assignments[].metadata.delegatedFrom` | 显示为「经委托改道」布尔 | **禁** | 暴露委托关系按角色决定 |
| 裸内部 user id | 经名册解析显示名 + honest id fallback | 同左（仅本人相关者） | `routePreviewSummary.ts:11` 先例；W4 完成门「不手输内部 ID」同源 |
| balance events `source_id`（指向他流程 request） | 显示为审计引用类型+时刻，id 不透出 | 同左 | 车道调研脱敏边界 |
| env 名 / 渠道名 / 主机 / 日志路径 | **禁** | **禁** | 章程 §4.6 L225 逐字「所有帮助必须 values-free，不包含客户标识、真实用户、token、主机、内部日志路径或环境秘密」 |
| `ipAllowlist` / `geoFence` 等运维值 | **禁**（打卡边界解释只给判别结果码） | **禁** | W4 OD-W4-4(b) 被拒的同一理由 |
| 审批 comment 正文 | 既有审批面职责，不入 trace | **禁** | trace 只引用记录存在性+时刻 |
| 班次起止/宽限分钟/tier 阈值（规则参数） | 允许 | 允许（本人当前生效规则） | 「为什么算迟到」的解释本体；非个人数据非秘密 |
| holidayName（快照内节假日名） | 允许 | 允许 | 日历规则性事实 |

**by construction 要求**：遮罩在后端响应组装层白名单实现（挑入而非删除），前端纯模块再做一次白名单
解析（双层，前端层是防御纵深不是权威）——「客户端 values-free 要边界解析」纪律。

### 5.2 四条诚实口径（合同级语义细节，实现者不得再自行推导）

1. **分段生效时点 = 终审时刻**：终审按审批当日日历重建并覆盖提交时快照（`:29706-29717`）——解释
   文案锚 `resolvedAt`，**不得**锚 created_at；且因无双时点记录，「提交与审批之间日历变了」不可
   解释（如实 `undeterminable`，不并列展示两版）。
2. **「引擎关闭」≠「无法确定依据」**：`compTimeFromOvertime/overtimeSegmentation/overtimeBankPolicy`
   默认全 OFF（`:377-380/:403-407/:412-417`）、scheduler 另需 env 双门
   （`AttendanceScheduler.ts:311/:379-380`）——这是**策略事实**（posture=`not_in_effect`），与数据
   缺失（`undeterminable`）判别值、文案、测试断言全部分离；否则 dormant org 的零余额会得到貌似
   合理的假解释。
3. **有快照引快照；无快照走既有 null fail-closed 路径**：策略活体单键无版本（§1 总括），因此解释
   永远「本次决策当时快照如此」；**禁**前端按当前策略反推，**禁**把「当前规则（无历史版本）」呈现
   为历史依据（R4）。
4. **口径差显式声明**：`summary.overtime_minutes`（正则求和 `:12351-12362`）与 Σ分段（仅有快照行）
   并排展示必须声明口径差（§3.3④ `coverageNote`），**禁**静默对齐或互相「修正」。

## 6. 组件与文件形状（W5-1/W5-2 预告；实现细节以各切片 PR 为准，形状在此锁定）

- `apps/web/src/views/attendance/attendanceDecisionTrace.ts`（新，纯模块）：后端 discriminated trace
  → 展示模型的**完整判别矩阵**（category × posture × confidence 全行；章程 L267-268 逐字约束）；
  白名单严格解析、未知形状 fail-closed 为 null（`useAttendanceSetupReadiness.ts:93-100` 先例）；
  零 DOM/零 fetch；值域穷尽断言 + mutation 目标（任一判别分支取反 ⇒ 对应腿红）。
- `apps/web/src/views/attendance/AttendanceDecisionTrace.vue`（新，章程 §6.2 预留名，main 实证
  尚不存在）：纯展示 props + emit；「规则依据与审计时间线展示」归组件、「权威数据加载与字段脱敏」
  留父层/后端（章程 L265 行的职责划分逐字执行）；审计时间线按「发生了什么、谁操作、依据什么、
  如何恢复」组织（L196 逐字），不按内部 event code 堆砌；tokens.css `--ms-*` 零硬编码 hex。
- kind→标签映射：复用 `assigneeSource.ts:19-31` 三动态 kind 中文标签（直属上级/部门主管/指定层级
  上级）；**default 分支绝不复用 `JSON.stringify(source)`**（`:29-30`）——未知 kind 走
  「无法确定依据」态；never-fabricate 文案先例（「（审批人待定）」/「（未配置审批人）」）沿用。
- 父层 `apps/web/src/views/AttendanceView.vue`（`views/` 根）：trace 加载与入口接线（单热文件车道，
  章程红线 10——W5-1 期间不得有其他 runtime PR 并行改此文件）。
- `packages/core-backend/src/routes/attendance-admin.ts`：trace 端点 + 契约单测（S7-5/setup-readiness
  测试同型：状态码矩阵 + SQL values-free 断言 + 响应键集合锁定）。
- guard 接线：新 spec 进 `attendance-web-guard.yml` 实际 run-list + `pull_request`/`push` 双 path
  filter + CI 日志收集证明 + 同命令 mutation（章程 §8.1-4 逐字要求；F1 skip-shaped-green 教训）。
- W5-2 帮助：章程 §4.6 四类逐字（「适用于什么场景」「保存后影响谁、何时生效」「常见失败与如何恢复」
  「查看计算依据/审计记录」）——第四类即 trace 入口深链；全部 values-free（L225）；不复制外部手册。

## 7. 与既有面的边界（防重复建设）

- `GET /api/attendance/leave-balances(/me)`（L5a）已是「余额可解释」读面——W5 **不另造第二套余额
  读面**；⑤类 trace 在其形状上补 provenance 环与判别 posture（是扩展合同还是新端点旁挂，随
  OD-W5-1/OD-W5-9 一并裁决）。
- `GET /api/attendance/anomalies` 已产 owed-punch 归因码——③类 trace 复用其闭集，不新造词表。
- setup-readiness（W4-0）是**配置完备度**面；trace 是**单笔结果解释**面——二者共用权限门与只读
  姿态，但不共用响应形状，不互相吞并。
- 审批详情 `UnifiedApprovalDTO` 已携 resolvedFrom 原料——W5-1 的 ⑥类展示**优先消费既有 DTO 的
  白名单投影**，是否需要独立 trace 端点承载（避免前端拿整包 DTO 自行挑字段的 R3 风险）在 W5-0
  设计内解决，倾向以服务端投影为准（R3 by construction）。

## 8. OD 待裁项（全部呈 owner，本锁不自决；无 recommended 标记——W4 §8-附 P2-5b 教训）

| OD | 裁量点 | 选项与后果（中性陈述） |
|---|---|---|
| OD-W5-1 | **解释面受众与开面顺序** | (a) admin 面先行（复用 `attendance-admin` 门，员工面推后）——员工「为什么异常」（章程 §3.1 L125 首屏第三问）暂由既有自助面承担；(b) admin+self 双面同批（self 走 token-subject-locked，遮罩双档 §5.1 全量生效）——切片体量增大；(c) self 先行——与章程员工优先叙事一致，但 admin 排障面推后。三者响应形状同一（§3.1），仅挂载与遮罩档不同 |
| OD-W5-2 | **resolver 决策/失败原因要不要落持久记录** | 今天不落（`index.cjs:20745-20800` 丢弃 reason、创建阻断零持久化）⇒「审批人来源」只能解释**已创建实例的既成指派**，失败历史恒 `undeterminable`。(a) v1 接受此边界（本合同现拟）；(b) 立独立前置票（类 W4-PRE-1：持久化 resolver 决策事件，runtime 语义变更、独立完成门）后 ⑥ 类才含失败解释。本锁不授权 (b) 的 runtime |
| OD-W5-3 | **账务/规则 policy 变更的追溯语义** | 活体无版本化（§1 总括）。(a) v1 如实 `current_live_no_history` + 快照引用（本合同现拟，零 schema 变更）；(b) 立策略版本化前置票（schema 变更，波及 settings 单键与多张规则表）；(c) 轻量策略变更审计行（只记 who/when/键名，不版本化值）。(b)(c) 均为独立立项，不入 W5 切片 |
| OD-W5-4 | **写入时 fail-closed 不留痕** | `OVERTIME_SEGMENTATION_UNRESOLVED`/`OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED`/`OVERTIME_BANK_CAP_EXCEEDED` 及池空均 422 抛出不落库——被拒的分段/入池尝试日后无迹。(a) v1 恒 `undeterminable`（本合同现拟）；(b) 立「被拒决策事件」持久化前置票（新写路径） |
| OD-W5-5 | **balance_events FK CASCADE 非删除免疫** | lot 删除连带抹流水（`zzzz20260603120000:63`）。(a) v1 仅在合同/文案注明边界（本合同现拟 §3.3⑤E2）；(b) 立独立修复票（对照 `attendance_record_result_edits` 无-FK 的删除免疫姿态）。(b) 是 schema 变更，独立立项 |
| OD-W5-6 | **周期结算快照读面** | settlements 有冻结快照无读 API（smoke 自证「NO API read surface until the v1-5d read exit lands」）。(a) 入 W5-0 作第七只读面（体量+1，但「must-pay 口径」唯一可引真源）；(b) defer 至具名 v1-5d read exit 独立票，v1 结算环恒 `undeterminable` |
| OD-W5-7 | **comp_time 余额 UI 硬编码 annual** | 三处 `leaveTypeCode='annual'`（`AttendanceView.vue:24106/:24155/:24435`）使 comp_time 解释有 API 无 UI。(a) W5-1 顺带参数化（碰热文件既有区块，扩大 W5-1 diff）；(b) 独立小票（热文件串行排队）。二者均不改后端 |
| OD-W5-8 | **状态类规则快照缺失** | record 不落规则 provenance（§1-1）。(a) v1 接受 `current_live_no_history` 口径（本合同现拟）；(b) 立前置票给 `upsertAttendanceRecord` 冻结规则快照（写路径变更 + 存量行永远无快照的双轨现实）。(b) 不入 W5 切片 |
| OD-W5-9 | **lot 读投影补 `overtime_source`** | 列在库（`zzzz20260624160000:13`）不在读投影（`:42739-42744`）。(a) W5-0 内把该列纳入 trace/L5a 读投影（只读 SELECT 加列 + 响应键集合变更 + 脱敏审查）；(b) 保持现状，per-source 环恒 `undeterminable`。(a) 是既有端点响应形状变更，需兼容性回归（章程红线 5） |

## 9. 切片（严格串行——章程 L364 交付顺序逐字「先只读决策轨迹，再上下文帮助」；每片完成门 =
章程 §8.1 十一门 + 本锁红线负向断言 + Opus 对抗审 0 P1/P2 + PR 门禁记录）

- **W5-0 数据合同 runtime**：六类只读 trace 端点（宿主按 OD-W5-1 裁决）+ result-edits 只读历史读面
  + 契约/判别矩阵测试。**W5-0 无 UI：三视口门 N/A**（W4-0 先例）。专项门：
  - **W5-0-G1 断环矩阵**：每类 ≥1 个「依据链断环 ⇒ 该环 `undeterminable`」真库负例（④无快照 org /
    ②legacy 无 tier keys / ③absent 无来源 / ⑤per-source 缺投影（若 OD-W5-9=(b)）/ ⑥失败历史）；
    断言精确形状（deepEqual 整链），**绝不**存在性糊弄。
  - **W5-0-G2 values-free/脱敏**：响应键集合恒等锁定 + §5.1 禁字段零出现（managerChainIds/
    ip_address/user_agent/env 名/裸链条 id）+ SQL 无标识列断言（S7-5 同型）。mutation 目标：把 ⑥类
    改为透传 requester 整包 ⇒ 契约测试精确红。
  - **W5-0-G3 只读结构约束**：`READ ONLY` 事务 + writable CTE 必拒 + 多语句串必拒（W4-0-G2 三条
    同型）；负向元断言：禁首词/正则式只读校验。
  - **W5-0-G4 enum-strict**：category/posture/confidence 闭集穷尽断言 + 请求侧非法 category 4xx
    负例 + 响应侧未知 posture 不可构造（类型 + 测试双锁）；静默 fallback ⇒ 红。
  - **W5-0-G5 `not_in_effect` ≠ `undeterminable`**：dormant org（引擎 OFF）⇒ `not_in_effect` 正控；
    快照缺失 org ⇒ `undeterminable` 正控；mutation：把二者判别合并 ⇒ 两腿各自红。
  - **W5-0-G6 快照优先 + 禁反推**：正控——改动活体 `attendance_overtime_rules` 行后，已终审请求的
    trace 快照环 byte-stable；mutation——把 ④E1 改为按现行规则表重算 ⇒ 契约测试红（「策略变更不
    影响既往事实」的可执行化）。
  - 真库用例进既有 attendance integration gate 所在文件；fixture ID 文件级命名空间（共库并跑纪律）。
- **W5-1 AttendanceDecisionTrace.vue 展示**：纯模块 + 组件 + AttendanceView 接线（单热文件串行）+
  guard 接线（run-list + 双 path filter + 收集证明 + 同命令 mutation）。专项门：判别矩阵全行单测；
  文案负向断言——未知 kind/posture **零 `JSON.stringify`** 输出、`undeterminable` 显示含
  「无法确定依据」逐字、`not_in_effect` 文案不含「无法确定」、`current_live_no_history` 显示含
  「当前规则（无历史版本）」逐字且不得出现在「当时依据」位置；时间线以 approval_records 为源的
  负向断言（mutation：改从 assignments 读时间线 ⇒ 红）；三视口证据（1440/1024/390）。
- **W5-2 上下文帮助**：§4.6 四类页内帮助 + 「查看计算依据/审计记录」深链至 trace。专项门：帮助
  内容 values-free 断言（L225 清单逐项零出现）；不复制手册（无长文粘贴，仅任务上下文条目）；
  深链 query 形（禁 hash，W4-R2 同款）；三视口。

## 10. 完成定义与 ratify 流程

**完成定义**：三切片全合 + 每片验证 MD 在 main + 红线四条各有存活的负向断言 + 章程 §9「解释完整性」
指标（L427）以合成 org 实测记录（六类各至少一条 grounded 解释 + 一条 undeterminable fail-closed
展示，均截图 + DOM 断言）。本锁不改变：S7 flag / scheduler env / 各引擎默认 OFF 的 operator 项
（解释面把「关闭」如实呈现为 `not_in_effect`，不以任何形式促发开启）。

**Ratify 流程（严格顺序）**：
① 本锁 PR 合入（docs-only，PROPOSED 入仓——合入**不等于**生效）
→ ② owner 审阅：核对 §0 红线转写、§3 合同、§5 遮罩清单，并逐项裁决 OD-W5-1..9（记录于 ratify
comment 或修订入锁）；同时确认 W4 收口态势（§ header）是否构成 W5-0 前置余项
→ ③ owner 终裁 comment = PROPOSED → RATIFIED 的唯一生效凭据（模型不得代翻——章程 §10-Owner 条款）
→ ④ 章程 §15 Wave 5 行同步（DATA-CONTRACT-GATED → 设计已 ratify / runtime 未开始；随 ratify 批次
或 W5-0 PR 同批）
→ ⑤ 之后才从当时最新 main 开 W5-0（开工前按 §11.1 纪律重验锚点 + 重跑查重）。

## §11.1 六项记录（章程 L459-468）

1. **基线 SHA**：锚点基线 = `bbcb8caf3`（`origin/main`，2026-07-21，= W4-2 #4543 合入点；本文全部
   `file:line` 对其实证）。本锁分支基 = `f55d99e12`（#4544，W4 波次验证 MD）；漂移账
   `bbcb8caf3..f55d99e12` = 仅 +1 docs 文件（`git diff --stat` 实证），考勤 runtime 零漂移 ⇒ 锚点
   在分支基上全数有效。锚点作业方式：账务两类与审批/横切的锚点由三车道只读调研产出并经本锁作者
   抽样复开核验；状态三类（今日状态/迟到早退/缺卡）锚点由本锁作者对 `bbcb8caf3` 直接逐条开出。
2. **查重**（对 `bbcb8caf3` 实跑）：
   - 全树 grep `AttendanceDecisionTrace` ⇒ 唯一命中 = 章程 L265 组件表行（代码/测试/route 0 命中）；
   - 全树 grep 「无法确定依据」⇒ 代码 0 命中（仅章程 L368）；
   - `docs/development/` 无任何 wave5/explainability 锁（`git ls-tree` 实证）；分支/提交查重
     `w5|explain` ⇒ 无同题在飞分支或 PR；
   - 相邻不重复面：L5a leave-balances 读面（余额可解释先例，§7 边界）、setup-readiness（配置完备度，
     §7 边界）、anomalies owed-punch 归因（③类词表来源）——均为复用对象非重复建设。
3. **修改文件**：本锁 PR 仅本文档一份（docs-only）。未来切片碰撞车道：W5-0 =
   `attendance-admin.ts` + core-backend 测试；W5-1 = `AttendanceView.vue`（**单热文件串行**，章程
   红线 10）+ `views/attendance/` 新组件与纯模块 + `attendance-web-guard.yml`；W5-2 = 同 W5-1 车道。
4. **IN/OUT**：§2（版本化/持久化/schema 变更全部 OUT，经 OD 呈 owner）。
5. **权威数据源/唯一写路径/权限真源**：trace 真源 = §3.3 逐类点名的快照/台账/审计表（决策时快照
   优先，活体规则仅 `current_live_no_history`）；解释面**零写路径**（R1）；权限真源 = core-backend
   router 级 rbacGuard（`attendance-admin.ts:492`）+ `user_orgs` org 门（`:383-407` 先例）/ self 面
   token-subject-locked（`index.cjs:42809-42831` 先例）——受 OD-W5-1 挂载裁决约束。
6. **完成门与 mutation 目标**：§9 各片列出（W5-0-G1..G6 + W5-1/W5-2 专项门）；每片 Opus 对抗审
   0 P1/P2 必过；guard 接线含收集证明与同命令 mutation。
