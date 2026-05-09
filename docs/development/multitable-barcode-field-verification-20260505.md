# Multitable Barcode Field Verification - 2026-05-05

## Scope

Verifies the `barcode` field slice:

- Backend type mapping and write coercion.
- Backend default validation rule alignment.
- Frontend field creation, rendering, editing, form submit, and drawer patching.
- OpenAPI contract generation and parity.
- Build/type/diff gates.

## Commands

### Dependency Bootstrap

```bash
pnpm install --frozen-lockfile
```

Result: passed. `pnpm` relinked tracked plugin/tool `node_modules` shims in this worktree; those generated path changes were reverted before commit.

### OpenAPI Generation

```bash
pnpm exec tsx packages/openapi/tools/build.ts
```

Result: passed. `packages/openapi/dist/combined.openapi.yml`, `openapi.json`, and `openapi.yaml` were regenerated with `barcode` in `MultitableFieldType`.

### Backend Focused Tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-field-types-batch1.test.ts tests/unit/field-validation.test.ts --reporter=dot
```

Result: passed.

```text
Test Files  2 passed (2)
Tests       138 passed (138)
```

### Frontend Focused Tests

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-barcode-field.spec.ts tests/multitable-field-manager.spec.ts --watch=false --reporter=dot
```

Result: passed.

```text
Test Files  2 passed (2)
Tests       19 passed (19)
```

Note: local Vitest printed `WebSocket server error: Port is already in use`; the test process still exited `0`. This is the known web test harness port warning.

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

### OpenAPI Runtime Parity

```bash
node --test scripts/ops/multitable-openapi-parity.test.mjs
```

Result: passed.

```text
tests 1
pass  1
fail  0
```

### Whitespace Guard

```bash
git diff --check
```

Result: passed.

## Assertions Covered

- `mapFieldType()` recognizes `barcode`, `bar_code`, and `bar-code`.
- `BATCH1_FIELD_TYPES` includes `barcode`.
- `validateBarcodeValue()` trims strings, converts numbers to strings, returns `null` for empty values, rejects object/array values, and rejects values longer than 256 characters.
- `coerceBatch1Value('barcode', ...)` dispatches through barcode coercion.
- `getDefaultValidationRules('barcode')` returns `maxLength: 256`.
- Frontend field manager can create a `barcode` field without extra property.
- Cell renderer displays barcode values as monospace copy-friendly text.
- Cell editor, form view, and record drawer submit barcode values through text inputs.
- OpenAPI generated enum and parity test include `barcode`.

## Deferred

- Camera/scanner integration.
- Barcode image rendering.
- Barcode uniqueness or checksum validation.
- Manual staging verification in the RC smoke checklist.

