# DingTalk Attendance Rules Plan (System vs. User Config)

## Scope
This plan maps the rules found in `新建 文本文档 (2)(1).txt` to our attendance framework, and classifies which rules should be built-in system capabilities vs. org/user-configurable policies.

## Inputs We Will Support
- **DingTalk attendance report columns** (IDs → semantic fields).
- **DingTalk approvals** (process instances for overtime/leave/travel/etc.).
- **Holidays** (external list / DingTalk YiDa form).
- **User/Dept/Role metadata** (DingTalk roles + internal directory mapping).

## Canonical Attendance Data (System Model)
- **Events**: raw check-in/out timestamps
- **Records**: daily summarized attendance
- **Requests**: leave / overtime / adjustment
- **Approvals**: approval state + time range
- **Calendars**: shifts, rotations, holidays
- **Payroll Cycles**: monthly or custom cycle

## Classification: Built-in vs. User Config

### A) Built-in System Capabilities (Generic)
These are core engine behaviors that should work for any org, with parameters:
1. **Time parsing & normalization** (timezone, date boundaries, rounding).
2. **Shift / rotation / holiday calendar evaluation**.
3. **Basic metrics** (work minutes, late minutes, early leave minutes, absence minutes).
4. **Approval ingestion + status tracking** (approve/reject/cancel/withdraw).
5. **Overtime calculation framework** (range-based, type-based, rounding, min/max).
6. **Leave calculation framework** (per-day minutes, approved hours, deduct logic).
7. **Payroll cycle engine** (start/end day, month offset, auto-generate, manual override).
8. **Warning/validation hooks** (collect warnings, export them).
9. **Mapping framework** from DingTalk columns → internal fields.

### B) Org/Role/Dept Configurable Policies (User-defined)
These are **rules that vary by company** and must be configurable (no hard-coding):
1. **Role-based overrides**
   - Example: 保安每天默认 8 小时；司机休息日打一次卡算 8 小时加班。
2. **Group/shift-specific overrides**
   - Example: 单休车间 + 休息 + 出差 = 8 小时加班。
3. **Holiday behavior**
   - Example: 节假日出勤默认 8 小时；节假日保安算加班。
4. **Overtime vs punch reconciliation**
   - Example: 下班打卡早于加班结束，按半小时扣减。
   - Example: 多张加班单合并、重叠检测。
5. **Department-specific exceptions**
   - Example: 国内销售 / 服务测试部-调试例外提醒规则。
6. **Special user overrides**
   - Example: 特定人员（userId 固定）特殊工时逻辑。
7. **Warnings vs. Auto-fix**
   - Example: “休息并打卡但没有加班单”只提示，不直接改工时。

## Mapping These Rules to Our Framework

### 1) Rule Set Config (Existing)
We already have `ruleSet.config` with:
- `rule`: base working hours, grace, rounding, working days
- `mappings`: column field mapping
- `approvals`: process codes
- `payroll`: cycle mode + template

**Extend** `ruleSet.config` with a `policies` block:
```json
{
  "policies": {
    "roleOverrides": [
      { "role": "security", "workHours": 8, "appliesOn": "all" }
    ],
    "deptOverrides": [
      { "dept": "单休车间", "shift": "休息", "ifApprovalContains": "出差", "overtimeHours": 8 }
    ],
    "holidayRules": { "defaultWorkHours": 8, "securityOvertime": 8 },
    "overtimeAdjust": { "roundingMinutes": 30, "earlyLeavePenalty": true },
    "warnings": [
      { "if": "restDayPunchNoOvertime", "level": "warn" }
    ]
  }
}
```

### 2) Policy Engine (New)
Add a **generic policy evaluator**:
- **Input**: daily record + approvals + role/department + holiday info
- **Output**: adjusted hours + warnings

We should implement a minimal DSL or JSON rule evaluation with:
- `when` conditions (shift, role, dept, approval type, holiday, etc.)
- `then` actions (set hours, add warning, mark overtime)

