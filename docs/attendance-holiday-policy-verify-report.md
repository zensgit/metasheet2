# 考勤节假日策略与规则引擎 - 验证报告

日期：2026-02-04

## 环境
- Web：`http://142.171.239.56:8081`
- API：`http://142.171.239.56:8081/api`

## 验证步骤
1. UI 进入 `Attendance` 页面，刷新规则集列表。
2. 打开默认规则集 `考勤规则-正式`，确认规则中包含模板 `节假日首日基准工时`。
3. 读取系统配置（API）：确认节假日同步与策略字段存在。
4. 在设置中添加节日覆盖项（如 “春节”），包含考勤组/角色/天数过滤，确认保存后回读成功。
5. 调用导入预览接口：班次包含时间段时，验证 `earlyLeaveMinutes = 0` 且状态为正常（工作日场景）。
6. 调整覆盖项 `dayIndexList` 或 `dayIndexStart/End`，验证覆盖项仅在指定节日天数生效。

## 结果
- UI：规则集包含 `节假日首日基准工时` ✅
- API：`holidayPolicy` 与 `holidaySync` 配置字段可读 ✅
- API：`holidayPolicy.overrides` 可读且可写（含过滤字段） ✅
- 规则引擎：`holiday_policy_enabled` 可用于跳过模板 ✅
- 导入预览：班次时间优先级生效，半日班次不再被 `shiftMappings` 误判早退 ✅

## 覆盖项验证记录
- `PUT /api/attendance/settings` 设置覆盖项：
  - `name=春节` / `match=contains` / `firstDayBaseHours=6`
  - `roles=[司机]` / `dayIndexList=[1,2]`
  - `GET /api/attendance/settings` 回读：覆盖项存在且值一致 ✅

## 备注
- 本次验收未运行自动化测试，仅进行 UI 与 API 级别核验。
- 已补充导入预览验证（`/api/attendance/import/preview`）。
- 如需回归验证：建议补充 import 提交与批处理规则验证。
