# 无今日考勤行时禁止历史回退充当今日 — design — 2026-09-23

Issues: #5986（今日时间线 / 打卡状态）、#5990（请假 / 加班 / 补卡预填日期）。
对照 design-lock `attendance-employee-overview-task-first-design-lock-20260716.md` §4.1。

## Problem

`activeWorkbenchRecord` 在当日没有 `attendance_records` 行时回退到区间内 `work_date` 最新的一条。该行被当成：

- `heroTodayTimeline`，进而驱动时钟文案（已上班 / 已下班）和上班/下班 CTA 强调
- 今日状态 chip、工时、迟到早退
- 专用四卡 `prepareRequestDraft` / 补卡 fallback 的 `workDate`

请假和加班卡不展示工作日期。全天/半天 preset 会把开始/结束钉在该历史日上，提交 `POST /api/attendance/requests` 的 `workDate` 因此可能是昨日。

## Intended behavior

- 今日时间线、时钟、punch emphasis、今日状态 chip / 工时 / 迟到早退只读当前会话本人 `work_date === todayWorkDateKey`（规则时区）的行。读取成功并确认没有该行时，时间线为空，时钟为「尚未上班」，CTA 强调上班打卡。
- 2026-10-09 补齐：历史查询必须为同会话组织、本人、包含今日的第一页，并且有精确今日行或完整结果，才能复用；否则使用既有 records 接口单独读取本人今日（pageSize=1），显式携带不可变会话组织，不携带可编辑的历史目标用户。用户已选择的历史范围和分页不变。
- 今日读取中、失败、规则时区缺失/非法或会话失效时显示明确的未知状态，不把它视为未打卡，不强调任一 CTA；实际打卡按钮禁用合同不变。规则时区跨午夜立即失效并重读今日，旧日期/会话响应不得覆盖当前状态。
- 昨日未下班不改变上述今日打卡态。欠卡仍走已有异常/待办，不把历史 `first_in_at` 强调成今日下班。
- 请假、加班、换班打开时 `requestForm.workDate = todayWorkDateKey`。补卡仅在存在合格异常时用 `anomaly.workDate`；否则 fallback 也是 `todayWorkDateKey`。
- 默认历史区间 `from`/`to` 若仍是浏览器本地初始化值，且规则时区今日落在区间外，把区间扩到包含该今日键后再拉记录。用户已改过的区间不动。
- 历史记录仍可出现在记录表等历史面。本切片不新增「最近工作日」摘要；今日带不再借用它。

## Non-goals

- 不改打卡写路径（仍是 `POST /api/attendance/punch`）。
- 不改四卡 IA、互斥开关、或异常优先的补卡预填规则。
- 不把历史缺卡合成新的 anomaly。
- 不改审批、余额折天（#5969）、或 #5573 的 first_in/last_out 极性。

## File touch list

- `apps/web/src/views/attendance/attendanceTodayWorkbench.ts` — 今日行选择、今日时间线、申请默认日、默认区间对齐（纯函数）
- `apps/web/src/views/AttendanceView.vue` — 去掉历史回退；独立本人今日读取；四卡默认日；区间默认对齐
- `apps/web/src/views/attendance/AttendanceEmployeeWorkspace.vue` — 未知状态展示（可选 prop，既有消费者默认已就绪）
- `apps/web/tests/attendanceTodayWorkbench.spec.ts`
- `apps/web/tests/attendanceEmployeeWorkspacePresentation.spec.ts`
- `apps/web/tests/attendance-selfservice-dashboard.spec.ts`
- 本设计；本次验证记录由 2026-10-09 QA 修复交付文档统一收录

## Acceptance

- 无今日行 + 昨日完整成对 → 时钟「尚未上班」；强调上班；今日时间线不出现昨日上下班时刻。
- 无今日行 + 昨日未下班 → 仍「尚未上班」、不强调今日下班；若有异常，待办仍是异常。
- 无今日行打开请假 → preset 的 datetime 前缀与提交 `workDate` 均为 `todayWorkDateKey`。加班打开后 `workDate` 同样是今日键。
- 补卡无合格异常 → fallback 为今日键；有合格异常 → 仍用 `anomaly.workDate`。
- 浏览器本地日早于规则时区今日、且区间仍是默认值 → `toDate` 含规则时区今日。
- 用户历史区间不含今日，但本人今日已上班 / 已下班 → 显示真实今日状态，历史筛选不变；非默认组织和历史他人选择不得污染本人今日读取。
- 今日读取失败 → 明示无法读取；刷新恢复。跨午夜 → 不展示昨日记录，晚到昨日响应不得覆盖新一天。无效规则时区 → 不发猜测日期的今日请求。
