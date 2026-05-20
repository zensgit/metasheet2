# 考勤 staging migration alignment 审计设计

Date: 2026-05-19

## Summary

本轮审计 8082 staging 在 report sync job live evidence 中暴露的 migration alignment 问题。

结论：**不要直接在 staging 执行全量 `migrate --latest`**。当前 generic migration list 显示 `Applied: 86 / Pending: 77`，但这 77 项混合了：

- superseded legacy SQL no-op markers；
- 仍会执行 DDL 的 legacy SQL；
- timestamp SQL；
- 2026-04/05 的功能迁移；
- 本轮为 report sync job 已通过窄 DDL 对齐的 operational table migration。

其中部分 pending migration 对 staging 当前 schema 不是纯幂等，直接全量跑有失败或扩大产品面的风险。本轮只做 read-only 审计与安全建议，不继续写 staging DB。

## Current Staging State

| Item | Result |
| --- | --- |
| Runtime backend/web image | `a3cb70de1c9b5bd3676f0db8126d1f8ac9617ac1` |
| `docker ps` image check | backend/web both match latest staging target |
| Migration env | `MIGRATION_EXCLUDE=null`, `MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=null` |
| Generic migration list | `Applied: 86`, `Pending: 77` |
| Public table count | 155 |
| Public column count | 1725 |
| Report sync job table | `plugin_attendance_report_sync_jobs` exists |

One config drift was observed: staging `.env` image tag is current, but `docker/app.staging.env` still carries an older `IMAGE_TAG` value. Compose image interpolation uses `.env`, and running containers are correct, but the stale app env value can confuse future diagnostics.

## Pending Migration Categories

| Category | Count | Examples | Risk / Meaning |
| --- | ---: | --- | --- |
| Superseded legacy SQL no-op marker | 29 | `032_create_approval_records` ... `055_create_attendance_import_tokens` | Current provider keeps these visible but replaces them with no-op migrations unless `MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=true`. Pending means Kysely has not recorded the marker, not necessarily that schema is missing. |
| Legacy executable SQL | 5 | `008_plugin_infrastructure`, `056_add_users_must_change_password`, `057_create_integration_core_tables`, `058_*`, `059_*` | Mixed. Some schema already exists, but integration core tables are absent and would expand staging product surface. |
| Timestamp SQL | 2 | `20250925_create_view_tables`, `20250926_create_audit_tables` | Not all pure idempotent. `audit_logs` exists on staging while the SQL starts with `CREATE TABLE audit_logs` without `IF NOT EXISTS`, so full migration can fail. |
| Modern `zzzz` migrations | 41 | permissions, automation, DingTalk delivery, approval metrics, Yjs, record subscriptions, report sync jobs | Mixed. Several tables/columns are absent; some were manually or separately aligned. Applying all changes should be planned, not incidental to attendance verification. |

## DB Schema Sample

Existing key tables relevant to attendance/report sync:

- `attendance_records`
- `attendance_requests`
- `attendance_leave_types`
- `attendance_overtime_rules`
- `attendance_payroll_cycles`
- `attendance_import_tokens`
- `meta_bases`
- `meta_sheets`
- `meta_fields`
- `meta_records`
- `meta_views`
- `plugin_attendance_report_sync_jobs`
- `users`
- `user_orgs`

Missing sampled tables from pending migrations:

- `integration_runs`
- `integration_steps`
- `integration_credentials`
- `meta_view_permissions`
- `meta_field_permissions`
- `meta_record_permissions`
- `automation_rules`
- `automation_executions`
- `dashboard_charts`
- `formula_dependencies`
- `platform_app_instances`
- `dingtalk_group_destinations`
- `dingtalk_group_deliveries`
- `dingtalk_person_deliveries`
- `approval_reads`
- `approval_metrics`
- `meta_record_revisions`
- `meta_record_subscriptions`
- `meta_field_auto_number_sequences`

This proves the list is not merely stale migration bookkeeping. Some product feature schemas are genuinely absent on this staging DB.

## Why Full Migration Is Not Recommended

1. **Scope expansion risk**: pending migrations include integration, automation, permission, DingTalk delivery, approval metrics, Yjs, and subscription features unrelated to report sync job evidence.
2. **Non-idempotent legacy SQL risk**: `20250926_create_audit_tables.sql` creates `audit_logs` without `IF NOT EXISTS`; staging already has `audit_logs`.
3. **Mixed history risk**: staging has many later `zzzz20260409...` migrations recorded while older SQL and later feature migrations are pending. `allowUnorderedMigrations=true` permits progress, but does not make every migration safe to replay.
4. **Operational evidence already unblocked**: report sync job live evidence only needed `plugin_attendance_report_sync_jobs`, and that operational table is now aligned.

## Recommended Plan

### P0: Keep Report Sync Evidence Closed

Do not perform additional DB changes for attendance report sync job evidence. The live evidence is already complete and documented in:

- `docs/development/attendance-report-sync-jobs-live-evidence-development-20260519.md`
- `docs/development/attendance-report-sync-jobs-live-evidence-verification-20260519.md`

### P1: Add Migration Alignment Runbook

Create a dedicated ops runbook before any full staging migration attempt:

1. Export a staging DB backup or clone staging DB into a rehearsal database.
2. Run `migrate --list` on the rehearsal DB.
3. Apply pending migrations on the rehearsal DB only.
4. Record the first failing migration, if any.
5. Decide whether to:
   - fix idempotency in code;
   - mark superseded migrations as no-op markers;
   - apply an explicit `MIGRATION_EXCLUDE` baseline for staging-only unused feature domains;
   - or accept a full staged feature schema upgrade.

### P2: Make Alignment Machine-Readable

Add an ops script later, not in this audit slice, that produces:

- pending migration names;
- category classification;
- table/column existence probes;
- likely no-op vs executable status;
- recommended operator action.

This avoids future live evidence work rediscovering the same `Applied/Pending` mismatch by hand.

## Do Not Do

- Do not run generic `node packages/core-backend/dist/src/db/migrate.js` directly on 8082 staging while it still reports 77 pending.
- Do not treat the 77 pending list as harmless bookkeeping.
- Do not manually insert rows into `kysely_migration` without a rehearsed reconciliation plan.
- Do not hide this with a broad `MIGRATION_EXCLUDE` until the excluded feature domains are explicitly accepted.
