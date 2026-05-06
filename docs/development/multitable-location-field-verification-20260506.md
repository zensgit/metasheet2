# Multitable Location Field Verification - 2026-05-06

## Scope

Verifies the `location` field slice:

- Backend type mapping and write coercion.
- Backend default validation behavior.
- Frontend display helpers, field creation, rendering, editing, form submit, and drawer patching.
- OpenAPI generation and runtime parity.
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

Result: passed. `packages/openapi/dist/combined.openapi.yml`, `openapi.json`, and `openapi.yaml` were regenerated with `location` in `MultitableFieldType`.

### Backend Focused Tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-field-types-batch1.test.ts tests/unit/field-validation.test.ts --reporter=dot
```

Result: passed.

```text
Test Files  2 passed (2)
Tests       145 passed (145)
```

### Frontend Focused Tests

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-location-field.spec.ts tests/multitable-field-manager.spec.ts --watch=false --reporter=dot
```

Result: passed.

```text
Test Files  2 passed (2)
Tests       20 passed (20)
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

- `mapFieldType()` recognizes `location`, `geo`, `geolocation`, `geo_location`, and `geo-location`.
- `BATCH1_FIELD_TYPES` includes `location`.
- `validateLocationValue()` trims string addresses, normalizes structured values, accepts coordinate aliases, allows coordinate-only values, returns `null` for empty input, and rejects invalid shapes, partial coordinates, out-of-range coordinates, and addresses longer than 512 characters.
- `coerceBatch1Value('location', ...)` dispatches through location coercion.
- `getDefaultValidationRules('location')` returns no default rule because structured shape is enforced in write coercion.
- Frontend display helpers render address objects and coordinate-only objects.
- Field manager can create a `location` field without extra property.
- Cell renderer displays a location-specific value.
- Cell editor, form view, and record drawer submit `{ address }` values from address text inputs.
- OpenAPI generated enum and parity test include `location`.

## Deferred

- Manual staging verification in the RC smoke checklist.
- Map picker, browser geolocation, reverse geocoding, and distance filtering.

