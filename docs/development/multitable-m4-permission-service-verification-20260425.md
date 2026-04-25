# Multitable M4 permission-service extraction verification

Date: 2026-04-25
Branch: `codex/multitable-m4-permission-service-20260425`
Base: `origin/main@5727a6f7a`

## Commands

Run from worktree root:

```bash
pnpm install --prefer-offline --ignore-scripts
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-permission-service.test.ts \
  tests/unit/multitable-access.test.ts \
  tests/unit/permission-derivation.test.ts \
  tests/unit/multitable-records.test.ts \
  tests/unit/multitable-query-service.test.ts \
  tests/unit/multitable-record-permissions.test.ts \
  tests/unit/multitable-plugin-scope.test.ts \
  tests/unit/multitable-attachment-service.test.ts \
  tests/unit/multitable-member-group-acl-hardening.test.ts \
  --reporter=dot
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/multitable-sheet-permissions.api.test.ts \
  tests/integration/multitable-context.api.test.ts \
  tests/integration/multitable-record-patch.api.test.ts \
  tests/integration/multitable-view-config.api.test.ts \
  tests/integration/multitable-sheet-realtime.api.test.ts \
  --reporter=dot
```

## Results

### Typecheck

`pnpm --filter @metasheet/core-backend exec tsc --noEmit` → exit `0`.

### Unit tests

```text
Test Files  9 passed (9)
Tests       118 passed (118)
```

Breakdown:

- `multitable-permission-service.test.ts`: 29 / 29 (new).
- `multitable-access.test.ts`: 8 / 8.
- `permission-derivation.test.ts`: 18 / 18.
- `multitable-records.test.ts`: 13 / 13.
- `multitable-query-service.test.ts`: 4 / 4.
- `multitable-record-permissions.test.ts`: 11 / 11.
- `multitable-plugin-scope.test.ts`: 7 / 7.
- `multitable-attachment-service.test.ts`: 24 / 24.
- `multitable-member-group-acl-hardening.test.ts`: 4 / 4.

### Integration tests (permission paths)

```text
Test Files  5 passed (5)
Tests       66 passed (66)
```

Breakdown:

- `multitable-sheet-permissions.api.test.ts`: 39 / 39 (all owner / viewer /
  editor / admin / cross-tenant / write-own / share cases).
- `multitable-context.api.test.ts`: 14 / 14.
- `multitable-record-patch.api.test.ts`: 6 / 6.
- `multitable-view-config.api.test.ts`: 4 / 4.
- `multitable-sheet-realtime.api.test.ts`: 3 / 3.

Stderr warnings seen in `multitable-sheet-permissions.api.test.ts` and
`multitable-sheet-realtime.api.test.ts` (`Unhandled SQL in test: SELECT
DISTINCT field_id FROM formula_dependencies`) are pre-existing test-mock
noise unrelated to this extraction.

## LoC delta proof

```
pnpm --filter @metasheet/core-backend exec tsc --noEmit
git diff HEAD -- packages/core-backend/src/routes/univer-meta.ts | grep -c '^-[^-]'
# 1072
git diff HEAD -- packages/core-backend/src/routes/univer-meta.ts | grep -c '^+[^+]'
# 38
git diff --stat HEAD -- packages/core-backend/src/routes/univer-meta.ts
# packages/core-backend/src/routes/univer-meta.ts | 1110 +----------------------
# 1 file changed, 38 insertions(+), 1072 deletions(-)
wc -l packages/core-backend/src/multitable/permission-service.ts
# 1142 packages/core-backend/src/multitable/permission-service.ts
```

`univer-meta.ts` shrinks by 1034 lines; `permission-service.ts` contributes
1142 lines. The extraction preserves behavior (no SQL / predicate / order
changes); the ~100-line overhead is the new file's module header, JSDoc,
and explicit `export` keyword prefixes on types/constants/functions that
were internal `type`/`function` declarations in the monolith.

## Coverage notes

- The new `multitable-permission-service.test.ts` exercises:
  - Predicates: `isSheetPermissionSubjectType`, `deriveSheetAccessLevel`,
    `summarizeSheetPermissionCodes`.
  - Capability composition: `applySheetPermissionScope`,
    `applyContextSheetReadGrant`, `applyContextSheetRecordWriteGrant`,
    `applyContextSheetSchemaWriteGrant`, `canReadWithSheetGrant`,
    `deriveCapabilityOrigin`.
  - Row-action helpers: `deriveRowActions`, `requiresOwnWriteRowPolicy`,
    `deriveDefaultRowActions`, `deriveRecordRowActions`,
    `buildRowActionOverrides`, `ensureRecordWriteAllowed` (with and
    without the `recordScopeMap` fallback).
  - Scope loaders: `loadSheetPermissionScopeMap` (including subject
    precedence and missing-table tolerance), `loadViewPermissionScopeMap`,
    `loadFieldPermissionScopeMap`, `loadRecordPermissionScopeMap`,
    `hasRecordPermissionAssignments`, `loadRecordCreatorMap`.
  - Request-keyed resolvers: `filterReadableSheetRowsForAccess` (admin
    fast-path and scoped filter), `resolveReadableSheetIds`,
    `resolveSheetCapabilities`.
- Four exports are deliberately verified only via integration tests
  because they are SQL-heavy enumeration / enrichment pipelines:
  `listSheetPermissionEntries`, `listSheetPermissionCandidates`,
  `enrichFormShareCandidatesWithDingTalkStatus`, and
  `resolveSheetReadableCapabilities`. Their route surface is covered by
  `multitable-sheet-permissions.api.test.ts`, which exercises all 39
  owner / editor / viewer / write-own / cross-tenant / share-form paths
  against the live route and passes unchanged.
- Existing `multitable-access.test.ts` remains green, proving the
  access.ts / permission-service.ts split composes correctly.

## Review hardening verification — 2026-04-25

Focused command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-permission-service.test.ts \
  --reporter=verbose
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result:

```text
Test Files  1 passed (1)
Tests       31 passed (31)
tsc         exit 0
```

Additional assertions added:

- `resolveReadableSheetIds trims before deduplication`
- `listSheetPermissionCandidates batches role permission eligibility lookups`

## Local environment note

`pnpm install --prefer-offline --ignore-scripts` was required because this
worktree did not have workspace dependency links yet. The resulting
`node_modules` entries are install artifacts and are not staged.
