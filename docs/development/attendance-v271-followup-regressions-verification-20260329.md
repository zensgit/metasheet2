# Attendance v2.7.1 Follow-up Regressions Verification

Date: 2026-03-29
Branch: `codex/attendance-v271-followup-20260329`

## Verified scope

- Request item CRUD routes exist and are normalized.
- Holiday item lookup exists and holiday write validation rejects invalid `date` and `type` before database write.
- Admin focused mode still shows active-section edit controls.
- Mobile nav and records table no longer keep the old fixed-width overflow behavior.
- OpenAPI source and generated artifacts match the runtime changes.

## Commands

### Source integrity

```bash
git diff --check
```

Result: pass

### Backend focused integration

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "supports request item lookup, update, and delete aliases for self-service follow-up|supports holiday item lookup and rejects invalid holiday date/type payloads before write|rejects negative leave type daily_minutes aliases, empty holiday names, and exposes holiday type fields" --reporter=dot
```

Result: pass

Notes:

- request `GET/PUT/DELETE /api/attendance/requests/:id` covered
- holiday `GET /api/attendance/holidays/:id` covered
- invalid holiday `date` and `type` now fail before database write

### Backend broader attendance integration

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts --reporter=dot
```

Result: one unrelated pre-existing failure remains

Notes:

- `50` tests passed
- `1` test failed in `registers attendance routes and lists plugin`
- the remaining failure is an approval-path expectation (`expected 403 to be 200`) outside this request/holiday/mobile regression slice
- the new request/holiday follow-up coverage no longer introduces additional failures into the full attendance integration file

### Frontend focused regression coverage

```bash
pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-regressions.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-regressions.spec.ts tests/attendance-admin-anchor-nav.spec.ts tests/useAttendanceAdminScheduling.spec.ts --watch=false
```

Result: pass

Notes:

- active-section edit buttons remain visible in focused mode
- admin anchor navigation still works
- scheduling admin behavior still passes its existing focused tests

### Type checks

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result: pass

### Contract generation

```bash
pnpm exec tsx packages/openapi/tools/build.ts
```

Result: pass

### Frontend production build

```bash
pnpm --filter @metasheet/web build
```

Result: pass

## Observations

- `/api/metrics/prom` remains out of scope for this hotfix. Current supported path is `/metrics/prom`.
- The reported "invisible edit button" issue was not fixed by forcing all sections visible. The fix keeps focused mode and proves the active section exposes visible controls.
- A full-file run of `packages/core-backend/tests/integration/attendance-plugin.test.ts` still shows one broader approval-path failure outside this focused regression slice. It was not introduced by this patch set.
