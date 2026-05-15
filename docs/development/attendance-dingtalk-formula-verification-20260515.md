# 考勤字段公式能力验证记录

Date: 2026-05-15

## Commands Run

```bash
node --check scripts/ops/attendance-report-fields-live-acceptance.mjs
node --check plugins/plugin-attendance/index.cjs
node --test scripts/ops/attendance-report-fields-live-acceptance.test.mjs
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-catalog.test.ts tests/unit/attendance-report-field-formula-engine.test.ts --reporter=dot
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/AttendanceReportFieldsSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false
pnpm run verify:attendance-report-fields:live:test
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/core-backend build
git diff --check
```

## Results

| Check | Result |
| --- | --- |
| Plugin syntax | PASS |
| live acceptance script syntax | PASS |
| live acceptance unit harness | PASS, 17 tests |
| backend catalog/formula unit tests | PASS, 13 tests |
| frontend report fields/admin regression specs | PASS, 14 tests |
| package live harness script | PASS, 17 tests |
| web type-check | PASS |
| core-backend build | PASS |
| git diff whitespace check | PASS |

## Acceptance Focus

- Descriptor 字段稳定，新增公式字段 ID 可重复。
- 六类钉钉统计字段分类仍完整。
- 多维表配置缺失时仍降级到内置字段。
- 公式字段可通过 `{field_code}` 读取系统统计字段。
- `NOW()`、未知字段、公式字段引用公式字段被拒绝。
- 无效公式字段返回 `#ERROR!`，不阻断整行导出。
- 公式表达式变化会改变 report field fingerprint。
- 前端统计字段区域展示公式状态、表达式、引用和错误。
- live acceptance 能验证公式字段进入 catalog、records、export、CSV header。

## Follow-up Notes

- 函数白名单实现已按 P1 范围接入，并已按条件/数学/聚合/日期/文本大类补代表函数测试。
- 钉钉“打卡时间”和“打卡结果”在本轮仍是聚合字段；上班 1/2/3、下班 1/2/3 拆分字段是 P2 follow-up。
- 真实 staging live acceptance 仍是合并前 evidence 待补项，需要真实 staging/local 后端地址和短期 admin JWT 文件。

## Live Environment

真实 live acceptance 需要外部后端地址和短期 admin JWT 文件。本轮默认不伪造真实 live 通过结果；没有凭据时只运行 mock/live harness 单元测试。

本轮未运行真实外部后端 live acceptance，因为当前会话没有提供 staging/local 后端地址与短期 admin JWT 文件。
