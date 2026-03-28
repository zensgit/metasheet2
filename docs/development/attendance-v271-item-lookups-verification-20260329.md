# Attendance v2.7.1 Item Lookups Verification

Date: 2026-03-29
Branch: `codex/attendance-v271-followup-20260329`

## Verified scope

- approval flow item lookup
- rule set item lookup
- payroll cycle item lookup
- request `work_date` / `workDate` date-only response semantics

## Commands

### Focused backend integration

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "supports request item lookup, update, and delete aliases for self-service follow-up|supports holiday item lookup and rejects invalid holiday date/type payloads before write|supports approval flow, rule set, and payroll cycle item lookup while keeping missing item semantics stable|rejects negative leave type daily_minutes aliases, empty holiday names, and exposes holiday type fields" --reporter=dot
```

Result: pass

Notes:

- `4 passed`
- approval flow, rule set, and payroll cycle item lookups return `200`
- missing item ids return `404`
- request item responses keep `work_date` and `workDate` normalized to the same date-only value

### Backend type check

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result: pass

### Source integrity

```bash
git diff --check
```

Result: pass

### Broader attendance integration spot-check

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts --reporter=dot
```

Result: one unrelated existing failure remains

Notes:

- the file now runs with only one remaining failure in the older approval-path smoke
- the item lookup parity changes do not introduce new full-file failures

### OpenAPI build parity

```bash
pnpm exec tsx packages/openapi/tools/build.ts
```

Result: pass

Notes:

- OpenAPI source already described these item lookups
- this slice verifies runtime parity rather than changing the contract shape
