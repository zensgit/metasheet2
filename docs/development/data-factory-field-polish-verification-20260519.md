# Data Factory field polish verification - 2026-05-19

## Scope

Branch: `codex/data-factory-field-polish-20260519`

Files changed:

- `apps/web/src/views/IntegrationWorkbenchView.vue`
- `apps/web/tests/IntegrationWorkbenchView.spec.ts`
- `docs/development/data-factory-field-polish-design-20260519.md`
- `docs/development/data-factory-field-polish-verification-20260519.md`

No backend, plugin runtime, migration, API route, or package script changed.

## Local verification

### Workbench focused spec

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts --watch=false
```

Result:

```text
Test Files  1 passed (1)
Tests       7 passed (7)
```

Covered assertions:

- Mapping section uses "one cleansing item per row" copy.
- Add button says `新增自定义清洗项`.
- Mapping summary renders `code -> FNumber` and transform detail.
- Run/push explainer documents dry-run, Save-only, no Submit/Audit, and dead
  letter behavior.
- Generated pipeline name hint is visible and the one-click generated name is
  used in the saved pipeline payload.
- Pipeline mode, idempotency fields, and saved pipeline ID help text is visible.
- Existing dry-run/export/Save-only behavior remains covered.

### Type-check

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Result:

```text
@metasheet/web@2.0.0-alpha.1 type-check
vue-tsc -b
exit 0
```

### Production build

Command:

```bash
pnpm --filter @metasheet/web build
```

Result:

```text
vue-tsc -b && vite build
built in 6.07s
exit 0
```

### Diff hygiene

Command:

```bash
git diff --check
```

Result: exit 0.

## Issue #651 mapping

| Feedback | Result |
| --- | --- |
| One cleansing item per row | Mapping table is now a list of expandable mapping cards. |
| Keep custom cleansing item support | Existing add behavior remains, button renamed to `新增自定义清洗项`. |
| Explain run/push behavior | Run explainer states read/write scope, overwrite behavior, and failure path. |
| Auto-generate pipeline name | Pipeline name shows generated default and can be applied with one click. |
| Explain mode/idempotency/pipeline ID | Help text added below each field. |

## Entity-machine expectation

This change should not affect the already-passing issue1542 smoke path. The next
on-prem package retest should focus on visual/UX confirmation in
`/integrations/workbench` rather than backend behavior.
