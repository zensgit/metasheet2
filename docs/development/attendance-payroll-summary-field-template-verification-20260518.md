# 考勤薪资周期汇总字段模板联动验证记录

Date: 2026-05-18

## Verification Matrix

| Check | Result |
| --- | --- |
| Plugin syntax | PASS: `node --check plugins/plugin-attendance/index.cjs` |
| Backend unit tests | PASS: `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-formula-engine.test.ts tests/unit/attendance-report-field-catalog.test.ts --reporter=dot`，42 tests |
| Frontend regression specs | PASS: `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/AttendanceReportFieldsSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false`，24 tests（Vite WebSocket port-in-use warning 非阻断） |
| Web type-check | PASS: `pnpm --filter @metasheet/web type-check` |
| Core backend build | PASS: `pnpm --filter @metasheet/core-backend build` |
| `git diff --check` | PASS |

## Coverage

- 模板 `summaryFields` 能输出 `period_net_minutes`、`work_duration`、`late_days` 的指定顺序。
- `{ code, enabled:false }` 配置项不会进入输出字段。
- 未知字段与 record-scope 公式字段会进入 `droppedFieldCodes`，不会进入 CSV。
- 未配置字段模板时保持旧行为：默认 summary metrics 仍输出，summary formula 字段继续追加。

## Boundaries

- 本轮没有新增 DB migration。
- 本轮没有直接读写 `meta_*`。
- 本轮没有改变 `attendance_*` 事实源或 summary 计算逻辑。
- 前端模板配置器未实现，作为下一条 PR2。

## Live Evidence

真实 staging 存盘与导出顺序验证待后续凭据/样本模板补跑；本轮不伪造 live 通过。
