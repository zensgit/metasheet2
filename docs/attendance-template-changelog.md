# 考勤规则模板变更记录

日期：2026-02-03

## 变更摘要
### 规则模板快照刷新
- 已同步更新 `docs/attendance-template-library.snapshot.json`（含组织模板库最新版本）。

### Org: Single-Rest Trip Overtime
- 目的：细化单休车间休息日出差/外出规则，避免无打卡误判。
- 变更点：
  - approvals 增加“外出”匹配（原仅“出差”）。
  - 增加打卡存在条件（clockIn1 / clockOut1 其一存在）。
  - 描述与 warn 文案同步调整。

### Org: Missing Card Warning
- 新增：缺卡异常提示规则（`calc.exceptionReason` 包含“缺卡”时提示补卡/审批）。

### Org: Late/Early Warning
- 新增：迟到/早退异常提示规则（`calc.exceptionReason` 包含“迟到/早退”时提示确认审批）。

### 验收（全量预览）
- missing-card-warning：178
- late-early-warning：113

### 默认规则集策略调整
- 移除 `holiday-default-8h` 规则，节假日首日基准工时改由 Settings 配置控制（避免写死）。

## 影响
- 组合验收中 `single-rest-trip-overtime` 命中从 29 降至 4（更符合“有出差/外出且有打卡”的规则定义）。
