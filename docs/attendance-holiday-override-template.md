# 节假日覆盖规则模板（基于 2025-12 CSV 统计）

日期：2026-02-04

## 说明
- 本模板基于 CSV `/Users/huazhou/Downloads/浙江亚光科技股份有限公司_每日汇总（新）_20251201-20251231(2) (1).csv` 自动统计。
- 覆盖规则按 **先匹配先应用** 生效（请把更具体的规则放在前面）。
- 当前覆盖过滤支持：`attendanceGroups / roles / roleTags / userIds / userNames / dayIndexStart / dayIndexEnd / dayIndexList`。
- **暂不支持 department 过滤**（如需部门级过滤，可继续扩展后端逻辑）。

## 候选值（便于拼写一致）

### 考勤组（出现频次 Top）
- 单休车间
- 单双休
- 单双休外勤
- 单休办公
- 保安
- 双休
- 测试

### 高层/管理岗（职位关键词）
- 总经理助理
- 财务部经理
- 服务测试部经理
- 技术部经理
- 人力行政总监
- 生产部经理
- 销售部经理
- 质监部经理

### 仓储相关
- 职位：仓库员、下料
- 考勤组：单休车间
- 人员（样例）：熊洪州（需排除时可用 userNames）

### 保安相关
- 考勤组：保安
- 部门样例：亚光科技-人力行政部-后勤

### 司机
- 职位：司机
- 人员样例：蒋永波

## 推荐覆盖模板（示例）
> 规则顺序：先排除/特殊人群，再覆盖大类。

```json
{
  "holidayPolicy": {
    "firstDayEnabled": true,
    "firstDayBaseHours": 8,
    "overtimeAdds": true,
    "overtimeSource": "approval",
    "overrides": [
      {
        "name": "春节",
        "match": "contains",
        "roles": ["工段长"],
        "dayIndexStart": 1,
        "dayIndexEnd": 6,
        "firstDayBaseHours": 8
      },
      {
        "name": "春节",
        "match": "contains",
        "userNames": ["熊洪州"],
        "dayIndexStart": 1,
        "dayIndexEnd": 6,
        "firstDayBaseHours": 8
      },
      {
        "name": "春节",
        "match": "contains",
        "attendanceGroups": ["单休办公"],
        "dayIndexStart": 1,
        "dayIndexEnd": 6,
        "firstDayBaseHours": 8
      },
      {
        "name": "春节",
        "match": "contains",
        "roles": [
          "总经理助理",
          "财务部经理",
          "服务测试部经理",
          "技术部经理",
          "人力行政总监",
          "生产部经理",
          "销售部经理",
          "质监部经理"
        ],
        "dayIndexStart": 1,
        "dayIndexEnd": 6,
        "firstDayBaseHours": 8
      },
      {
        "name": "春节",
        "match": "contains",
        "attendanceGroups": ["保安"],
        "firstDayEnabled": false
      },
      {
        "name": "春节",
        "match": "contains",
        "roles": ["仓库员", "下料"],
        "attendanceGroups": ["单休车间"],
        "firstDayEnabled": false
      },
      {
        "name": "春节",
        "match": "contains",
        "attendanceGroups": ["单休车间"],
        "firstDayEnabled": false
      }
    ]
  }
}
```

## 使用建议
- **补贴 6 天** 目前建议用 `dayIndexEnd: 6`（可在 UI 中调整天数）。
- “按实际出勤”建议将 `firstDayEnabled=false`，让工时回归打卡计算。
- 若需以部门精确控制（如“仓储”/“食堂”），建议后续扩展覆盖过滤增加 `departments` 字段。
