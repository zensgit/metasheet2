# Multitable Workbench Base Picker Quick Access Verification

Date: 2026-05-18

Branch: `codex/multitable-workbench-base-picker-quick-access-20260518`

## Result

PASS. The Workbench Base picker now reuses the same browser-local favorite and recent-open state as the `/multitable` home entry.

## Commands

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

Result: PASS.

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/meta-base-picker.spec.ts \
  tests/multitable-base-local-state.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  --watch=false
```

Result: PASS, 3 files / 59 tests.

## Coverage

- `MetaBasePicker` renders decorated Bases in provided order.
- Favorite toggle emits `toggle-favorite` and does not emit `select`.
- Workbench records successful Base switches as recent opens.
- Workbench failed Base switches do not record the failed Base.
- Workbench favorite state reorders picker props and persists through localStorage.
- Existing `base-local-state` corruption fallback and deterministic sorting tests still pass.

## Scope Check

- No backend source changes.
- No database migration changes.
- No OpenAPI changes.
- No route or permission changes.
- No Data Factory, K3, DingTalk, Attendance, or Phase 3 TODO status changes.

## Additional Verification

```bash
pnpm --filter @metasheet/web exec eslint \
  src/multitable/components/MetaBasePicker.vue \
  src/multitable/views/MultitableWorkbench.vue \
  tests/meta-base-picker.spec.ts \
  tests/multitable-workbench-view.spec.ts
```

Result: PASS with warning-only output from existing lint rules (`vue/one-component-per-file` in the long Workbench test file and one pre-existing Workbench template linebreak warning). No lint errors.

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result: PASS.

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result: PASS.

```bash
git diff --check
```

Result: PASS.

Secret-pattern scan over touched files:

Result: PASS, 0 matches.

Install noise cleanup:

```bash
git diff --name-only | rg '(^plugins/.*/node_modules|^tools/cli/node_modules)' | xargs git restore --
```

Result: PASS. Remaining changes are limited to the intended source, test, and documentation files.
