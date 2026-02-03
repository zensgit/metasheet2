# 考勤 CSV 导入与班次映射 - 开发报告

日期：2026-02-03

## 范围
- 使用钉钉 CSV（日汇总）全量导入（2025-12-01 ~ 2025-12-31）。
- 补充班次映射：保安“自由工时”默认 08:00-17:00。
- 收紧单休车间默认班次映射：仅当班次名包含时间段时才套用 08:00-17:00。

## 关键改动
- 规则集 `考勤规则-正式`：
  - 新增 `security-free-shift-8-17`：`shiftName=自由工时` 且 `attendance_group=保安` → 08:00-17:00。
  - 更新 `single-rest-workshop-8-17`：要求 `shiftName` 包含 `:`，避免“休息”班次被误映射。

## 导入执行
- CSV 源文件：
  - `/Users/huazhou/Downloads/浙江亚光科技股份有限公司_每日汇总（新）_20251201-20251231(2) (1).csv`
- 使用映射模板：`dingtalk_csv_daily_summary`
- 规则集：`考勤规则-正式`（`ruleSetId=17d94f20-9c2a-479d-ad65-35d08ab85f0f`）
- 说明：导入过程触发网关 504，但后台仍完成写入（以批次记录为准）。

## 相关接口
- `POST /api/attendance/import/prepare`
- `POST /api/attendance/import/preview`
- `POST /api/attendance/import/commit`
- `GET /api/attendance/import/batches`
- `PUT /api/attendance/rule-sets/:id`
