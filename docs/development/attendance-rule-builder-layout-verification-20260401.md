# Attendance Rule Builder Layout Verification

Date: 2026-04-01

## Commands

```bash
git diff --check
pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-regressions.spec.ts tests/attendance-admin-anchor-nav.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

## Results

- `git diff --check`: pass
- `vitest`: pass
  - `tests/attendance-admin-regressions.spec.ts`
  - `tests/attendance-admin-anchor-nav.spec.ts`
  - `26 passed`
- `vue-tsc --noEmit`: pass
- `pnpm --filter @metasheet/web build`: pass

## Assertions Added

- Rule-set admin area exposes:
  - `.attendance__rule-set-workbench`
  - `.attendance__rule-set-basics`
  - `.attendance__rule-builder-shell`
  - `.attendance__rule-set-advanced`
- Existing rule-builder regression expectations remain intact:
  - structured builder copy present
  - preview actions still work
  - import template guidance still renders

## Outcome

The structured rule builder now renders as a dedicated workbench instead of a squeezed mixed grid, while preserving the existing preview and advanced JSON flows.
