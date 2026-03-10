# Attendance 并行加速开发报告（2026-03-10）

## 1. 本轮目标
- 持续推进考勤插件生产化增强，优先补齐门禁合同覆盖与中文/农历 smoke 稳定性。
- 在不阻塞现有并行开发线的前提下，产出可审计证据与可合并 PR。

## 2. 已完成开发项

### 2.1 Daily Dashboard 合同升级（Locale zh 纳入 machine contract）
- 文件：
  - `scripts/ops/attendance-daily-gate-report.mjs`
  - `scripts/ops/attendance-validate-daily-dashboard-json.sh`
  - `scripts/ops/attendance-run-gate-contract-case.sh`
- 关键变更：
  - 增加 `attendance-zh-locale-summary.json` 的解析与 `gateFlat.localeZh` 平铺字段。
  - 新增 locale 失败码：
    - `LOCALE_ZH_SUMMARY_INVALID`
    - `LOCALE_ZH_SUMMARY_MISSING`
  - `gateFlat.schemaVersion` 升级为 `3`。
  - 合同矩阵新增 locale v3 负例：`dashboard.invalid.locale.json`。

### 2.2 文档与证据补齐
- 更新：
  - `docs/development/attendance-p1-zh-calendar-lunar-holiday-verification-20260310.md`
  - `docs/attendance-production-ga-daily-gates-20260209.md`
  - `docs/attendance-production-go-no-go-20260211.md`
- 内容包含：
  - 本地合同验证命令与结果
  - GA runId 与 evidence 路径（不含任何真实 secret）

## 3. PR 与状态

### 3.1 PR #404（历史分支）
- 链接：<https://github.com/zensgit/metasheet2/pull/404>
- 状态：`DIRTY`（存在与 `main` 的冲突，不建议作为最终合并入口）

### 3.2 PR #405（清洁合并分支）
- 链接：<https://github.com/zensgit/metasheet2/pull/405>
- 状态：`BLOCKED`（仅缺 reviewer approval）
- 已通过检查：
  - `pr-validate` PASS（run `22896628960`）
  - `contracts (strict/dashboard/openapi)` PASS（run `22896628962`）

## 4. 验证结果与证据

### 4.1 本地验证（脚本/合同）
```bash
node --check scripts/ops/attendance-daily-gate-report.mjs
bash -n scripts/ops/attendance-validate-daily-dashboard-json.sh
bash -n scripts/ops/attendance-run-gate-contract-case.sh
scripts/ops/attendance-run-gate-contract-case.sh strict
scripts/ops/attendance-run-gate-contract-case.sh dashboard
```
- 结果：PASS

### 4.2 GA 合同矩阵（分支验证）
- Run: `22896171398`（branch: `codex/attendance-pr396-pr399-delivery-md-20260310`）
- 结果：PASS
- 证据：
  - `output/playwright/ga/22896171398/attendance-gate-contract-matrix-dashboard-22896171398-1/dashboard.valid.json`
  - `output/playwright/ga/22896171398/attendance-gate-contract-matrix-dashboard-22896171398-1/dashboard.invalid.locale.json`
  - `output/playwright/ga/22896171398/attendance-gate-contract-matrix-strict-22896171398-1/strict/gate-summary.json`

### 4.3 GA zh smoke（分支验证）
- Run: `22896361190`（branch: `codex/attendance-pr396-pr399-delivery-md-20260310`）
- 结果：PASS
- 摘要：`status=pass`, `locale=zh-CN`, `authSource=refresh`, `toggleCheck.skipped=true`
- 证据：
  - `output/playwright/ga/22896361190/attendance-locale-zh-smoke-prod-22896361190-1/attendance-zh-locale-summary.json`

### 4.4 GA checks（清洁 PR #405）
- Contract matrix run: `22896628962`（strict/dashboard/openapi 全 PASS）
- Locale smoke run: `22896657984`（PASS）
- 证据：
  - `output/playwright/ga/22896628962/...`
  - `output/playwright/ga/22896657984/attendance-locale-zh-smoke-prod-22896657984-1/attendance-zh-locale-summary.json`

## 5. 当前结论
- 考勤门禁链路在“合同层 + zh smoke 层”已达到可持续回归状态。
- 推荐以 **PR #405** 作为合并入口（检查全绿、冲突已规避）。
- 合并后可直接进入下一轮并行开发：
  1. `A线`：daily dashboard 与 strict gate 联动回归（2 次连续）
  2. `B线`：导入性能 100k+ 路径（upload + idempotency）强化
  3. `C线`：中文 UX 与移动端降级一致性回归
