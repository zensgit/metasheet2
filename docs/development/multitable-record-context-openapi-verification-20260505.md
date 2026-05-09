# Multitable Record Context OpenAPI Contract Verification - 2026-05-05

## Scope

Verification covered the stacked OpenAPI-only record-context update on top of
PR #1293.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm verify:multitable-openapi:parity
pnpm exec tsx packages/openapi/tools/validate.ts packages/openapi/dist/openapi.yaml
git diff --check
```

## Results

| Check | Result | Notes |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | PASS | Installed workspace dependencies in the temporary worktree. |
| `pnpm verify:multitable-openapi:parity` | PASS | Rebuilt OpenAPI dist and passed the multitable parity test. |
| `pnpm exec tsx packages/openapi/tools/validate.ts packages/openapi/dist/openapi.yaml` | PASS | OpenAPI security validation passed. |
| `git diff --check` | PASS | No whitespace errors. |

## Assertions Added

The parity test now checks that:

- `MultitableRecordContext.capabilityOrigin` references
  `MultitableCapabilityOrigin`.
- `MultitableRecordContext.fieldPermissions` references
  `MultitableFieldPermissions`.
- `MultitableRecordContext.viewPermissions` references
  `MultitableViewPermissions`.
- `MultitableRecordContext.rowActions` references `MultitableRowActions`.
- Required runtime fields include `capabilityOrigin`, `fieldPermissions`, and
  `rowActions`.
- Stale `fieldCapabilities` and `dependencyGraph` are not documented on
  `MultitableRecordContext`.
- `MultitableCapabilityOrigin.source` allows
  `admin`, `global-rbac`, `sheet-grant`, and `sheet-scope`.
- `MultitableCapabilities.required` includes `canManageSheetAccess` and
  `canExport`.

## Risk Notes

- This is a stacked PR and should merge after PR #1293, or be rebased after
  #1293 lands.
- The change is OpenAPI/documentation only; runtime behavior was not modified.
- Generated files were rebuilt from `packages/openapi/src/base.yml`.
