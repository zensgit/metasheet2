# Plugin Framework Development Report (2026-01-24)

## Scope
- Platform + attendance parallelization: plugin-driven navigation, view contributions, and admin enablement.

## Changes
- Added plugin view contributions with order/location/icon metadata for calendar, gallery, gantt, kanban, and attendance.
- Added plugin enablement persistence via `plugin_kv` and exposed `enabled` in `/api/plugins`.
- Updated plugin activation to respect persisted enablement flags.
- Added a minimal Plugin Admin UI at `/admin/plugins` for toggling module availability.
- Added SafetyGuard + admin-role protection for plugin enable/disable updates.
- Added runtime enable/disable hooks so toggles take effect without restart.
- Updated frontend routing and navigation to use plugin view contributions and hide disabled view IDs.
- Restored `@metasheet/core-backend` build by fixing type errors, adapter typing, and missing deps for import/export.
- Normalized JWT payloads to map `userId` to `id` for RBAC/SafetyGuard checks.
- Added an ESM import fixer for backend builds so Node can run `dist` without `tsx`.
- Set `@metasheet/core-backend` package `type: "module"` and run the fixer across the full `dist` tree.
- Added a placeholder migration for a missing historical spreadsheet migration.

## Files Touched
- `apps/web/src/App.vue`
- `apps/web/src/composables/usePlugins.ts`
- `apps/web/src/main.ts`
- `apps/web/src/router/viewRegistry.ts`
- `apps/web/src/views/PluginAdminView.vue`
- `packages/core-backend/src/core/plugin-settings-store.ts`
- `packages/core-backend/src/guards/SafetyGuard.ts`
- `packages/core-backend/src/guards/types.ts`
- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/routes/admin-routes.ts`
- `packages/core-backend/src/auth/jwt-middleware.ts`
- `packages/core-backend/scripts/fix-esm-imports.mjs`
- `packages/core-backend/migrations/zzzz20260113_create_spreadsheets_table.sql`
- `packages/core-backend/src/audit/AuditService.ts`
- `packages/core-backend/src/core/plugin-loader.ts`
- `packages/core-backend/src/data-adapters/HTTPAdapter.ts`
- `packages/core-backend/src/libs/import-export/import.ts`
- `packages/core-backend/src/libs/plugins/PluginManager.ts`
- `packages/core-backend/src/routes/federation.ts`
- `packages/core-backend/src/services/CollabService.ts`
- `packages/core-backend/src/types/plugin.ts`
- `packages/core-backend/src/workflow/BPMNWorkflowEngine.ts`
- `plugins/plugin-attendance/plugin.json`
- `plugins/plugin-view-kanban/plugin.json`
- `plugins/plugin-view-gantt/plugin.json`
- `plugins/plugin-view-calendar/plugin.json`
- `plugins/plugin-view-calendar/index.js`
- `plugins/plugin-view-gallery/plugin.json`
- `plugins/plugin-view-gallery/index.js`

## Notes
- Disabled plugins now render as `inactive` in `/api/plugins` and are removed from navigation.
- Calendar/Gallery view plugins use lightweight stubs for backend activation and rely on existing frontend views.
- Backend build now installs `exceljs`, `csv-parse`, and `@types/lodash` to satisfy runtime and type requirements.
