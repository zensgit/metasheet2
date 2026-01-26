# Plugin Admin Development Report

## Scope
- Plugin admin API for list/detail/enable/disable/config.
- Runtime activation/deactivation wiring in core server.
- Plugin manager UI route and view.
- OpenAPI coverage for admin plugin endpoints.

## Backend
- Added admin endpoints under `/api/admin/plugins` for list, detail, config get/update, enable, disable, and reload (with RBAC + SafetyGuard where applicable).
- Wired runtime activation/deactivation into `MetaSheetServer`, including disabled plugin registry overrides at startup.
- Best-effort persistence to `plugin_registry` and `plugin_configs`, with graceful fallback to in-memory config cache if tables/columns are missing.
- Added admin RBAC guard to plugin health, reload, and unload routes.

## Frontend
- Added `/admin/plugins` route and a Plugin Manager view for list, enable/disable, reload, and config editing.
- Uses existing `auth_token` from `localStorage` via `apiFetch`.

## OpenAPI
- Added `admin-plugins.yml` with admin plugin endpoints.
- Added `PluginAdminEntry` and `PluginConfigEntry` schemas in `base.yml`.

## Notes
- Reload endpoints still require SafetyGuard confirmation; UI surfaces errors if confirmation is missing.
- Config updates fall back to in-memory cache when DB config tables are not present.
