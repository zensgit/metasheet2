# Multitable Automation Select Option Validation Verification

Date: 2026-05-12
Branch: `codex/multitable-automation-select-option-validation-20260512`
Baseline: `origin/main@7a5902f92`

## Scope

Verify backend route-boundary validation for `select` and `multiSelect`
automation condition option values.

## Commands

```bash
pnpm install --ignore-scripts
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-automation-conditions.test.ts \
  tests/integration/dingtalk-automation-link-routes.api.test.ts \
  --reporter=dot
pnpm --filter @metasheet/core-backend exec tsc --noEmit
git diff --check
git restore plugins tools
```

## Results

- `vitest`: passed, 2 files / 48 tests.
- `tsc --noEmit`: passed.
- `git diff --check`: passed.
- `pnpm install --ignore-scripts` created workspace dependency-link noise under
  `plugins/` and `tools/`; those paths were restored before commit.

## Assertions Added

- Unit coverage accepts configured select/multiSelect option values.
- Unit coverage rejects unknown scalar select values.
- Unit coverage rejects unknown list entries with indexed error paths.
- Unit coverage preserves backward compatibility for select-like fields without
  configured options.
- Route coverage rejects unknown select options on create before persistence.
- Route coverage rejects unknown multiSelect options on update before
  persistence.

## Not Covered

- Live PostgreSQL replay is not required; this slice only extends the existing
  field metadata query and pure validator logic.
- Frontend rendering is unchanged.
