# 节假日覆盖模板使用说明

日期：2026-02-04

## 目的
将“节假日首日/节假日天数补贴”“按实际出勤”“特定人群补贴”等规则配置化，避免写死在业务代码里。  
覆盖规则按照 **先匹配先应用** 生效（更具体的规则放在前面）。

## 配置入口
### 1) UI
`Attendance` → `Holiday policy` → `Holiday overrides`

### 2) API
`PUT /api/attendance/settings`

```json
{
  "holidayPolicy": {
    "firstDayEnabled": true,
    "firstDayBaseHours": 8,
    "overtimeAdds": true,
    "overtimeSource": "approval",
    "overrides": [
      { "name": "春节", "match": "contains", "attendanceGroups": ["单休办公"], "dayIndexStart": 1, "dayIndexEnd": 6, "firstDayBaseHours": 8 }
    ]
  }
}
```

## 覆盖规则字段说明
### 规则本体
- `name`: 节日名称（匹配 `holiday.name`）
- `match`: `contains | exact`
- `firstDayEnabled`: 是否应用节假日基准工时（`false` 表示“按实际出勤”）
- `firstDayBaseHours`: 基准小时数（如 8）
- `overtimeAdds`: 是否叠加加班
- `overtimeSource`: `approval | clock | both`

### 过滤条件（可组合）
- `attendanceGroups`: 考勤组名称列表
- `roles`: 职位名称列表
- `roleTags`: 角色标签列表（来自导入字段或用户档案）
- `userIds`: 用户 ID 列表
- `userNames`: 用户姓名列表
- `excludeUserIds`: 排除用户 ID
- `excludeUserNames`: 排除用户姓名
- `dayIndexStart / dayIndexEnd / dayIndexList`: 节假日第几天生效  
  - 依赖节假日同步 `dayIndex`（例如：`春节-2`）

## 节假日天数与 dayIndex
节假日同步默认来源 `holiday-cn`，同步后会生成如 `春节-2`、`国庆-3` 等名称。  
系统会解析 `dayIndex` 并支持按天数过滤：
- `dayIndexStart=1, dayIndexEnd=6`：前 6 天补贴
- `dayIndexList=[1,2]`：仅第 1、2 天补贴

## 业务配置模板（示例）
> 规则顺序：先例外/特定人群，再覆盖大类。

```json
{
  "holidayPolicy": {
    "firstDayEnabled": true,
    "firstDayBaseHours": 8,
    "overtimeAdds": true,
    "overtimeSource": "approval",
    "overrides": [
      { "name": "春节", "match": "contains", "roles": ["工段长"], "dayIndexStart": 1, "dayIndexEnd": 6, "firstDayBaseHours": 8 },
      { "name": "春节", "match": "contains", "userNames": ["熊洪州"], "dayIndexStart": 1, "dayIndexEnd": 6, "firstDayBaseHours": 8 },
      { "name": "春节", "match": "contains", "attendanceGroups": ["单休办公"], "dayIndexStart": 1, "dayIndexEnd": 6, "firstDayBaseHours": 8 },
      { "name": "春节", "match": "contains", "roles": ["总经理助理","财务部经理","服务测试部经理","技术部经理","人力行政总监","生产部经理","销售部经理","质监部经理"], "dayIndexStart": 1, "dayIndexEnd": 6, "firstDayBaseHours": 8 },
      { "name": "春节", "match": "contains", "attendanceGroups": ["保安"], "firstDayEnabled": false },
      { "name": "春节", "match": "contains", "roles": ["仓库员","下料"], "attendanceGroups": ["单休车间"], "firstDayEnabled": false },
      { "name": "春节", "match": "contains", "attendanceGroups": ["单休车间"], "firstDayEnabled": false }
    ]
  }
}
```

## 数据映射提示
- CSV `考勤组` → `attendanceGroup`
- CSV `职位` → `role`
- CSV `姓名` → `name`

## 常见调整
- **补贴天数**：调整 `dayIndexEnd`（比如 6 天）
- **补贴小时数**：调整 `firstDayBaseHours`（例如 8 或 6）
- **按实际出勤**：设置 `firstDayEnabled=false`
