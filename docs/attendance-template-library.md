# Attendance Template Library (System Defaults)

Date: 2026-02-02

## Purpose
System templates provide reusable rule patterns for common roles and attendance groups. They are optional and can be extended or overridden by organization templates and user-specific rules.

## Included Templates
- Default (No Overrides): baseline with no rule changes.
- Example: Driver Rest Overtime: rest-day punch -> overtime.
- Security Default Hours (CN): 保安默认 8 小时。
- Security Holiday Overtime (CN): 保安节假日打卡记加班。
- Driver Rest Overtime (CN): 司机休息日打卡记加班。
- Driver Default Hours (CN): 司机工作日默认 8 小时。
- Single Rest Trip Overtime (CN): 单休休息日出差记加班（基于审批摘要字段）。
- Special User Fixed Hours (Placeholder): 特殊人员固定工时示例（需替换 userId）。

## Notes
- Templates operate on the rule engine input fields (`record`, `profile`, `approvals`, `calc`).
- Organization-specific rules (e.g., attendance group names) can be moved into the template library API if needed.
