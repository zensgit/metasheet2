# 考勤公式依赖图与循环检测开发记录

## Summary

本 slice 落地 P2：在考勤统计字段目录响应中增加只读公式依赖图与循环检测诊断。它用于管理端观察公式引用关系和未来扩展风险，不改变现有 v1 公式执行策略。

当前仍保持：

- 只支持 record-scope 公式。
- 公式字段引用公式字段仍被 validator 拒绝。
- 循环检测只作为只读诊断，不让循环进入 runtime 计算。

## Public Interface

`GET /api/attendance/report-fields` 的 `data.reportFieldConfig` 增加：

```json
{
  "formulaDependencyGraph": {
    "formulaFieldCount": 0,
    "edgeCount": 0,
    "blockedFormulaReferenceCount": 0,
    "hasCycles": false,
    "nodes": [],
    "edges": [],
    "blockedFormulaReferences": [],
    "cycles": []
  }
}
```

字段说明：

- `nodes`: 当前 catalog 中 `formulaEnabled=true` 的公式字段。
- `edges`: 公式字段到引用字段的边，`type` 为 `field` 或 `formula`。
- `blockedFormulaReferences`: `type=formula` 的边；v1 中这些引用仍被阻止。
- `cycles`: 只在公式字段之间做 DFS 检测，形如 `["formula_a", "formula_b", "formula_a"]`。

## Key Changes

- 后端新增 `buildAttendanceReportFormulaDependencyGraph(items)` 纯函数。
- `buildAttendanceReportFieldCatalogResponse()` 与 fallback 均通过 `reportFieldConfig.formulaDependencyGraph` 返回 graph。
- graph 不进入 `buildAttendanceReportFieldConfigFingerprint()`，避免只读诊断改变字段配置 hash。
- 前端 `AttendanceReportFieldsSection.vue` 增加“Formula dependencies”只读摘要面板：
  - 公式字段数。
  - 引用边数。
  - 已阻止公式互引数。
  - 循环状态。
  - 前 10 条依赖边。
- 前端字段过滤开启时隐藏 graph 面板，避免全局依赖摘要污染过滤结果。

## Non-goals

- 不开放公式字段引用公式字段。
- 不实现公式依赖排序执行。
- 不实现周期汇总公式。
- 不新增 DB migration。
- 不直接读写 `meta_*`。

## Files

- `plugins/plugin-attendance/index.cjs`
- `apps/web/src/views/attendance/AttendanceReportFieldsSection.vue`
- `packages/core-backend/tests/unit/attendance-report-field-catalog.test.ts`
- `packages/core-backend/tests/unit/attendance-report-field-formula-engine.test.ts`
- `apps/web/tests/AttendanceReportFieldsSection.spec.ts`
- `docs/development/attendance-dingtalk-formula-todo-20260515.md`
- `docs/development/attendance-formula-dependency-graph-development-20260517.md`
- `docs/development/attendance-formula-dependency-graph-verification-20260517.md`

## Follow-up

- 周期汇总级公式仍独立排期。
- 若未来允许 formula-to-formula，需要单独实现拓扑排序、循环阻断、错误传播和 fingerprint 策略；本 slice 只提供诊断基础。
