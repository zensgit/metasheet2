# Attendance Default Field Mappings

Date: 2026-02-02

## Added CSV/Import Mappings
- 考勤组 -> attendance_group / attendanceGroup
- 班次/出勤班次 -> shiftName
- 部门 -> department
- 职位 -> role
- 异常原因 -> exceptionReason
- 关联的审批单 -> attendance_approve / approvalSummary
- 上班1/下班1/上班2/下班2/上班3/下班3 -> firstInAt/lastOutAt/clockIn2/clockOut2/clockIn3/clockOut3
- 迟到分钟 -> lateMinutes
- 早退分钟 -> earlyLeaveMinutes
- 实出勤工时 -> workHours
- 加班小时 -> overtimeHours

## Notes
- These mappings are included in the rule-set template payload (`/api/attendance/rule-sets/template`).
- They improve rule matching for org templates that rely on exceptionReason/department/role/attendance_group.
