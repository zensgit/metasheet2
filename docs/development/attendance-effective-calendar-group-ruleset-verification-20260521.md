# Attendance Effective Calendar Group Rule Set Verification

Date: 2026-05-21
Branch: `codex/attendance-effective-calendar-group-ruleset-20260521`

## Verification Matrix

| Layer | Command | Result |
| --- | --- | --- |
| Plugin syntax | `node --check plugins/plugin-attendance/index.cjs` | PASS |
| Focused backend unit | `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-effective-calendar-role-context.test.ts --reporter=dot` | PASS, 5 tests |
| Backend catalog/formula/effective-calendar regression | `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-catalog.test.ts tests/unit/attendance-report-field-formula-engine.test.ts tests/unit/attendance-effective-calendar-role-context.test.ts --reporter=dot` | PASS, 61 tests |
| Backend build | `pnpm --filter @metasheet/core-backend build` | PASS |
| Frontend type-check | `pnpm --filter @metasheet/web type-check` | PASS |
| Whitespace | `git diff --check` | PASS |

## Focused Evidence

- `groupId` with `attendance_groups.rule_set_id` and rule-set
  `workingDays: [6]` returns Saturday as `base.isWorkingDay=true` and
  `effective.isWorkingDay=true`.
- The same response reports `timezone=Asia/Shanghai` from the rule set before
  falling back to the group timezone.
- A group without `rule_set_id` does not query `attendance_rule_sets` and
  retains the default-rule Saturday rest-day result.

Semantic note: User belonging to a group with `rule_set_id` will see different
calendars between `groupId`-mode preview and `userId`-mode preview; this is the
intended boundary in this slice, deferred to a separate product decision.

## Schema-Degrade Gate

The fallback is intentionally narrow: it only catches errors classified by
`isDatabaseSchemaError()` while loading group `rule_set_id` / rule-set config
for the read-only `groupId` resolver path. The classifier recognizes:

- PostgreSQL code `42P01` (`undefined_table`).
- PostgreSQL code `42703` (`undefined_column`).
- Message text containing `relation` or `table` plus `does not exist`.
- Message text containing `column` plus `does not exist`.

## Boundary Checks

- No migration file added or edited.
- No `attendance_*` fact-source write path changed.
- No direct `meta_*` SQL write.
- No frontend or client-side validator change.
- `userId` calculation-chain behavior is intentionally unchanged.

## Commands Run

```bash
node --check plugins/plugin-attendance/index.cjs
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-report-field-catalog.test.ts \
  tests/unit/attendance-report-field-formula-engine.test.ts \
  tests/unit/attendance-effective-calendar-role-context.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web type-check
git diff --check
```
