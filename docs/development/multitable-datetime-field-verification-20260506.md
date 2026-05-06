# Multitable DateTime Field Verification — 2026-05-06

## Environment

- Worktree: `/tmp/ms2-datetime-field-20260506`
- Branch: `codex/multitable-datetime-field-20260506`
- Base: `origin/main@df43ae9b6`
- Package manager: `pnpm`

`pnpm install --frozen-lockfile` was required in this temporary worktree because `vitest` was not linked. The install created plugin/tool `node_modules` link noise; it was removed with `git checkout -- plugins tools` before verification continued.

## Verification Commands

### Backend focused tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-field-types-batch1.test.ts \
  tests/unit/field-validation.test.ts \
  --reporter=dot
```

Result: `2 passed`, `152 tests passed`.

Coverage locked:

- `dateTime` literal and alias mapping.
- `date` remains `date`.
- Timezone property sanitization and `UTC` fallback.
- ISO coercion and invalid timestamp rejection.
- `coerceBatch1Value()` dispatch and empty-value normalization.
- Default validation remains empty because write coercion owns timestamp shape validation.

### Frontend focused tests

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-datetime-field.spec.ts \
  tests/multitable-field-manager.spec.ts \
  --watch=false \
  --reporter=dot
```

Result: `2 passed`, `20 tests passed`.

Note: Vitest printed `WebSocket server error: Port is already in use`, but the command exited 0 and all targeted tests passed.

Coverage locked:

- DateTime timezone helper and `datetime-local` conversion helpers.
- Cell renderer DateTime branch.
- Cell editor `datetime-local` branch emitting ISO/null values.
- Field manager creates `dateTime` fields.
- Form view submits ISO values.
- Record drawer patches ISO values.

### Backend build

```bash
pnpm --filter @metasheet/core-backend build
```

Result: passed.

### Frontend type-check

```bash
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result: passed.

### OpenAPI generation and parity

```bash
pnpm exec tsx packages/openapi/tools/build.ts
node --test scripts/ops/multitable-openapi-parity.test.mjs
```

Result: OpenAPI dist rebuilt; parity test `1 passed`.

### Diff hygiene

```bash
git diff --check
```

Result: passed.

## Manual Smoke Plan

After deployment:

1. Create a new multitable field with type `dateTime`.
2. Edit a grid cell using the DateTime picker and save.
3. Reopen the record drawer and confirm the same value displays.
4. Edit the same field from form view and confirm the REST payload persists an ISO timestamp.
5. Configure Calendar, Timeline, or Gantt using the DateTime field as a date source and confirm records render in the view.

## Known Limits

- The browser `datetime-local` picker does not expose an explicit timezone selector.
- Field `property.timezone` affects display formatting only.
- Existing `date` fields are not migrated.