### 3) Warning/Validation Layer
Keep warnings **separate** from “auto correction.”
- Must be configurable (some orgs want strict auto-fix; others only warn).

### 4) Payroll Cycle Support (Already Implemented)
- **Cross-month cycles** supported via template:
  - startDay = 26
  - endDay = 6
  - endMonthOffset = 1
- Manual cycles should remain supported with overrides.

## Rule Inventory From `新建 文本文档 (2)(1).txt` (Extracted)
This list highlights concrete rules found in the file and shows **where they belong**.

| Rule (Summary) | Where It Belongs | Notes |
| --- | --- | --- |
| Backup existing month data, then re-run clean | System | Data hygiene / batch pipeline behavior. |
| Build overtime map from DingTalk approvals | System + Config | System capability; process codes and field IDs are config. |
| Holiday list sourced from DingTalk YiDa form | System + Config | System capability; data source/app/form IDs are config. |
| Security staff daily attendance = 8 hours | Config | Role-based override. |
| Driver rest day + any punch = 8 hours overtime | Config | Role-based override. |
| 单休车间 + 休息 + 出差审批 → default 8 hours overtime | Config | Group/shift specific. |
| Holiday day: entry after holiday → set hours 0 | Config | HR policy. |
| Holiday day: resigned before workdate → set hours 0 | Config | HR policy. |
| Holiday day: active employee → required/actual = 8 hours | Config | HR policy. |
| Holiday day + security staff punching → overtime +8 | Config | Role-based policy. |
| Special userId (16256197521696414) 10/10.5-hour rule | Config | User override. |
| Overtime approval vs punch reconciliation | System + Config | Engine is system; rounding thresholds and penalties are config. |
| Multi-approval merge + overlap detection | System + Config | Engine is system; handling strategy is config. |
| Approval exists but no punches → overtime = 0 | Config | Company policy. |
| Overtime > 15 hours special handling | Config | Thresholds are company policy. |
| Night overtime (“通宵单”) → set attendance hours to 0 | Config | Policy decision. |
| Warnings for mismatched approvals vs punches | System + Config | Warning engine is system; rules are config. |
| Leave + overtime + travel conflict warnings | Config | Policy decision. |
| Dept exceptions (国内销售 / 服务测试部-调试) | Config | Department policy. |

## Decision Summary
**System built-in** should provide: data ingestion, mapping, approvals ingestion, holiday/calendar support, payroll cycle engine, rule evaluation engine, and warning collection.  
**User-configurable** should cover: roles/departments, shift-specific overrides, thresholds, special user rules, approval labels, and warning policy choices.

## Policy Template
We provide a starter policy config you can copy and customize:
- `docs/attendance-dingtalk-policies-template.json`
- `docs/attendance-dingtalk-rule-set-config.json` (full rule-set config with mappings + policies)

Notes:
- `attendance_group` is expected from your CSV (you said the CSV contains it), so it is mapped but **rules using it are disabled by default**.
- Optional rules are kept under `policies.disabledRules`. To enable, move them into `policies.rules` and fill in userIds.
- From your CSV headers, the actual column name is **`考勤组`** (daily summary CSV line 3). The template now maps both `attendance_group` and `考勤组` to `attendanceGroup`.

## Implementation Steps
1. **Normalize DingTalk mapping** to canonical fields (we already have mappings table).
2. **Store rule set policies** in `attendance_rule_sets.config`.
3. **Implement policy evaluation module**
   - role/department overrides
   - overtime reconciliation policies
   - holiday defaults
   - warning rules
4. **UI support** for editing policies (JSON editor + templates).
5. **Validation tests**: rule-set preview + payroll cycle summary + export.

## Recommendation
- **System built-in**: generic attendance engine + mapping + payroll engine.
- **User-configurable**: all company-specific logic (roles, departments, special userId, overtime rounding thresholds, warning behaviors).
- This keeps the plugin reusable across different orgs while preserving unique business rules.
