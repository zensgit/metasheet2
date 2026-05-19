# 考勤 Period Rollup PR2 验证记录

Date: 2026-05-19

## Scope

验证范围是 period rollup PR2：后端 writer + route + 单测。前端入口、真实 staging live evidence、后台任务队列不在本轮。

## Automated Checks

| Check | Result |
| --- | --- |
| `node --check plugins/plugin-attendance/index.cjs` | PASS |
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-catalog.test.ts tests/unit/attendance-report-field-formula-engine.test.ts --reporter=dot` | PASS, 48 tests |
| `pnpm --filter @metasheet/core-backend build` | PASS |
| `pnpm --filter @metasheet/web type-check` | PASS |
| `git diff --check` | PASS |

## Unit Coverage

新增覆盖：

- period value column helper：
  - summary 默认字段进入 value columns。
  - summary-scope formula 字段进入 managed set。
  - record-scope formula 字段不进入 period managed set。
  - period skeleton 字段不被 value columns 覆盖。
- active value code helper：
  - disabled summary formula 不参与输出，写入时会被 stale-null。
- row key：
  - date range row key：`${orgId}:${userId}:range:${from}:${to}`。
  - payroll cycle row key：`${orgId}:${userId}:cycle:${cycleId}`。
- source fingerprint：
  - 排除 `synced_at`、`source_fingerprint`、`field_fingerprint`。
  - key order 稳定。
- period resolver：
  - `cycleId` + `from/to` 同传返回 400。
  - 缺 period source 返回 400。
  - 非 UUID cycleId 返回 400。
  - 不存在 cycle 返回 404。
  - 有效 cycle 映射为 `payroll_cycle` 与正确 `from/to`。
  - date range 映射为 `date_range` 与稳定 `periodKey`。
- writer：
  - 首次 sync create。
  - 重跑 source + field fingerprint 双等 skip。
  - field fingerprint stale 时 patch。
  - duplicate row_key 计数但不删除。
  - 动态请假 subtype 周期汇总写入非 0 值。
  - disabled managed summary formula 旧值 patch 为 `null`。
  - explicit `userIds` 去重并按用户聚合。

## Boundary Checks

- 不新增 `attendance_*` migration。
- 不迁移 `attendance_records`。
- 不让多维表公式直读 `attendance_*`。
- 不裸写 `meta_*`。
- writer 只写 `attendance_report_period_summaries`。
- daily `attendance_report_records` 代码路径未改。

## Pending

- PR3 前端入口与 staging live evidence。
