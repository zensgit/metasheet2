# Attendance Comprehensive Hours Preview Input Validation Verification

Date: 2026-05-23
Branch: `codex/attendance-comprehensive-hours-preview-postmerge-review-20260523`

## Review Scope

Post-merge review target:

- `353d01dcd feat(attendance): add comprehensive hours preview route (#1774)`
- `plugins/plugin-attendance/index.cjs`
- `packages/core-backend/tests/unit/attendance-comprehensive-hours-control.test.ts`

Reviewed boundaries:

| Check | Evidence |
| --- | --- |
| Admin gate | Route registration uses `withPermission('attendance:admin')`. |
| Read-only route | Only `POST /api/attendance/comprehensive-hours/preview` was added for this feature. |
| No writes in preview helper | Existing planned preview test asserts all recorded SQL starts with `SELECT` and has no `INSERT`, `UPDATE`, `DELETE`, or `PATCH`. |
| Planned/actual separation | Planned preview uses effective-calendar/schedule context producers; actual preview uses `loadAttendanceSummary()`. |
| Schema gaps | Missing table/column errors return `503 DB_NOT_READY`. |

## Added Coverage

The existing invalid-preview test now also covers:

| Case | Expected result |
| --- | --- |
| `metric: 'actuals'` | `INVALID_METRIC` |
| `policyDraft.metric: 'actuals'` | `INVALID_METRIC` |
| `enforcement: 'deny'` | `INVALID_ENFORCEMENT` |
| `policyDraft.enforcement: 'deny'` | `INVALID_ENFORCEMENT` |
| `metric: ' actual '`, `enforcement: ' block '` | Valid, normalized to `actual` / `block` |

This proves supplied invalid enum values fail before DB reads instead of silently
falling back to `planned` / `warn`.

## Commands

```bash
node --check plugins/plugin-attendance/index.cjs
```

Result: PASS.

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-comprehensive-hours-control.test.ts \
  --reporter=dot
```

Result: PASS, 11 tests.

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-advanced-scheduling-workbench.test.ts \
  tests/unit/attendance-scheduling-assignment-conflict.test.ts \
  tests/unit/attendance-effective-calendar-role-context.test.ts \
  --reporter=dot
```

Result: PASS, 15 tests.

```bash
pnpm --filter @metasheet/core-backend build
```

Result: PASS.

```bash
git diff --check
```

Result: PASS.

## Dependency Note

The isolated worktree did not have its own `node_modules`. The verification used
temporary symlinks to the existing workspace dependencies and then removed them
before staging. No dependency directories or build outputs are part of this
slice.
