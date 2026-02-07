# Attendance Product Shell Design (2026-02-07)

## Goal
Support a "sell attendance as a standalone product" UX without maintaining a separate frontend codebase:

- **Attendance-only customers** see a focused shell:
  - Top nav only shows **Attendance**
  - Default landing to `/attendance`
  - Admin capabilities exist but do not dominate the main operation area
- **Attendance + Workflow customers** see an extra section **inside Attendance** (secondary tab), not a new top-level nav.
- **Mobile**: prioritize punch/request/approve/records; desktop-only for advanced admin/design tasks.

## Non-goals (This Iteration)
- A polished workflow product (multi-workflow list, publish history, and governance UI).
- Replacing the plugin system routing model (we integrate with it).
- A complete RBAC model in the frontend (we use a safe heuristic + future server flags).

## Current Baseline Problems
- Shell nav is static (Grid/Spreadsheets/Kanban/etc) and always visible.
- Attendance is a large monolith page (`AttendanceView.vue`) mixing user operations + admin console.
- No explicit "product feature flags" model; only plugin listing exists.

## Approach Overview

### 1) Frontend Feature Model (`ProductFeatures`)
File: `apps/web/src/stores/featureFlags.ts`

We introduced a frontend feature model with a clear precedence order:

1. **Local overrides (highest priority)**:
   - `localStorage.metasheet_product_mode` = `attendance|platform`
   - `localStorage.metasheet_features` = JSON payload (partial `ProductFeatures`)
2. **Backend features**:
   - `/api/auth/me` returns `data.features` (mode + capabilities).
3. **Plugin inference (lowest priority)**:
   - `/api/plugins` is only used to infer module presence (e.g. attendance plugin active), not product shell mode.

This allows:
- Real production control via backend flags, and
- Immediate development/testing control via localStorage injection (Playwright supported).

#### Safety Note: Default Mode
If neither local override nor backend features specify a product mode, the frontend defaults to **platform mode** (do not auto-switch to attendance-only based on plugin listing).

### 2) Capability-Driven Routing
Files:
- `apps/web/src/main.ts`
- `apps/web/src/views/HomeRedirect.vue`

Changes:
- `/` now renders `HomeRedirect.vue` (no navbar) which loads features then redirects:
  - attendance-focused -> `/attendance`
  - otherwise -> `/grid`
- `/attendance` is a first-class route (not a redirect to plugin host), guarded by `requiredFeature: 'attendance'`.
- A global guard enforces:
  - `requiredFeature` on routes (soft redirect to home on missing capability)
  - attendance-focused mode restriction (non-attendance routes redirect to `/attendance`)

### 3) Attendance Information Architecture (Tabs + Split Modes)
Files:
- `apps/web/src/views/attendance/AttendanceExperienceView.vue`
- `apps/web/src/views/attendance/AttendanceOverview.vue`
- `apps/web/src/views/attendance/AttendanceAdminCenter.vue`
- `apps/web/src/views/attendance/AttendanceWorkflowDesigner.vue`
- `apps/web/src/views/AttendanceView.vue`

We introduced an Attendance "experience shell" with tabs:
- **Overview**: punch + summary + calendar + requests + records
- **Admin Center**: the existing admin console and its sections
- **Workflow Designer**: only shown if `features.workflow=true` (embeds the existing `WorkflowDesigner.vue`)

The legacy `AttendanceView.vue` is now a host component supporting:
- `mode="overview"` to render only the user-facing cards
- `mode="admin"` to render only admin console

This reduces noise for regular users and prepares for further component extraction later.

### 4) Mobile Policy
File: `apps/web/src/views/attendance/AttendanceExperienceView.vue`

Policy:
- Tabs `admin` and `workflow` are **desktop-only** for this iteration.
- Mobile detection is a simple viewport threshold (`< 900px`), showing a "Desktop recommended" gate page.

### 5) Navigation Shell (Attendance Focus Mode)
File: `apps/web/src/App.vue`

Behavior:
- If `isAttendanceFocused()` is true:
  - brand shows `Attendance`
  - nav shows only `Attendance`
- Otherwise:
  - existing platform nav remains
  - plugin-contributed nav items remain
  - `Plugins` admin entry is only shown if admin is detected

## Integration With Plugin View Host
File: `apps/web/src/plugins/viewRegistry.ts`

Plugin-contributed view `AttendanceView` now maps to `AttendanceExperienceView`, so:
- `/p/plugin-attendance/attendance` uses the same upgraded UI
- `/attendance` uses the same upgraded UI

## Future Work (Recommended Next Steps)
1. **Purchase model**:
   - Persist tenant-level purchased capabilities (DB), not only env vars, and emit in `data.features`.
2. **Fine-grained RBAC**:
   - Replace admin heuristic with explicit permissions from backend (per tenant/user).
3. **Further extraction**:
   - Split `AttendanceView.vue` into dedicated components (import UI, settings forms, etc).
