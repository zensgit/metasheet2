# Multitable Native Person Field Migration Verification - 2026-05-06

## Scope

Focused verification for accepting native `type: "person"` field create/update requests while persisting storage-compatible `link + refKind=user` fields.

## Commands Run

```bash
pnpm install --frozen-lockfile
pnpm exec tsx packages/openapi/tools/build.ts
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-context.api.test.ts --reporter=dot
pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts tests/multitable-workbench-view.spec.ts --watch=false --reporter=dot
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
pnpm verify:multitable-openapi:parity
```

## Results

- `packages/core-backend/tests/integration/multitable-context.api.test.ts`: 17/17 passed.
- `apps/web/tests/multitable-client.spec.ts` + `apps/web/tests/multitable-workbench-view.spec.ts`: 69/69 passed.
- `@metasheet/core-backend build`: passed.
- `@metasheet/web vue-tsc`: passed.
- `verify:multitable-openapi:parity`: passed.

## Added Coverage

- Creating a field with `type: "person"` provisions the system People sheet and persists the field as `type: "link"`.
- Native person create ignores a spoofed `foreignSheetId` and uses the provisioned system People sheet.
- Updating an existing field with `type: "person"` converts it to the same storage-compatible link field shape.
- The `limitSingleRecord` option is preserved for native person create/update.

## Notes

The first attempted backend integration command used the default unit Vitest config and was excluded by repository settings:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/multitable-context.api.test.ts --reporter=dot
```

It was rerun with `vitest.integration.config.ts`, which is the correct integration-test config for this file.

`pnpm install --frozen-lockfile` created local dependency-link noise under `plugins/` and `tools/cli/`; those paths were restored before commit.
