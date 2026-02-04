# 考勤 CSV 导入与班次映射 - 开发报告

日期：2026-02-04

## 范围
- 使用钉钉 CSV（日汇总）全量导入（2025-12-01 ~ 2025-12-31）。
- 补充班次映射：保安“自由工时”默认 08:00-17:00。
- 收紧单休车间默认班次映射：仅当班次名包含时间段时才套用 08:00-17:00。
- 新增通用班次映射：`shiftName` 为 “办公职员/车间员工” 时默认 08:00-17:00。
- 回滚旧批次（未绑定规则集）。
- 优化 requiredFields：当班次/考勤结果为“休息”时不再强制上/下班打卡必填。
- 修复 `punchRequiredFields` 在 preview/commit/import/integration 流程中的重复/缺失声明，避免导入 500。
- 放宽打卡必填条件：当状态命中“请假/调休/出差/外出/补卡/旷工”等关键词，或存在有效工时/缺卡字段时，不再强制打卡时间必填。

## 关键改动
- 规则集 `考勤规则-正式`：
  - 新增 `security-free-shift-8-17`：`shiftName=自由工时` 且 `attendance_group=保安` → 08:00-17:00。
  - 更新 `single-rest-workshop-8-17`：要求 `shiftName` 包含 `:`，避免“休息”班次被误映射。
  - 新增 `shiftname-office-8-17`：`shiftName` 含 “办公职员” → 08:00-17:00。
  - 新增 `shiftname-workshop-8-17`：`shiftName` 含 “车间员工” → 08:00-17:00。
  - 新增分组映射：`office-group-单双休/单双休外勤/单休办公/双休-8-17`。

## 导入执行
- CSV 源文件：
  - `/Users/huazhou/Downloads/浙江亚光科技股份有限公司_每日汇总（新）_20251201-20251231(2) (1).csv`
- 使用映射模板：`dingtalk_csv_daily_summary`
- 规则集：`考勤规则-正式`（`ruleSetId=17d94f20-9c2a-479d-ad65-35d08ab85f0f`）
- 说明：导入过程触发网关 504，但后台仍完成写入（以批次记录为准）。
  - 已回滚旧批次：`ff82c0d3-1a7b-4e4c-9de1-9d52f6a9c1b7`。

## 最新验证摘要
- 全量导入批次：`f9356925-f1d1-4942-91c8-ece813c61623`
- 行数：`11966`
- 实际写入 import items：`11777`（跳过 189，明显优于此前 10318）

## 相关接口
- `POST /api/attendance/import/prepare`
- `POST /api/attendance/import/preview`
- `POST /api/attendance/import/commit`
- `GET /api/attendance/import/batches`
- `PUT /api/attendance/rule-sets/:id`
