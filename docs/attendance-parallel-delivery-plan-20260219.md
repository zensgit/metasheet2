# 考勤插件并行开发执行计划（2026-02-19）

## 目标与边界

- 目标：在现有 production-ready v1 的基础上，完成“门禁策略强化 + 导入性能与一致性 + 前端运营可用性”的并行交付闭环。
- 范围：仅限考勤插件（打卡、调整、审批、导入、报表、管理配置）。
- 非范围：Payroll（薪资结算）与 CAD/PLM 深改不在本阶段。

## 并行工作线

- A 线（平台/门禁）：分支保护策略、GA gates、drill/recovery、daily dashboard 映射。
- B 线（后端/导入）：导入任务可观测字段、idempotency/upload 一致性、100k+ 性能路径。
- C 线（前端/体验）：Admin Center/导入链路可恢复交互、移动端降级一致性、Playwright 回归。

## 已完成（本次执行）

### A 线：`1+2` 已落地

1. 分支保护目标策略已应用到 `main`：
   - `required_pull_request_reviews.enabled=true`
   - `required_approving_review_count=1`
   - `require_code_owner_reviews=false`
2. 脚本默认策略升级（避免人工触发时回退）：
   - `scripts/ops/attendance-ensure-branch-protection.sh`
   - `scripts/ops/attendance-check-branch-protection.sh`
3. workflow 默认策略升级：
   - `.github/workflows/attendance-branch-policy-drift-prod.yml`
   - `.github/workflows/attendance-branch-protection-prod.yml`
4. drill/recovery + dashboard 验证：
   - Drill FAIL: run `#22184974691`（Issue `#197` OPEN）
   - Recovery PASS: run `#22185012785`（Issue `#197` CLOSED）
   - Dashboard PASS: run `#22185048468`（`gateFlat.protection.runId=22185012785`）

### B 线：导入任务状态字段扩展（向后兼容）

已实现并验证：

- `POST /api/attendance/import/commit` 响应新增 `engine`（`standard|bulk`）。
- `GET /api/attendance/import/jobs/:id` / async job 映射新增：
  - `engine`
  - `processedRows`
  - `failedRows`
  - `elapsedMs`
- async job payload 追加紧凑 summary 元数据，避免丢失状态字段。
- 集成测试已补断言并通过：
  - `packages/core-backend/tests/integration/attendance-plugin.test.ts`
  - 证据日志：
    - `output/playwright/attendance-next-phase/20260219-221631-import-job-fields/attendance-import-job-fields.log`

## 进行中（D2-D7）

### A 线

- 将 branch policy drift 的 remediation 提示细化为“可直接执行”的操作序列（含 review policy drift 场景）。
- 统一 strict/perf/dashboard artifacts 命名与 summary 字段（减少人工比对成本）。

### B 线

- 导入 100k 基线：
  - 默认走 upload 通道（`csvFileId`）+ async commit。
  - 建立 `100k` 常规基线和 `500k` 回归保护场景。
- COPY/staging 快路径设计评审与落地（50k+ 自动切换，不改变现有 API 语义）。

### C 线

- Admin Center 操作错误分类（权限、限流、token、服务不可用）与可恢复动作统一。
- 导入 UI 的“进度/重试/恢复入口”一致化。
- 移动端 Desktop-only 区域降级文案统一并回归 Playwright。

## Latest Progress (2026-02-20): B/C 并行增量（Import Async Job Telemetry + Recovery UX）

### B 线（后端）

- `plugins/plugin-attendance/index.cjs`
  - `GET /api/attendance/import/jobs/:id` 新增非破坏性字段：
    - `progressPercent`（0-100）
    - `throughputRowsPerSec`（基于 `processedRows/elapsedMs`）
  - 原有字段保持不变：`engine`, `processedRows`, `failedRows`, `elapsedMs`。

### C 线（前端）

- `apps/web/src/views/AttendanceView.vue`
  - Async job 卡片新增可恢复操作：
    - `Reload job`（重新拉取当前 job 状态）
    - `Resume polling`（对 queued/running job 继续轮询）
  - Async job 展示增强：
    - `progressPercent`
    - `processedRows / failedRows`
    - `elapsedMs`
    - `throughputRowsPerSec`
  - 状态错误分类新增 async job 语义码：
    - `IMPORT_JOB_TIMEOUT`
    - `IMPORT_JOB_FAILED`
    - `IMPORT_JOB_CANCELED`
  - 对应状态动作新增：
    - `reload-import-job`（避免超时后误触发重复导入）

### 验证（本地）

- 后端 integration：
  - `pnpm --filter @metasheet/core-backend test:integration:attendance`
  - 结果：PASS（14/14）
- 前端构建：
  - `pnpm --filter @metasheet/web build`
  - 结果：PASS
- 证据目录：
  - `output/playwright/attendance-next-phase/20260220-230856-import-job-ux/backend-attendance-integration.log`
  - `output/playwright/attendance-next-phase/20260220-230856-import-job-ux/web-build.log`

### 下一步（并行）

