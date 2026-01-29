# Attendance Custom Rule Templates (Examples)

This document provides ready-to-use examples for the **用户自定义** rule template. Copy any rule into your custom template and adjust the wording or thresholds as needed.

> Notes
> - These examples are **not** enabled by default.
> - All rules are opt-in: paste into `engine.templates[].rules` under `用户自定义`.
> - Avoid naming conflicts by keeping `id` unique.

## 1) Role-based short shift
```json
{
  "id": "role_short_hours",
  "when": { "role_tags_contains": "driver" },
  "then": {
    "actual_hours": 6,
    "warning": "司机短班",
    "reason": "Role-based adjustment"
  }
}
```

## 2) Missing checkout warning
```json
{
  "id": "missing_checkout",
  "when": { "clockIn1_exists": true, "clockOut1_exists": false },
  "then": { "warning": "缺少下班卡" }
}
```

## 3) Trip + overtime conflict
```json
{
  "id": "trip_overtime_conflict",
  "when": { "exceptionReason_contains": "出差", "overtime_hours_gt": 0 },
  "then": { "warning": "出差同时存在加班，请核对" }
}
```

## 4) Rest day punch overtime
```json
{
  "id": "rest_day_punch",
  "when": { "shift_contains": "休息", "has_punch": true },
  "then": { "reason": "休息日打卡", "overtime_hours": 8 }
}
```

## 5) Leave but still punched
```json
{
  "id": "leave_with_punch",
  "when": { "leave_hours_gt": 0, "has_punch": true },
  "then": { "warning": "请假但仍有打卡记录" }
}
```

## Suggested Usage
- Place these under `engine.templates` → `用户自定义` → `rules`.
- Use **Rule Preview (Engine)** to validate effects before saving.
