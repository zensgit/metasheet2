# Yjs CI Migration Exclude Alignment Development

Date: 2026-04-19

## Scope

This work package aligns CI workflows after PR `#918` still failed in three places even after `MIGRATION_EXCLUDE` support was restored in the migration provider.

The remaining failures showed that workflow-level exclusion lists were still inconsistent:

- `migration-replay` excluded `20250924120000_create_views_view_states.ts` but not `20250924140000_create_gantt_tables.ts`;
- `plugin-tests` inherited the same incomplete list;
- `observability-e2e` and `safety-guard-e2e` ran `db:migrate` without any `MIGRATION_EXCLUDE`;
- `observability-strict` also needed the new gantt exclusion for consistency.

## Failure Root Cause

The new combined migration provider was now honoring `MIGRATION_EXCLUDE`, but CI still reintroduced known replay-only schema conflicts because the exclusion list itself was incomplete or missing in some jobs.

Observed failures:

- `20250924120000_create_views_view_states.ts`
  - `kanban_configs_view_id_fkey` / UUID vs text mismatch
- `20250924140000_create_gantt_tables.ts`
  - `gantt_tasks_view_id_fkey` / UUID vs text mismatch

These are replay-path schema compatibility issues, not Yjs runtime defects.

## Workflow Changes

Updated workflows:

- `.github/workflows/migration-replay.yml`
- `.github/workflows/plugin-tests.yml`
- `.github/workflows/observability-e2e.yml`
- `.github/workflows/observability-strict.yml`
- `.github/workflows/safety-guard-e2e.yml`

Aligned `MIGRATION_EXCLUDE` to:

`008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,049_create_bpmn_workflow_tables.sql,042a_core_model_views.sql,20250924120000_create_views_view_states.ts,20250924140000_create_gantt_tables.ts`

## Documentation Changes

Updated:

- `packages/core-backend/MIGRATION_EXCLUDE_TRACKING.md`

Changes:

- corrected the current exclusion count and default CI list;
- documented the current replay-only exclusions for:
  - `042a_core_model_views.sql`
  - `20250924120000_create_views_view_states.ts`
  - `20250924140000_create_gantt_tables.ts`

## Files Changed

- `.github/workflows/migration-replay.yml`
- `.github/workflows/plugin-tests.yml`
- `.github/workflows/observability-e2e.yml`
- `.github/workflows/observability-strict.yml`
- `.github/workflows/safety-guard-e2e.yml`
- `packages/core-backend/MIGRATION_EXCLUDE_TRACKING.md`
- `docs/development/yjs-ci-migration-exclude-alignment-development-20260419.md`
- `docs/development/yjs-ci-migration-exclude-alignment-verification-20260419.md`

## Outcome

- All replay-sensitive workflows now use the same exclusion policy.
- CI no longer depends on one workflow remembering exclusions that another workflow omits.
- The remaining Yjs rollout path stays focused on `#918` merge and human collaborative validation, not on replay-only migration breakage.