1. B 线：把 `progressPercent/throughputRowsPerSec` 纳入 perf summary 与 trend report（GA artifacts 可直接观测）。
2. C 线：补 Playwright 用例覆盖“async job timeout -> reload job -> resume polling”恢复链路。
3. A 线：将上述新恢复链路纳入 strict/full-flow 验收脚本并写入 daily handbook。

## Latest Progress (2026-02-20): A/B/C 并线完成（Telemetry 落盘 + Recovery 验收透传）

### A 线（门禁）

- `scripts/ops/attendance-run-gates.sh`
  - 新增 `REQUIRE_IMPORT_JOB_RECOVERY`（默认 `false`）并透传到 desktop full-flow：
    - `ASSERT_IMPORT_JOB_RECOVERY="$REQUIRE_IMPORT_JOB_RECOVERY"`
  - `gate-summary.json` 新增 `requireImportJobRecovery` 字段（布尔）。
- `scripts/ops/attendance-run-strict-gates-twice.sh`
  - 新增同名透传变量，便于 strict twice 启用恢复链路验收。
- `.github/workflows/attendance-strict-gates-prod.yml`
  - 新增 workflow_dispatch input：`require_import_job_recovery`（默认 `false`）。

### B 线（性能与趋势）

- `scripts/ops/attendance-import-perf.mjs`
  - `perf-summary.json` 新增并落盘：
    - `progressPercent`
    - `throughputRowsPerSec`
  - `perfMetrics` 同步新增上述字段。
- `scripts/ops/attendance-import-perf-trend-report.mjs`
  - trend 报表 `Scenario Summary` 新增列：
    - `Latest Progress %`
    - `Latest Throughput`

### C 线（前端恢复链路 + Playwright）

- `apps/web/src/views/AttendanceView.vue`
  - 新增仅测试启用的 debug 配置读取：`localStorage.metasheet_attendance_debug.import.*`
  - 支持测试覆盖：
    - `forceUploadCsv`
    - `forceAsyncImport`
    - `forceTimeoutOnce`
    - `pollIntervalMs`
    - `pollTimeoutMs`
  - `IMPORT_JOB_TIMEOUT` 提示文案明确引导：先 `Reload import job`，再 `Resume polling`。
- `scripts/verify-attendance-full-flow.mjs`
  - 新增 `ASSERT_IMPORT_JOB_RECOVERY=true` 时的桌面端恢复断言：
    - 触发 async preview 超时
    - 点击状态动作 `Reload import job`
    - 点击 async 卡片 `Resume polling`
    - 断言任务进入完成态

### Schema 更新

- `schemas/attendance/strict-gate-summary.schema.json`
  - 追加可选字段：`requireImportJobRecovery:boolean`（兼容 `additionalProperties:false` 约束）。

### 本地验证（PASS）

- Backend integration:
  - `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts`
  - 结果：PASS（14/14）
- Web build:
  - `pnpm --filter @metasheet/web build`
  - 结果：PASS
- Strict gate summary schema:
  - `node scripts/ops/attendance-validate-gate-summary-schema.mjs <tmpdir> 1 schemas/attendance/strict-gate-summary.schema.json`
  - 结果：PASS
- Script syntax:
  - `node --check scripts/verify-attendance-full-flow.mjs`
  - `node --check scripts/ops/attendance-import-perf.mjs`
  - `node --check scripts/ops/attendance-import-perf-trend-report.mjs`
  - 结果：PASS
- Trend report telemetry rendering:
  - `CURRENT_ROOT=<fixture_current> HISTORY_ROOT=<fixture_history> OUTPUT_DIR=<fixture_out> node scripts/ops/attendance-import-perf-trend-report.mjs`
  - 结果：PASS（Markdown 含 `Latest Progress %` / `Latest Throughput` 列）

证据目录：

- `output/playwright/attendance-next-phase/20260220-165421-parallel-abc/backend-attendance-integration.log`
- `output/playwright/attendance-next-phase/20260220-165421-parallel-abc/web-build.log`
- `output/playwright/attendance-next-phase/20260220-165421-parallel-abc/gate-summary-schema.log`
- `output/playwright/attendance-next-phase/20260220-165421-parallel-abc/script-syntax.log`
- `output/playwright/attendance-next-phase/20260220-165421-parallel-abc/perf-trend-report.log`
- `output/playwright/attendance-next-phase/20260220-165421-parallel-abc/trend-report-output/20260220-165716/attendance-import-perf-longrun-trend.md`

## D8-D10 封板标准（Go/No-Go）

- Strict Gates twice 连续 PASS（2 轮）。
- Playwright Desktop + Mobile 连续 PASS（2 轮）。
- Perf baseline（100k, `upload_csv=true`）PASS。
- Perf longrun（upload 路径）PASS。
- 无 open 的 `[Attendance P0]` / `[Attendance P1]` issue。

## 证据目录规范

- 统一落盘：`output/playwright/ga/<runId>/...`
- 本地开发验证：`output/playwright/attendance-next-phase/<timestamp>-*/...`
- 文档中仅记录 runId、issue 链接、evidence 路径；禁止写真实 token/secret。
