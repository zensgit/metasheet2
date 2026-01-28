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
