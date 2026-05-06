# Multitable Number Format Verification - 2026-05-05

## Scope

Verifies the `number` field display-format slice:

- Backend property sanitization.
- Frontend field display formatting.
- Field manager create/update payloads.
- Number editor step behavior.
- Type/build gates.

## Commands

### Dependency Bootstrap

```bash
pnpm install --frozen-lockfile
```

Result: passed. `pnpm` relinked tracked plugin/tool `node_modules` shims in this worktree; those generated path changes were reverted before commit.

### Backend Sanitizer Unit Test

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-field-types-batch1.test.ts --reporter=dot
```

Result: passed.

```text
Test Files  1 passed (1)
Tests       65 passed (65)
```

### Frontend Focused Number Format Test

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-number-format.spec.ts --watch=false --reporter=dot
```

Result: passed.

```text
Test Files  1 passed (1)
Tests       5 passed (5)
```

Note: local Vitest printed `WebSocket server error: Port is already in use`; the test process still exited `0`. This is the known web test harness port warning.

### Frontend Field Manager Regression

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-field-manager.spec.ts tests/multitable-number-format.spec.ts --watch=false --reporter=dot
```

Result: passed.

```text
Test Files  2 passed (2)
Tests       19 passed (19)
```

### Backend Build

```bash
pnpm --filter @metasheet/core-backend build
```

Result: passed.

### Frontend Type Check

```bash
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result: passed.

### Whitespace Guard

```bash
git diff --check
```

Result: passed.

## Assertions Covered

- `sanitizeFieldProperty('number', ...)` preserves valid `decimals/thousands/unit` and validation rules.
- Invalid `decimals` is dropped, `thousands` is normalized to boolean, and `unit` is trimmed/capped.
- `formatFieldDisplay()` renders `12,345.60 kg` for a formatted number field.
- Legacy number fields with no display-format property still render raw values, e.g. `12345.678`.
- `MetaFieldManager` emits number field create payloads with format property.
- Existing number field config updates preserve engine-shape validation rules.
- `MetaCellEditor` derives number input `step` from configured decimal precision.

## Deferred

- Manual staging verification remains part of the RC smoke checklist.
- XLSX/CSV formatting is not changed by this slice.
- Locale-specific number formatting is not implemented.

