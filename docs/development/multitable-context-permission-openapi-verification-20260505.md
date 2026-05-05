# Multitable Context Permission OpenAPI Verification - 2026-05-05

## Commands

```bash
pnpm install --frozen-lockfile
pnpm verify:multitable-openapi:parity
pnpm exec tsx packages/openapi/tools/validate.ts packages/openapi/dist/openapi.yaml
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-client.spec.ts \
  tests/multitable-scoped-permissions.spec.ts \
  tests/multitable-form-share-manager.spec.ts \
  --watch=false
git diff --check
```

## Results

| Check | Result | Notes |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | PASS | Installed dependencies in the temporary worktree. |
| `pnpm verify:multitable-openapi:parity` | PASS | Rebuilt OpenAPI dist and passed the multitable parity test. |
| `pnpm exec tsx packages/openapi/tools/validate.ts packages/openapi/dist/openapi.yaml` | PASS | OpenAPI security validation passed. |
| frontend multitable permission/client specs | PASS | 3 files / 42 tests passed. |
| `git diff --check` | PASS | No whitespace errors. |

## Parity Assertions Added

- `MultitableViewData.meta` still references `MultitableViewMeta`.
- `MultitableSheetPermissionSubjectType` includes `member-group`.
- `MultitableViewMeta.capabilityOrigin` references
  `MultitableCapabilityOrigin`.
- `MultitableViewMeta.permissions` references `MultitableScopedPermissions`.
- `MultitableScopedPermissions` documents field permissions, view permissions,
  default row actions, and per-record row-action overrides.
- `MultitableContext` documents runtime `capabilityOrigin`,
  `fieldPermissions`, and `viewPermissions`.
- `MultitableFormContext` documents runtime `capabilityOrigin`,
  `fieldPermissions`, `viewPermissions`, and `rowActions`.
- Stale `fieldCapabilities` / `dependencyGraph` are rejected on view and form
  context schemas where the runtime no longer emits them.

## Local Worktree Notes

`pnpm install --frozen-lockfile` produced the usual plugin/tool `node_modules`
symlink modifications in this isolated worktree. Those generated dependency
changes were restored before commit and are not part of the patch.

An extra backend integration probe was also attempted:

```bash
pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts \
  run tests/integration/multitable-sheet-permissions.api.test.ts \
  --reporter=dot
```

It failed locally with existing fixture drift (`Unhandled SQL in test` for
record-service and permission-candidate queries). This slice does not change
runtime code, so the failure is recorded as a pre-existing local integration
fixture blocker rather than a regression from the OpenAPI contract update.
