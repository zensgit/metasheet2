# 无今日考勤行时禁止历史回退充当今日 — verification — 2026-09-23

Design: `attendance-no-historical-today-fallback-design-20260923.md`.
Issues: #5986, #5990.

## Repro (before)

规则时区下昨日有 `attendance_records` 行、今日没有。员工总览把该历史行的 `first_in_at` / `last_out_at` / `status` 填进今日时间线，时钟显示已上班或已下班，CTA 强调随之偏移。打开请假/加班/补卡时 `requestForm.workDate` 预填为该历史 `work_date`。

## Acceptance checklist

- [x] 无今日行 + 昨日完整成对 → 时钟「尚未上班」（en: Not clocked in yet）；强调上班打卡；今日时间线不含昨日时刻。
- [x] 无今日行 + 昨日未下班 → 仍「尚未上班」，不强调今日下班；异常待办仍为 anomaly。
- [x] 无今日行打开请假 → 全天 preset 的开始/结束前缀为规则时区今日；提交 payload `workDate` 为今日。
- [x] 无今日行打开加班 → `requestForm.workDate` 为今日；提交 payload `workDate` 为今日。
- [x] 补卡无合格异常（仅 pending）→ fallback 为今日，不是历史 `work_date`。
- [x] 补卡有合格异常 → 仍用 `anomaly.workDate`。
- [x] 浏览器本地日早于规则时区今日、区间仍是默认值 → `toDate` 含规则时区今日。
- [x] 有今日行时，今日时间线仍显示当日上下班时刻（既有 harness 未改语义）。

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendanceTodayWorkbench.spec.ts \
  tests/attendanceEmployeeWorkspacePresentation.spec.ts \
  tests/attendance-selfservice-dashboard.spec.ts
```

2026-09-23 结果：3 files, 116 tests passed（`attendanceTodayWorkbench` 7、`attendanceEmployeeWorkspacePresentation` 19、`attendance-selfservice-dashboard` 90）。

未对真实客户数据或外部系统写回做浏览器联调。上述 harness 挂载真实 `AttendanceView` / `AttendanceEmployeeWorkspace` 并点击四卡。
