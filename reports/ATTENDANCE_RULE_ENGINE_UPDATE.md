# 考勤规则引擎扩展开发与验证报告

日期：2026-01-29

## 开发内容概述
- 扩展规则引擎条件能力：支持 `_contains_any`、`_not_contains`、`_before`、`_gt`、`_lt`、`_ne`，并允许 `_exists: false`。
- 扩展规则引擎事实字段：补充 `approvalSummary/approval`、`role`、`department`、`attendance_group` 等字段来源与兜底。
- 引擎结果去重：`warnings/reasons` 统一去重，避免多模板重复提示。
- 规则模板扩展：新增“通用提醒”模板，补充加班、出差、缺卡/补卡等组合提示；“单休车间规则”新增“休息日打卡但缺少下班卡”。
- API 模板同步：`/api/attendance/rule-sets/template` 引擎模板与示例配置保持一致。

## 规则扩展清单（新增/增强）
**单休车间规则**
- 休息日打卡但缺少下班卡：`exceptionReason_contains + clockIn1_exists + !clockOut1_exists`。

**通用提醒**
- 有加班单但未打卡：`approval_contains: '加班' + has_punch: false`。
- 出差同时存在加班工时：`exceptionReason_contains: '出差' + overtime_hours_gt: 0`。
- 出差且非休息班次、工时不足 8 小时（排除国内销售/服务测试部-调试）：`exceptionReason_contains + shift_not_contains + actual_hours_lt + department_not_contains`。
- 缺卡且补卡但未找到上班 2 打卡：`exceptionReason_contains: ['缺卡','补卡'] + clockIn2_exists: false`。
- 出差+事假/病假/工伤假组合提醒（通用冲突提示）。

## 关键实现点
- 规则条件解析增强：新增时间与数值比较、否定包含、存在性为 false。
- 事实构建补全：`approvalSummary` 与 `approval` 统一入口，便于使用 `approval_contains`。
- 规则效果去重：多模板命中同一提示时仅保留一次。

## 变更文件
- `plugins/plugin-attendance/engine/index.cjs`
- `plugins/plugin-attendance/engine/schema.cjs`
- `plugins/plugin-attendance/engine/sample-config.cjs`
- `plugins/plugin-attendance/index.cjs`

## 验证记录
执行本地引擎快速验证（示例输入含出差/加班/缺卡/补卡）：
```bash
node - <<'NODE'
const { createRuleEngine } = require('./plugins/plugin-attendance/engine/index.cjs')
const config = require('./plugins/plugin-attendance/engine/sample-config.cjs')
const engine = createRuleEngine({ config })
const result = engine.evaluate({
  record: { plan_detail: '白班', approvalSummary: '加班审批通过' },
  profile: { attendanceGroup: '单休车间', roleTags: ['driver'], department: '研发部' },
  calc: { overtime_hours: 2, actual_hours: 6, exceptionReason: '出差;休息并打卡;缺卡;补卡' },
})
console.log(result.appliedRules)
console.log(result.warnings)
NODE
```
结果：成功命中新增规则并返回警告列表（执行无异常）。

## 备注
- 规则模板已同步到 API 模板输出，前端创建规则集时可直接使用。
- 若需进一步细化（如加班单与打卡时间区间核对），建议在规则引擎中扩展时段比较或引入审批明细解析逻辑。
