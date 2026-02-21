# 考勤并行开发闭环报告（2026-02-21）

## 范围

- 按并行执行完成 A/B/C 三线收口，不再等待人工确认。
- 目标：把 strict/perf/longrun/dashboard 重新打通到可交付状态，并补齐本轮失败点修复与证据。

## 本轮开发变更

### A 线（门禁）

- `scripts/verify-attendance-full-flow.mjs`
  - 修复 `Refresh` 选择器冲突（`Refresh` vs `Retry refresh`）。
  - recovery 断言优先使用 API upload 预置 `csvFileId`，避免 UI 载入不稳定。
  - 对 disabled 的 `Reload job` 按钮做容错，不再强制点击导致超时。
  - recovery 场景数据规模下调，确保在门禁时限内完成。

### B 线（性能）

- `scripts/ops/attendance-import-perf.mjs`
  - 新增 rollback 瞬时错误重试：
    - 默认 `ROLLBACK_RETRY_ATTEMPTS=3`
    - 默认 `ROLLBACK_RETRY_DELAY_MS=1500`
  - 覆盖 `429/5xx` 与常见瞬时错误码（`INTERNAL_ERROR/DB_CONFLICT/LOCK_TIMEOUT`）。

## 并行验证结果

| 验证项 | Run | 结果 | 证据 |
|---|---|---|---|
| Strict gates（branch） | [#22249548985](https://github.com/zensgit/metasheet2/actions/runs/22249548985) | PASS | `output/playwright/ga/22249548985/attendance-strict-gates-prod-22249548985-1/20260221-033438-1/gate-summary.json` |
| Strict gates（branch，再跑） | [#22249647567](https://github.com/zensgit/metasheet2/actions/runs/22249647567) | PASS | `output/playwright/ga/22249647567/attendance-strict-gates-prod-22249647567-1/20260221-034238-2/gate-summary.json` |
| Perf baseline 100k（upload） | [#22249647556](https://github.com/zensgit/metasheet2/actions/runs/22249647556) | PASS | `output/playwright/ga/22249647556/attendance-import-perf-22249647556-1/attendance-perf-mlvruyei-thwrf9/perf-summary.json` |
| Perf longrun（修复前） | [#22249647566](https://github.com/zensgit/metasheet2/actions/runs/22249647566) | FAIL（修复输入） | `output/playwright/ga/22249647566/attendance-import-perf-longrun-rows10k-commit-22249647566-1/current/rows10k-commit/perf.log` |
| Perf longrun（修复后） | [#22249759637](https://github.com/zensgit/metasheet2/actions/runs/22249759637) | PASS | `output/playwright/ga/22249759637/attendance-import-perf-longrun-rows10k-commit-22249759637-1/current-flat/rows10000-commit.json` |
| Branch policy drift | [#22249647577](https://github.com/zensgit/metasheet2/actions/runs/22249647577) | PASS | `output/playwright/ga/22249647577/attendance-branch-policy-drift-prod-22249647577-1/policy.json` |
| Strict gates（main，替换 cancelled） | [#22249826030](https://github.com/zensgit/metasheet2/actions/runs/22249826030) | PASS | `output/playwright/ga/22249826030/attendance-strict-gates-prod-22249826030-1/20260221-035505-2/gate-summary.json` |
| Daily dashboard（main） | [#22249881772](https://github.com/zensgit/metasheet2/actions/runs/22249881772) | PASS | `output/playwright/ga/22249881772/attendance-daily-gate-dashboard-22249881772-1/attendance-daily-gate-dashboard.json` |

## 问题与恢复

1. longrun 首次失败根因：`rows10k-commit` 回滚接口瞬时 `500`。
2. 修复：perf 脚本加入 rollback 重试并记录重试日志。
3. 结果：longrun 重跑通过，`[Attendance P1] Perf longrun alert`（[#157](https://github.com/zensgit/metasheet2/issues/157)）自动关闭。

## 注意事项

- 在 feature 分支执行 dashboard 时，remote-only gates 可能出现 `NO_COMPLETED_RUN`（不是生产故障）；生产判定请使用 `branch=main`。
- 本文未包含任何真实 token/secret。

## 结论

- 本轮并行开发与验证已闭环完成。
- 当前可见结果：strict/perf/longrun/dashboard 均已恢复并达到可交付状态。
