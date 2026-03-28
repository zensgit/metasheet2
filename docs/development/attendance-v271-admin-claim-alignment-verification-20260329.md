# Attendance v2.7.1 Admin Claim Alignment Verification

## Commands

```bash
git diff --check
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "honors authenticated admin claims for attendance admin routes when RBAC_BYPASS is disabled" --reporter=dot
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

## Focused Integration Result

`attendance-plugin.test.ts` now locks this behavior:

- when `RBAC_BYPASS=false`
- and the caller uses a dev token with authenticated admin claims / wildcard permissions
- attendance admin routes such as:
  - `GET /api/attendance/settings`
  - `GET /api/attendance/groups`

return `200` instead of `403`.

Observed result:

- `1 passed`

## Browser Verification

Using the local verification worktree with backend on `http://localhost:7778` and frontend on `http://127.0.0.1:8899`:

1. Injected a valid dev token into local storage.
2. Opened `/attendance?tab=admin`.
3. Confirmed `GET /api/attendance/settings` returns `200`.
4. Navigated to the `请假类型` admin section.
5. Measured the first visible `编辑` button.

Observed button geometry:

- width: `56.6640625`
- height: `36.5`
- display: `block`
- opacity: `1`
- visibility: `visible`

This means the active-section edit button is not zero-sized on the current code after the permission guard is aligned. The earlier “26 buttons width/height=0” report is consistent with either:

- querying buttons in hidden inactive sections while focused mode is on
- or checking a permission-blocked admin shell instead of the loaded section content

## Residual Risk

This slice aligns `withPermission()` with core RBAC semantics. It does not introduce a new attendance API surface and does not change DB-backed permission resolution order once request claims are insufficient.
