# 考勤 staging migration alignment 审计验证

Date: 2026-05-19

## Scope

本轮验证是 read-only staging audit，目标是解释 8082 staging 的 pending migrations，并判断是否可以安全全量迁移。

No DB migration was executed in this audit slice.

## Commands / Evidence

### Runtime image

```bash
ssh ... "docker ps --format '{{.Names}} {{.Image}}' | grep -E 'metasheet-staging-(backend|web)'"
```

Result:

| Container | Image |
| --- | --- |
| `metasheet-staging-web` | `ghcr.io/zensgit/metasheet2-web:a3cb70de1c9b5bd3676f0db8126d1f8ac9617ac1` |
| `metasheet-staging-backend` | `ghcr.io/zensgit/metasheet2-backend:a3cb70de1c9b5bd3676f0db8126d1f8ac9617ac1` |

### Migration list

```bash
docker compose -f docker-compose.app.staging.yml exec -T backend \
  node packages/core-backend/dist/src/db/migrate.js --list
```

Result:

| Metric | Value |
| --- | ---: |
| Applied | 86 |
| Pending | 77 |

Pending category count:

| Category | Count |
| --- | ---: |
| Superseded legacy SQL no-op marker | 29 |
| Legacy executable SQL | 5 |
| Timestamp SQL | 2 |
| Modern `zzzz` migrations | 41 |

### Migration provider behavior

Verified from `packages/core-backend/src/db/migration-provider.ts`:

- `SUPERSEDED_LEGACY_SQL_MIGRATIONS` includes `032_create_approval_records` through `055_create_attendance_import_tokens`.
- Unless `MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=true`, these names remain visible but are replaced by no-op migrations.
- `MIGRATION_EXCLUDE` is supported but unset on staging.

### Staging migration env

Container env:

```json
{
  "MIGRATION_EXCLUDE": null,
  "MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL": null
}
```

Staging config note:

- `.env` uses current image tag.
- `docker/app.staging.env` still has an older `IMAGE_TAG` value.
- Running container images are current, so this is diagnostic drift rather than active image drift.

### DB schema sample

Read-only probe:

| Probe | Result |
| --- | ---: |
| `kysely_migration` rows | 86 |
| public tables | 155 |
| public columns | 1725 |

Key existing tables:

| Table | Exists |
| --- | --- |
| `attendance_records` | yes |
| `attendance_requests` | yes |
| `attendance_leave_types` | yes |
| `attendance_overtime_rules` | yes |
| `attendance_payroll_cycles` | yes |
| `attendance_import_tokens` | yes |
| `meta_bases` / `meta_sheets` / `meta_fields` / `meta_records` / `meta_views` | yes |
| `plugin_attendance_report_sync_jobs` | yes |
| `users` / `user_orgs` | yes |

Sample missing tables:

| Table | Exists |
| --- | --- |
| `integration_runs` | no |
| `integration_steps` | no |
| `integration_credentials` | no |
| `meta_view_permissions` | no |
| `meta_field_permissions` | no |
| `meta_record_permissions` | no |
| `automation_rules` | no |
| `automation_executions` | no |
| `dashboard_charts` | no |
| `formula_dependencies` | no |
| `platform_app_instances` | no |
| `dingtalk_group_destinations` | no |
| `dingtalk_group_deliveries` | no |
| `dingtalk_person_deliveries` | no |
| `approval_reads` | no |
| `approval_metrics` | no |
| `meta_record_revisions` | no |
| `meta_record_subscriptions` | no |
| `meta_field_auto_number_sequences` | no |

Sample column probes:

| Column | Exists |
| --- | --- |
| `users.must_change_password` | yes |
| `users.username` | yes |
| `meta_records.modified_by` | yes |
| `approval_records.created_action` | no |
| `approval_templates.category` | no |
| `approval_templates.visibility_scope` | no |
| `automation_rules.actions` | no |

## Result

| Check | Result |
| --- | --- |
| Confirm staging runtime is current | PASS |
| Confirm migration env is not masking pending list | PASS |
| Confirm pending list is mixed no-op and executable | PASS |
| Confirm some pending schemas are genuinely missing | PASS |
| Confirm full migration would exceed report-sync evidence scope | PASS |
| Confirm report sync job table is present after previous narrow alignment | PASS |

## Decision

Full staging migration is **not approved** as part of attendance report sync evidence closeout.

Recommended next action is a separate migration alignment runbook/rehearsal slice. The runbook should use a staging DB clone or backup first, then decide whether to fix idempotency, apply a curated `MIGRATION_EXCLUDE`, or perform a broad staging schema upgrade.

## Residual Risk

Staging remains operational for the validated attendance report sync job path, but it is not globally migration-aligned with current code. Future features outside attendance report sync may fail if they depend on the missing pending schemas.
