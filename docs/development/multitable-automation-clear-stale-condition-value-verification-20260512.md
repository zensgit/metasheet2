# Multitable Automation Clear Stale Condition Value Verification

Date: 2026-05-12
Branch: `codex/multitable-automation-clear-stale-condition-value-20260512`
Baseline: `origin/main@3ce512401`

## Scope

Verify the frontend rule editor clears stale condition values when changing a
condition field, while preserving compatible operators.

## Commands

```bash
pnpm install --ignore-scripts
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-automation-rule-editor.spec.ts \
  --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
git diff --check
git restore plugins tools
```

## Results

- `multitable-automation-rule-editor.spec.ts`: passed, 77/77 tests.
- `vue-tsc --noEmit`: passed.
- `git diff --check`: passed.
- `pnpm install --ignore-scripts` created workspace dependency-link noise under
  `plugins/` and `tools/`; those paths were restored before commit.

## Assertions Added

- A condition can be authored as `Priority equals high`.
- Changing the condition field to another select field keeps `equals`.
- The old `high` value is cleared.
- Save is disabled until a value for the new field is selected.
- Saving after selecting the new value emits the new field/value pair only.

## Not Covered

- No backend route behavior changed in this slice.
- No async option hydration for person/link/lookup fields was added.
