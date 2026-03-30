# Attendance Run23 Follow-up Verification

## Edited files

- `apps/web/src/views/AttendanceView.vue`
- `apps/web/tests/attendance-admin-regressions.spec.ts`
- `docs/ATTENDANCE_IMPORT_DINGTALK_CSV.md`
- `docs/ATTENDANCE_CUSTOM_RULE_TEMPLATES.md`
- `docs/ATTENDANCE_IMPORT_TEMPLATE_QUICKSTART.md`
- `docs/ATTENDANCE_ENGINE_TEMPLATES_SYNTAX.md`
- `docs/development/attendance-run23-followup-design-20260330.md`
- `docs/development/attendance-run23-followup-verification-20260330.md`

## Command log

### Diff hygiene

```bash
git diff --check
```

Result: pass

### Frontend targeted regression

```bash
pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-regressions.spec.ts -t "keeps edit buttons visible for the active section while focused mode hides inactive sections|restores the run21 holiday calendar, rule builder, and import template guidance" --watch=false
```

Result: pass (`2 passed`, `2 skipped`)

### Frontend type-check

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result: pass

### Frontend production build

```bash
pnpm --filter @metasheet/web build
```

Result: pass

Notes:

- Vite emitted the existing large-chunk warning for the main web bundle.
- That warning predates this slice and did not block the build.

### Backend item-route audit

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "supports approval flow, rule set, and payroll cycle item lookup while keeping missing item semantics stable|supports request item lookup, update, and delete aliases for self-service follow-up|supports holiday item lookup and rejects invalid holiday date/type payloads before write" --reporter=dot
```

Result: pass (`3 passed`)

This confirms current `main` already serves item routes for:

- requests
- holidays
- approval flows
- rule sets
- payroll cycles

## Repository audits

### Migration conflict audit

```bash
rg -n "add_meta_view_config|meta_view_config" .
```

Result: no matches on current repository state

Interpretation:

- The reported `add_meta_view_config` timestamp conflict is not reproducible from current `main`.
- No migration change was made in this slice.

### Route presence audit

Repository search confirms current plugin routes exist for:

- `/api/attendance/requests/:id`
- `/api/attendance/holidays/:id`
- `/api/attendance/approval-flows/:id`
- `/api/attendance/rule-sets/:id`
- `/api/attendance/payroll-cycles/:id`

## Notes on broader frontend test scope

Running the entire `tests/attendance-admin-regressions.spec.ts` file in this environment still exposes one unrelated existing failure in the split admin-section diagnostics test (`importBatchesNav` lookup). That broader failure is outside the scope of this slice.

The two affected regression paths for this change were run directly and passed.
