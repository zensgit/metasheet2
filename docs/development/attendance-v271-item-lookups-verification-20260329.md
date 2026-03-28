# Attendance v2.7.1 Item Lookup Follow-up Verification

Date: 2026-03-29
Branch: `codex/attendance-v271-followup-20260329`

## Verified scope

- approval flow item lookup exists
- rule set item lookup exists
- payroll cycle item lookup exists
- attendance request responses normalize `work_date` to `YYYY-MM-DD`
- OpenAPI source and generated artifacts match the restored item routes

## Commands

### Focused backend coverage

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "supports request item lookup, update, and delete aliases for self-service follow-up|supports holiday item lookup and rejects invalid holiday date/type payloads before write|supports approval flow, rule set, and payroll cycle item lookup routes|rejects negative leave type daily_minutes aliases, empty holiday names, and exposes holiday type fields" --reporter=dot
```

Result: pass

### Backend typecheck

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result: pass

### OpenAPI generation

```bash
pnpm exec tsx packages/openapi/tools/build.ts
```

Result: pass

### Broader attendance integration

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts --reporter=dot
```

Result: one unrelated pre-existing failure remains

Notes:

- the newly added item lookup test passes in the broader file
- the only remaining failure is the older approval-path expectation in `registers attendance routes and lists plugin`
- this slice does not introduce new failures into the full attendance integration file
