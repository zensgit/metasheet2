# 考勤 CSV 导入与班次映射 - 验证报告

日期：2026-02-03

## 环境
- Web：`http://142.171.239.56:8081`
- API：`http://142.171.239.56:8081/api`

## 验证步骤
1. 预览导入：`/api/attendance/import/preview` + `mappingProfileId=dingtalk_csv_daily_summary`。
2. 提交导入：`/api/attendance/import/commit`（使用 `commitToken`）。
3. 检查批次：`/api/attendance/import/batches` 确认批次记录存在且 `ruleSetId` 正确。
4. 规则映射验证：使用 `ruleSetId=考勤规则-正式` 预览 `shiftName=自由工时` 的数据，确认不再早退。
5. 规则映射验证：`shiftName=办公职员/车间员工` 预览 `earlyLeaveMinutes=0`。
6. 回滚旧批次（未绑定规则集）。
7. 休息班次验证：`班次=休息` 且缺少打卡时间不再触发 requiredFields。

## 结果
- 导入预览：总行数 `11966`，映射正确 ✅
- 导入批次：新批次 `ruleSetId=17d94f20-9c2a-479d-ad65-35d08ab85f0f`，状态 `committed` ✅
- 跳过行数：`2913`（缺少上/下班打卡时间）⚠️
- 班次映射：`自由工时` 预览 `earlyLeaveMinutes=0`、`status=normal` ✅
- 班次映射：`办公职员/车间员工` 预览 `earlyLeaveMinutes=0` ✅
- 旧批次：`ff82c0d3-1a7b-4e4c-9de1-9d52f6a9c1b7` 已回滚 ✅
- 休息班次：缺卡不再报 requiredFields ✅

## 备注
- 导入提交过程中可能出现 504（网关超时），但批次记录显示后台已完成写入。
- 若需降低跳过率：可放宽 `requiredFields` 或补齐缺失打卡时间字段。
