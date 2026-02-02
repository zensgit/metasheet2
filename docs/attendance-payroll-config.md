# 计薪周期配置说明（参考）

日期：2026-02-02

## 目标
支持“模板自动生成 + 手工调整”，并允许按组织/考勤组/个人覆盖。

## 配置层级（优先级）
个人 > 考勤组 > 组织 > 系统默认

## 模板字段
- `name`: 模板名称
- `timezone`: 时区
- `startDay`: 周期起始日（1-31）
- `endDay`: 周期结束日（1-31）
- `endMonthOffset`: 跨月偏移（0 或 1）
- `autoGenerate`: 是否允许自动生成
- `isDefault`: 组织默认模板
- `config`: 扩展配置（见下）

## config.runPolicy（发薪/结算策略）
```json
{
  "runDay": 3,
  "runTime": "10:00",
  "deferOnHoliday": true,
  "deferToNextWorkday": true
}
```

## config.overrides（覆盖策略）
```json
{
  "overrides": [
    {
      "scope": "attendance_group",
      "match": { "contains": "单休车间" },
      "templateName": "CN Payroll 26-25"
    },
    {
      "scope": "user",
      "match": { "userIds": ["<user-id>"] },
      "templateName": "CN Payroll 26-25"
    }
  ]
}
```

## 参考模板：月度 26-25
```json
{
  "name": "CN Payroll 26-25",
  "timezone": "Asia/Shanghai",
  "startDay": 26,
  "endDay": 25,
  "endMonthOffset": 1,
  "autoGenerate": true,
  "isDefault": true,
  "config": {
    "runPolicy": {
      "runDay": 3,
      "runTime": "10:00",
      "deferOnHoliday": true,
      "deferToNextWorkday": true
    },
    "overrides": [
      {
        "scope": "attendance_group",
        "match": { "contains": "单休车间" },
        "templateName": "CN Payroll 26-25"
      }
    ]
  }
}
```

