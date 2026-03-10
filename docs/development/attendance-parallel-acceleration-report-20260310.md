# Attendance 并行加速开发报告（2026-03-10）

## 本轮目标
- 持续推进 PR #403 的 `zh + 日历 + 门禁契约` 收口，降低生产回归风险。
- 在不影响主工作区大规模脏改动的前提下，使用隔离分支并行完成开发与验证。

## 本轮完成（代码）
- `apps/web/src/views/attendanceCalendarUtils.ts`
  - 新增日历工具函数：`toDateKey/toDateInput/normalizeDateKey/compareDateKeys/getCalendarVisibleRange`
  - 新增格式化函数：`formatCalendarMonthLabel`、`formatLunarDayLabel`
  - 农历默认时区：`Asia/Shanghai`，非法时区自动 fallback。
- `apps/web/src/views/AttendanceView.vue`
  - 接入 `attendanceCalendarUtils`，统一日期/可见区间/农历格式化逻辑。
  - 日历月份标签显式时区策略，减少跨时区显示漂移。
- `scripts/verify-attendance-locale-zh-smoke.mjs`
  - `schemaVersion` 升级为 `3`。
  - 增加壳层 tab 中文校验（`总览/管理中心/流程设计`）。
  - 英文泄漏词表增加 `Overview/Admin Center/Workflow Designer/Desktop recommended/Back to Overview`。
- `scripts/ops/attendance-daily-gate-report.mjs`
  - `schemaVersion>=3` 时，额外要求 `zhLabels.overviewTab/adminTab/workflowTab` 为真。
  - 输出新增 `zhOverviewTab/zhAdminTab/zhWorkflowTab/zhShellTabsChecked`。
- 新增前端测试：
  - `apps/web/tests/attendance-calendar-utils.spec.ts`
  - `apps/web/tests/attendance-experience-zh-tabs.spec.ts`
- 更新验证记录：
  - `docs/development/attendance-p1-zh-calendar-lunar-holiday-verification-20260310.md`

## 本轮验证（本地）
执行目录：`/tmp/metasheet2-pr401-update`

```bash
node --check scripts/verify-attendance-locale-zh-smoke.mjs
node --check scripts/ops/attendance-daily-gate-report.mjs
node --test scripts/ops/attendance-daily-gate-report.test.mjs
scripts/ops/attendance-run-gate-contract-case.sh dashboard
pnpm --filter @metasheet/web exec vitest run \
  tests/attendance-calendar-utils.spec.ts \
  tests/attendance-experience-zh-tabs.spec.ts \
  tests/attendance-experience-mobile-zh.spec.ts \
  tests/attendance-import-preview-regression.spec.ts
pnpm --filter @metasheet/web exec tsc --noEmit
pnpm verify:attendance-zh-copy-contract
```

结果：
- `attendance-daily-gate-report.test.mjs`: PASS（15/15）
- `attendance-run-gate-contract-case.sh dashboard`: PASS
- Web vitest: PASS（4 files / 9 tests）
- `tsc --noEmit`: PASS
- zh copy contract: PASS

## Git 提交（本轮）
- `ffac991f` feat(attendance-zh): harden calendar timezone utils and shell zh checks
- `b1943376` test(attendance): make calendar utils date-normalization assertion timezone-safe
- `281fb549` feat(attendance-gates): require zh shell tab labels in locale schema v3

## CI 进展（PR #403）
- 最新完成批次（全绿，strict enhanced gate 为策略性 skip）：
  - `Attendance Gate Contract Matrix`: `22894284006`
  - `Observability E2E`: `22894283960`
  - `Phase 5 PR Validation`: `22894283963`
  - `Plugin System Tests + coverage`: `22894283998`
- PR 状态：`MERGEABLE`，阻塞项为 `REVIEW_REQUIRED`（需要审批）。

## 生产可部署判断（当前）
- 代码层：本轮改动不涉及破坏性 API/DB 变更，可作为增量上线。
- 上线前建议保持：至少一轮完整 PR checks 绿灯 + 目标环境 smoke（Desktop + Mobile + zh locale）通过。

## 下一并行批次（不依赖本批合并即可继续）
1. GA 侧：触发 `attendance-locale-zh-smoke-prod.yml`（分支）并回填 runId 到 Go/No-Go 文档。
2. 前端侧：补充 `AttendanceWorkflowDesigner` 的 zh 文案契约测试（与 shell tab 契约同级）。
3. 门禁侧：daily dashboard 输出中新增 `schemaVersion` 变更提示，便于跨版本排障。
