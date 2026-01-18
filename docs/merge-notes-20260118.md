# Merge Notes 2026-01-18

## Recommended Order
1) grid-reports-20260117 (docs only)
2) feat/grid-spreadsheets (grid persistence + migrations)
3) feat/attendance-platform (plugin runtime + attendance migrations)

## grid-reports-20260117
Merge Notes:
- Docs-only change; no migrations or service restarts required.

Rollback:
- Revert the commit or remove `docs/grid-view-development-report.md` and `docs/grid-view-verification-report.md`.

## feat/grid-spreadsheets
Merge Notes:
- Run migrations: `zzzz20260113_create_spreadsheets_table.ts`, `zzzz20260117120000_create_spreadsheet_grid_tables.ts`.
- OpenAPI/SDK artifacts updated; if CI validates, run `pnpm exec tsx packages/openapi/tools/build.ts`.
- Grid view depends on backend APIs; deploy backend first.

Rollback:
- Roll back migrations (or add reverse migrations for `sheets`, `cells`, `cell_versions`, `named_ranges`).
- Revert backend routes and frontend Grid/Spreadsheets views.

## feat/attendance-platform
Merge Notes:
- Migration re-ordering: `zzzz20260114*`, plus `zzzz20260117090000_add_attendance_permissions.ts` and `zz20251231_create_bpmn_tables.ts`.
- Plugin loader validation tightened; verify older plugins in staging.
- `/api/plugins` response shape adjusted; confirm frontend compatibility.

Rollback:
- Revert plugin loader/runtime changes.
- Roll back migrations (or add reverse migrations).
- If `plugins/sample-basic` compatibility is an issue, disable the plugin or keep the legacy entrypoint.
