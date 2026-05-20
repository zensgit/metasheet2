# Attendance Calendar Policy Resolver — Verification

Date: 2026-05-20
Branch: `runtime/attendance-calendar-policy-resolver-20260520`
Base: `origin/main@f8b9a5f2e`
Commit: branch tip `feat(attendance): effective calendar resolver + calendarPolicy.overrides + read-only API`

## Definition of Done (gate)

This slice is merge-ready only when the DB-backed effective-calendar
integration tests are executed against a real PostgreSQL database and print
the concrete test case names:

```
✓ tests/integration/attendance-plugin.test.ts > Attendance Plugin Integration > effective-calendar §6.1 baseline equals resolveWorkContext for rule + holiday rows
✓ tests/integration/attendance-plugin.test.ts > Attendance Plugin Integration > effective-calendar §6.2 applies calendarPolicy with mode gates, priority, and normalize drops invalid
✓ tests/integration/attendance-plugin.test.ts > Attendance Plugin Integration > effective-calendar §6.3 returns approved request overlays additively without merging
✓ tests/integration/attendance-plugin.test.ts > Attendance Plugin Integration > effective-calendar validates strictly, enforces RBAC, and 404s missing group
✓ tests/integration/attendance-plugin.test.ts > Attendance Plugin Integration > effective-calendar role/roleTags override is valid config but silently inert in resolver mode
```

A passing run also asserts that the existing Step 2 sync test
(`protects manual holiday origins ...`) is unaffected.

## Commands Run (local, no DB)

| Command | Result |
| --- | --- |
| `pnpm --filter @metasheet/core-backend test:unit` | PASS: 170 files / 2245 tests. |
| `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "effective-calendar" --reporter=dot` | Load check: 4 effective-calendar tests load and early-return without DB URL (auto-skip path). |
| `node --check plugins/plugin-attendance/index.cjs` | PASS. |
| `git diff --check` | PASS. |

## DB-Backed Run

The hard gate is **satisfied** on scratch PostgreSQL 15.17 (Homebrew).

### Environment

```text
PostgreSQL: 15.17 (Homebrew, 127.0.0.1:5432)
Scratch DB: effcal_test_<epoch> (created and dropped within the same test run)
ATTENDANCE_TEST_DATABASE_URL=postgresql://127.0.0.1:5432/effcal_test_<epoch>
DATABASE_URL=postgresql://127.0.0.1:5432/effcal_test_<epoch>
```

### Command (verbatim)

```bash
ATTENDANCE_TEST_DATABASE_URL=postgresql://127.0.0.1:5432/<scratch-db> \
  DATABASE_URL=postgresql://127.0.0.1:5432/<scratch-db> \
  pnpm --filter @metasheet/core-backend exec vitest \
    --config vitest.integration.config.ts \
    run tests/integration/attendance-plugin.test.ts \
    -t "effective-calendar|protects manual holiday origins" \
    --reporter=verbose
```

### Result (real run, 2026-05-20)

```
✓ tests/integration/attendance-plugin.test.ts > Attendance Plugin Integration > protects manual holiday origins during national holiday sync
✓ tests/integration/attendance-plugin.test.ts > Attendance Plugin Integration > effective-calendar §6.1 baseline equals resolveWorkContext for rule + holiday rows
✓ tests/integration/attendance-plugin.test.ts > Attendance Plugin Integration > effective-calendar §6.2 applies calendarPolicy with mode gates, priority, and normalize drops invalid
✓ tests/integration/attendance-plugin.test.ts > Attendance Plugin Integration > effective-calendar §6.3 returns approved request overlays additively without merging
✓ tests/integration/attendance-plugin.test.ts > Attendance Plugin Integration > effective-calendar validates strictly, enforces RBAC, and 404s missing group
✓ tests/integration/attendance-plugin.test.ts > Attendance Plugin Integration > effective-calendar role/roleTags override is valid config but silently inert in resolver mode

 Test Files  1 passed (1)
      Tests  6 passed | 66 skipped (72)
```

The Step 2 sync regression (`protects manual holiday origins ...`) ran first
and passes unchanged — confirming the resolver / shared-predicate refactor did
not touch the existing holiday-sync writer or its counters.

## Regression Matrix

| RFC Section | Case | Covered by test |
| --- | --- | --- |
| §6.1 default-working day equivalence | weekday in [1..5] without holiday or override | "baseline equals resolveWorkContext" |
| §6.1 default rest day equivalence | weekday in [0, 6] without holiday or override | same |
| §6.1 national/manual holiday overrides profile | `is_working_day=false` row | same |
| §6.1 working-day-override row | `is_working_day=true` row | same |
| §6.2 org policy changes national to working day | `effective.source='org'`, base remains national | "applies calendarPolicy with mode gates" |
| §6.2 group policy applies only to group members | `effective.source='group'` | same |
| §6.2 user policy overrides group policy | priority `user(4) > group(2) > org(1)` | same |
| §6.2 mode gates strict | userId={org,group,user}; groupId={group}; orgOnly={org} | same |
| §6.2 normalize drops invalid | 3 invalid + 3 valid overrides POSTed; only 3 returned | same |
| §6.3 leave / overtime / correction overlays | additive, no merge, sources tagged | "returns approved request overlays additively" |
| Validation: missing from/to | 400 | "validates strictly" |
| Validation: invalid date | 400 | same |
| Validation: no mode | 400 | same |
| Validation: two modes | 400 | same |
| Validation: range > 366 days | 400 | same |
| RBAC: read-only querying other user | 403 | same |
| RBAC: read-only querying self | 200 | same |
| RBAC: read+approve querying other user | 200 | same |
| RBAC: read-only using groupId | 403 | same |
| groupId not found | 404 | same |
| Known Limitation: `effective.source='role'` config is preserved but resolver does not match | role override stays in saved settings; no `calendar_policy` layer produced; `effective.source='rule'` (base) | "role/roleTags override is valid config but silently inert in resolver mode" |

## Static Evidence

- `attendance_holidays.origin` semantics from Step 2 are untouched; the
  resolver reads `origin` but never writes it.
- `resolveWorkContext` and its prefetch sibling remain unchanged; calc-chain
  cutover is deferred to Step 5.
- New shared predicates (`matchScopeFilters`, `matchDayIndexFilter`) are
  consumed by both `matchHolidayOverrideFilters` (existing payroll callers)
  and `matchCalendarOverride` (new resolver). Unit suite confirms no
  behavioral regression on `holidayPolicy.*` callers (170 files / 2245 tests
  pass after refactor).
- `mergeSettings` adds a `calendarPolicy` branch so a partial PATCH does not
  shallow-merge away nested `overrides`.

## Remaining Gate

No DB gate remains for this slice. The scratch PostgreSQL run above executed
all 5 effective-calendar assertions (including the role/roleTags inert-mode
limitation guard) plus the Step 2 sync regression.

## Known Limitations

See `attendance-calendar-policy-resolver-development-20260520.md` § "Known
Limitations (v1)":

1. `role` / `roleTags` filters silently inert in resolver mode (no DB context
   loader; documented).
2. `groupId` mode uses default rule for base; group `rule_set` working days
   not applied in v1.
3. Per-user-per-day real-time resolve; large batch use cases deferred to
   Phase 2 materialization.
