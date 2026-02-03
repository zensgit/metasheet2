# 考勤开发报告

日期：2026-02-02

## 已完成
- 规则引擎与模板库：系统模板 + 组织模板库可配置。
- CSV 字段映射补齐：考勤组/职位/班次/审批/异常原因/多次打卡等字段映射完成。
- 默认 Rule Set 已支持 userGroups 与 userIds（可选覆盖）。
- 司机/保安 userId 已写入默认 Rule Set（司机 1 人；保安 8 人）。
- 规则模板快照已刷新：`docs/attendance-template-library.snapshot.json`
- 计薪周期模板：新增默认模板 “CN Payroll 26-25” 并写入配置参考（见 `docs/attendance-payroll-config.md`）。
- 计薪周期自动生成修复：避免事务因重复周期中断（使用 ON CONFLICT 跳过已存在周期）。

## 关键配置约定
- 判组优先级：默认以“考勤组/职位”为主，userIds 作为兜底覆盖。
- 计薪周期：支持“模板自动生成 + 手工调整”的组合策略。

## 输出物
- `docs/attendance-week-plan.md`
- `docs/attendance-engine-verification.md`
- 组织模板库（已落地在后端配置）

## 已知事项
- 若需要更细粒度职位/班次策略，可继续扩展模板库与规则 DSL。
