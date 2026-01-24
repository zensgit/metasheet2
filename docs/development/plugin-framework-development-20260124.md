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
