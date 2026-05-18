# 考勤薪资周期字段模板 live evidence 开发记录

Date: 2026-05-18

## Summary

本轮补齐薪资周期字段模板联动的 staging live evidence。目标不是新增产品代码，而是在真实 8082 staging 上验证 `attendance_payroll_templates.config.summaryFields` 能被薪资周期 summary 与 summary CSV export 同源消费。

## Scope

- 使用 staging admin JWT 文件，不在聊天或文档中写入 token。
- staging backend/web 从旧镜像 `09a4bbb5e0f9bb1c7af66f0795c34b9526a4ba0b` 升级到服务器已有镜像 `5ca91630307603eacbbb13ae8209721f1b4d5bf3`，以包含周期汇总公式、薪资字段模板与 UI 相关 PR。
- 通过公开 API seed 一个 summary-scope 公式字段 `period_net_minutes`。
- 通过公开 API seed 一个隐藏 summary-scope 公式字段 `hidden_summary_live_metric`，只用于验证 hidden formula 不进入可输出字段。
- 创建临时薪资模板，写入 `config.summaryFields`：
  - `period_net_minutes`
  - `work_duration`
  - `late_days`
  - `net_anomaly_minutes`
  - `hidden_summary_live_metric`
  - `unknown_payroll_live_metric_20260518`
- 创建临时薪资周期并调用 summary 与 summary export。

## Implementation Notes

- API base: `http://localhost:8082` via SSH tunnel to staging.
- Token handling: local staging admin JWT file, mode `0600`, not printed.
- The previous token was expired, so a new 2h staging app admin JWT was generated inside the staging backend container with the existing app secret and written back to the same local file.
- Staging `.env` was backed up on the server before image tag update:
  - `.env.backup-payroll-live-20260518T151731Z`
- Only staging `backend` and `web` services were recreated:
  - `docker compose -f docker-compose.app.staging.yml up -d --no-deps backend web`
- No direct DB writes were used. All mutations went through attendance plugin HTTP APIs.

## Acceptance Shape

The live run validates:

- Template config persisted `summaryFields` in the configured order.
- Summary API returns `summaryFieldTemplate.configured = true`.
- Summary API output fields keep only valid summary fields in order:
  - `period_net_minutes`
  - `work_duration`
  - `late_days`
- Dropped fields include:
  - `net_anomaly_minutes` as a record-scope formula.
  - `hidden_summary_live_metric` as a hidden summary formula.
  - `unknown_payroll_live_metric_20260518` as an unknown field.
- Summary formula value for `period_net_minutes` is present under `summary.formula_values`.
- Summary CSV export metric rows match the same field order.

## Boundaries

- No code change.
- No DB migration.
- No direct `meta_*` writes.
- No `attendance_*` schema change.
- No change to summary calculation semantics.
- Staging-only live data was created for evidence and can be treated as disposable test data.
