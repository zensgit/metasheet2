# Attendance UserGroup Overrides + Plugin Nav (Dev Report)

Date: 2026-01-31

## Scope
- Allow `security/driver` groups to be resolved by **userId overrides** (manual list) without blocking on other conditions.
- Expand default group inference to use both **role** and **attendance_group**.
- Finish plugin view navigation baseline (plugin nav registry + host route).
- Document new userGroup override behavior in the DSL spec.

## Changes
- **Policy engine**
  - `userIds` now act as manual override in `userGroups` matching.
  - Default groups now resolve `security/driver` via both role and attendance group when present.
- **Plugin navigation**
  - `/p/:plugin/:viewId` route added with `PluginViewHost`.
  - Legacy `/attendance` now redirects to plugin host.
- **Documentation**
  - Added note that `userIds` are override matching (OR behavior) and that duplicate group names can model OR logic.

## Files Updated
- `apps/web/src/main.ts`
- `apps/web/src/App.vue`
- `apps/web/src/composables/usePlugins.ts`
- `apps/web/src/plugins/viewRegistry.ts`
- `apps/web/src/views/PluginViewHost.vue`
- `packages/core-backend/src/index.ts`
- `plugins/plugin-attendance/plugin.json`
- `plugins/plugin-attendance/index.cjs`
- `docs/attendance-rule-dsl-spec-20260128.md`

## Notes
- `attendance_group` remains optional. If not provided, groups fall back to role-based inference or explicit `userIds`.
- `userIds` overrides are intended for small, high-priority exceptions (e.g., special driver/security users).
