# Attendance comprehensive-hours PR4 weak warning verification - 2026-05-23

## Scope Verified

This runtime slice adds weak comprehensive-hours advisory warnings to shift and
rotation assignment saves. It does not add backend routes, persistence, or
block-save behavior.

## Contract Coverage

| Contract | Evidence |
| --- | --- |
| Reuses existing preview route | Tests assert `POST /api/attendance/comprehensive-hours/preview` is called before save. |
| Planned metric only | Tests assert request body `metric: "planned"`. |
| Weak warning only | Tests assert assignment save still calls `/api/attendance/assignments` after preview violation. |
| Preview error does not block save | Tests assert a `503 DB_NOT_READY` preview response still allows assignment save. |
| No all-users body | Tests assert preview body has no `allUsers` property. |
| No new backend/migration/persistence | Changed files are frontend test/view docs only; plugin syntax check is clean. |

## Test Results

| Command | Result |
| --- | --- |
| `node --check plugins/plugin-attendance/index.cjs` | PASS |
| `pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-regressions.spec.ts tests/attendance-admin-anchor-nav.spec.ts --watch=false` | PASS, 41 tests |
| `pnpm --filter @metasheet/web type-check` | PASS |
| `pnpm --filter @metasheet/web build` | PASS |
| `git diff --check` | PASS |
| Secret/home-path scan over changed 2026-05-23 docs + frontend files | PASS, 0 matches |

## Runtime Smoke Dependency

The reused backend route and PR3 read-only UI were smoke-tested on production
before this slice:

- API base: `http://23.254.236.11:8081`
- admin JWT read from local `0600` file, token value not printed
- `GET /api/auth/me`: PASS
- unauthenticated preview route: HTTP 401 rather than 404
- authenticated planned preview: HTTP 200
- UI route `/attendance?tab=admin#attendance-admin-comprehensive-hours-preview`:
  PASS with one row and aggregate OK

Full evidence is in
`attendance-comprehensive-hours-preview-runtime-smoke-verification-20260523.md`.

## Remaining Explicitly Deferred

| Follow-up | Status |
| --- | --- |
| PR5 strong-control block-save guard | Deferred; requires separate explicit opt-in. |
| Stored comprehensive-hours policies | Deferred. |
| Actual-minute enforcement on save | Deferred. |
| All-users save preview | Deferred. |
| Reporting / multitable snapshot | Deferred. |
