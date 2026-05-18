# 考勤薪资周期汇总字段模板前端配置器验证记录

Date: 2026-05-18

## Verification Matrix

| Check | Result |
| --- | --- |
| Frontend targeted specs | PASS: `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminPayroll.spec.ts tests/AttendancePayrollAdminSection.spec.ts --watch=false`，10 tests |
| Web type-check | PASS: `pnpm --filter @metasheet/web type-check` |
| Web build | PASS: `pnpm --filter @metasheet/web build`（Vite 既有大 chunk warning，非阻断） |
| Frontend regression specs | PASS: `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminPayroll.spec.ts tests/AttendancePayrollAdminSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false`，21 tests |
| `git diff --check` | PASS |

## Coverage

- 从 `/api/attendance/report-fields` 加载字段选项时，只接纳 `formulaEnabled=true`、`formulaScope=summary`、未停用且报表可见的公式字段。
- 基础字段选项始终可用，接口失败不会破坏计薪模板基础编辑。
- 保存模板时 UI 选择顺序写入 `config.summaryFields`，并清理旧配置别名，避免同一模板出现双权威。
- 编辑已有模板时能从 `summaryFields` / `summaryFieldCodes` / 对象形式回填已选字段，且 `{ enabled:false }` 项不会回填。
- 抽出组件能渲染字段选项、触发勾选回调，并触发已选字段排序回调。

## Boundaries

- 本轮没有新增 DB migration。
- 本轮没有修改 `attendance_*` 事实源或薪资周期 summary 计算逻辑。
- 本轮没有直接读写 `meta_*`。
- 本轮没有新增后端 API；前端复用既有 `/api/attendance/report-fields` 和薪资模板保存接口。

## Live Evidence

真实 staging 存盘与导出顺序验证待后续凭据/样本模板补跑；本轮不伪造 live 通过。
