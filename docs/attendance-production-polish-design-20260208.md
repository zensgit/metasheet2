# Attendance Production Polish (Design)

Date: 2026-02-08

## Goal
After the Attendance plugin reached "production-usable" status, this iteration hardens the remaining P0/P1 gaps so admins can operate without UUID copy/paste and imports behave deterministically on retries:

1. **Admin UX**: user directory + search + access panel (roles/permissions) inside Attendance Admin Center.
2. **Import reliability**: payload dedup, optional idempotency key, persist skipped rows/anomalies, export CSV for items/anomalies.
3. **Access control**: attendance-scoped role templates (employee/approver/admin) assign/unassign without global platform admin.
4. **Ops/verification**: smoke + Playwright scripts auto-refresh JWT (no manual token churn during long runs).

Non-goals:
- Full payroll settlement (salary computation) and complex business holiday policies.
- CAD features.

## Data Model / Migrations

### Roles table + attendance role templates
Migration:
- `packages/core-backend/src/db/migrations/zzzz20260208100000_create_roles_table.ts`

What it does:
- Creates `roles` table if missing.
- Seeds these attendance role IDs (used by the Admin Center "User Access" panel):
  - `attendance_employee`
  - `attendance_approver`
  - `attendance_admin`
- Ensures `role_permissions` contains expected mappings for:
  - `attendance:read`, `attendance:write`, `attendance:approve`, `attendance:admin`

### Import idempotency key
Migration:
- `packages/core-backend/src/db/migrations/zzzz20260208120000_add_attendance_import_idempotency_key.ts`

What it does:
- Adds `attendance_import_batches.idempotency_key` (text).
- Adds a partial unique index per org for non-empty keys:
  - `(org_id, idempotency_key)` unique when `idempotency_key <> ''`.

This enables safe client retries:
- Re-sending the same commit with the same `idempotencyKey` returns the existing committed batch instead of creating duplicates.

### Persist skipped rows and anomalies (import items)
Existing tables:
- `attendance_import_batches`
- `attendance_import_items`

Behavior:
- Skipped rows (validation errors) and duplicates are persisted as `attendance_import_items` with:
  - `record_id = NULL`
  - `snapshot` contains `reason`, `warnings`, and the original parsed row payload.

This applies to:
- Manual import commit path.
- Integration sync import path.

## Backend APIs

### Attendance-scoped admin API (RBAC protected)
File:
- `packages/core-backend/src/routes/attendance-admin.ts`

Guard:
- `rbacGuard('attendance', 'admin')`
- Meaning: requires `attendance:admin` (not global admin).

Endpoints:
1. `GET /api/attendance-admin/role-templates`
   - Returns role templates: `employee|approver|admin` with `roleId`, permissions, and descriptions.
2. `GET /api/attendance-admin/users/search?q=...`
   - Searches `users` by `email`, `name`, or `id` (ILIKE).
3. `GET /api/attendance-admin/users/:userId/access`
   - Returns user profile + role IDs + effective permissions.
4. `POST /api/attendance-admin/users/:userId/roles/assign`
   - Body: `{ template: 'employee'|'approver'|'admin' }` or `{ roleId: string }`
5. `POST /api/attendance-admin/users/:userId/roles/unassign`
   - Body: same as assign.

### Permissions grant API (ops / bootstrap)
File:
- `packages/core-backend/src/routes/permissions.ts`

Endpoint:
- `POST /api/permissions/grant` (admin-only)

Used by:
- `scripts/ops/attendance-provision-user.sh` for quick provisioning in production.

### Import APIs (attendance plugin)
File:
- `plugins/plugin-attendance/index.cjs`

Notable behaviors:
1. **Payload dedup**
   - Duplicate rows in a single payload for the same `(userId, workDate)` are:
     - reported in preview as `invalid` with a warning
     - skipped during commit (persisted as anomaly items)
2. **Idempotency**
   - Commit accepts optional `idempotencyKey` (string).
   - When DB column exists, committed batches are de-duplicated by `(orgId, idempotencyKey)`.
3. **Batch items querying**
   - `GET /api/attendance/import/batches/:id/items`
   - Supports `type` filter: `all|imported|skipped|anomalies`
   - Used by frontend CSV export for both items and anomalies.

### Auth token refresh
Endpoint:
- `POST /api/auth/refresh-token`

Used by:
- `scripts/ops/attendance-smoke-api.mjs`
- `scripts/verify-attendance-full-flow.mjs`
- `scripts/verify-attendance-production-flow.mjs`

## Frontend UX

### Attendance product shell
Files:
- `apps/web/src/stores/featureFlags.ts`
- `apps/web/src/App.vue`
- `apps/web/src/main.ts`
- `apps/web/src/views/attendance/AttendanceExperienceView.vue`

Behavior:
- When `features.mode=attendance` (or local override), the top nav is focused:
  - only shows `Attendance`
  - non-attendance routes redirect to `/attendance`
- `/attendance` is the landing page in attendance-focused mode.
- Tabs in attendance shell:
  - `Overview` (always)
  - `Admin Center` (only if `features.attendanceAdmin=true`)
  - `Workflow Designer` (only if `features.workflow=true`)
- Mobile policy:
  - Admin/Workflow tabs show "Desktop recommended" gate.

### Admin Center: User directory + access panel
File:
- `apps/web/src/views/AttendanceView.vue`

Capabilities:
- Search users by email/name/id.
- View access summary: roles + permissions.
- Assign/unassign role templates (employee/approver/admin) via `/api/attendance-admin/*`.

### Import batches: CSV exports
File:
- `apps/web/src/views/AttendanceView.vue`

Capabilities:
- Export **items CSV** (all rows).
- Export **anomalies CSV** (skipped + invalid + warning rows).
- Export prefers server-side CSV export when available:
  - `GET /api/attendance/import/batches/:id/export.csv?type=all|anomalies`
- Falls back to paginated batch-items fetching on older deployments (HTTP 404).

## Security Notes
- Admin UX and admin APIs are attendance-scoped and require `attendance:admin`.
- Provisioning via `/api/permissions/grant` remains global-admin only; intended for bootstrap/ops.
- Documentation and scripts must never embed real JWTs; always use placeholders.
