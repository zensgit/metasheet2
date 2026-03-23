# Attendance Root Auth And Admin Nav Design

Date: 2026-03-23

## Scope

This pass closes two attendance issue groups in the root repo:

1. Attendance integration failures that were previously masked by test auth/RBAC baseline noise.
2. Attendance admin usability problems caused by a single very long management page without in-page navigation.

It also includes the confirmed frontend guard for partial import-batch snapshots.

## Problem statement

### 1. Integration baseline was hiding real failures

The attendance integration suite had previously degraded into broad `401/403` noise. That made newer logic changes around:

- `YYYY-MM-DD` date validation
- `workDate` validation
- duplicate request rejection
- import commit/upsert paths

hard to evaluate because failures were dominated by environment behavior rather than attendance business logic.

### 2. Admin console had become too long to scan

`AttendanceView.vue` admin mode had already grown into a dense control plane with many stable sections:

- Settings
- User Access
- Batch Provisioning
- Audit Logs
- Holiday Sync
- Default Rule
- Rule Sets
- Rule Template Library
- Attendance groups
- Group members
- Import
- Import batches
- Payroll Templates
- Payroll Cycles
- Leave Types
- Overtime Rules
- Approval Flows
- Rotation Rules
- Rotation Assignments
- Shifts
- Assignments
- Holidays

The UI pain was not generic “MetaSheet layout” pain. It was specifically concentrated in this attendance admin surface.

## Applied design

### A. Frontend import-batch snapshot guard

`AttendanceView.vue` now treats `previewSnapshot.context` as optional runtime data.

Design choice:

- Keep rendering the snapshot body even when `context` is missing.
- Show `--` placeholders for `userId`, `workDate`, and `recordId`.
- Lock the path with a regression test that writes the partial snapshot state directly.

This is a local safety fix, not a schema change.

### B. Non-production auth fallback for integration baseline

`AuthService.getUserById()` now allows the mock-user fallback in non-production environments instead of `development` only.

Design choice:

- Keep production behavior unchanged.
- Make `test` behave like local development for the dev-token path.

This restores the expected integration baseline without widening production trust.

### C. Request-user fast path in RBAC

RBAC now trusts already-resolved `req.user.role` / `req.user.permissions` before falling back to DB lookups.

Design choice:

- Prefer middleware-resolved claims when they already exist on the request.
- Keep DB RBAC lookup as the fallback path only.

This avoids double resolution and removes false `403` failures in attendance admin integration flows.

### D. Batch route shadowing repair

The attendance admin route file had `/users/:userId/roles/*` ahead of `/users/batch/roles/*`.

Design choice:

- Use the minimum-risk repair in the existing root file.
- If `req.params.userId === 'batch'`, call `next()` and let the later batch route handle the request.

This avoids a large route reorder in a dirty worktree while still fixing behavior.

### E. Attendance request dedupe and import record normalization

The attendance plugin now uses date-only normalization consistently in request and import flows.

Design choices:

- normalize `Date` values to local `YYYY-MM-DD` instead of ISO UTC truncation for attendance date keys
- normalize import row `workDate` before building `(userId, workDate)` keys
- look up record upsert results using normalized keys
- reject duplicate requests by `(userId, orgId, workDate, requestType)` with an advisory lock + explicit `409 DUPLICATE_REQUEST`

This keeps attendance dates aligned with the local business date model instead of UTC date rollover artifacts.

### F. Attendance-local left anchor navigation

The oversized admin page is now handled inside `AttendanceView.vue`, not in a global MetaSheet shell.

Design choice:

- render a two-column admin shell only for attendance admin mode
- keep the right column as the existing content stack
- add a sticky left `<aside>` with anchor buttons
- register stable ids per admin section
- track active section locally with `IntersectionObserver`
- keep click behavior local via `scrollIntoView`

Important constraint:

- this stays attendance-specific for now
- no router/hash/global-shell abstraction was introduced

That keeps the change low-risk and focused on the page that actually has the problem.

### G. Import batches as a first-class anchor

`Import batches` is visually and operationally important even though it sits inside the broader import block.

Design choice:

- keep it in the left anchor list
- attach an anchor id to its subsection header instead of forcing a broader template rewrite

Nested sub-blocks like `Holiday overrides` and `Template Versions` remain excluded from first-pass anchors.

## Why this stays in the attendance system instead of MetaSheet shell

The recommendation remains: build this navigation in the current attendance system first.

Reasoning:

1. The pain is concentrated in one attendance admin page today.
2. The section model already exists in one file.
3. The required interaction is local scroll + active-state tracking, not global routing.
4. A global abstraction is only justified after another long-form admin surface proves the same need.

## Final state

This pass turns the earlier recommendation into implementation:

- frontend crash guard is fixed
- auth/RBAC baseline noise is removed
- batch role route shadowing is fixed
- duplicate request + import work-date normalization paths are repaired
- attendance admin page now has a left-side anchor navigation shell
