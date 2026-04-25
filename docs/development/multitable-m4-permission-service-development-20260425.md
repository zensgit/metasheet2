# Multitable M4 permission-service extraction development

Date: 2026-04-25
Branch: `codex/multitable-m4-permission-service-20260425`
Base: `origin/main@5727a6f7a`

## Scope

M4 consolidates the route-level permission resolution logic that was still
inline in `packages/core-backend/src/routes/univer-meta.ts` into a dedicated
multitable seam. The extraction is purely mechanical: identifiers, bodies,
and signatures are preserved.

## What moved and where

New file: `packages/core-backend/src/multitable/permission-service.ts`.

### Types

- `MultitableCapabilityOrigin`
- `MultitableRowActions`
- `SheetPermissionScope`
- `MultitableSheetPermissionSubjectType`
- `MultitableSheetAccessLevel`
- `MultitableSheetPermissionEntry`
- `MultitableSheetPermissionCandidate`

### Constants

- `SHEET_READ_PERMISSION_CODES`, `SHEET_WRITE_PERMISSION_CODES`,
  `SHEET_OWN_WRITE_PERMISSION_CODES`, `SHEET_ADMIN_PERMISSION_CODES`
- `MANAGED_SHEET_PERMISSION_CODES`
- `CANONICAL_SHEET_PERMISSION_CODE_BY_ACCESS_LEVEL`
- `PUBLIC_FORM_CAPABILITIES`

### Predicates / summarisers

- `isSheetPermissionSubjectType`
- `summarizeSheetPermissionCodes`
- `deriveSheetAccessLevel`

### Sheet permission enumeration

- `listSheetPermissionEntries`
- `listSheetPermissionCandidates`
- `enrichFormShareCandidatesWithDingTalkStatus`

### Scope loaders

- `loadSheetPermissionScopeMap`
- `loadViewPermissionScopeMap`
- `loadFieldPermissionScopeMap`
- `loadRecordPermissionScopeMap`
- `hasRecordPermissionAssignments`
- `loadRecordCreatorMap`

### Capability composition

- `applySheetPermissionScope`
- `canReadWithSheetGrant`
- `applyContextSheetReadGrant`
- `applyContextSheetRecordWriteGrant`
- `applyContextSheetSchemaWriteGrant`
- `deriveCapabilityOrigin`

### Row actions

- `deriveRowActions`
- `requiresOwnWriteRowPolicy`
- `deriveDefaultRowActions`
- `deriveRecordRowActions`
- `buildRowActionOverrides`
- `ensureRecordWriteAllowed`

### Request-keyed resolvers

- `filterReadableSheetRowsForAccess`
- `resolveSheetCapabilities`
- `resolveSheetReadableCapabilities`
- `resolveReadableSheetIds`

## Complements, not replaces

- `multitable/access.ts` continues to own request access resolution
  (`resolveRequestAccess`) and base capability derivation (`deriveCapabilities`).
  These remain imported directly by `univer-meta.ts` for non-sheet contexts
  (e.g. automation / comment endpoints).
- `multitable/sheet-capabilities.ts` continues to own the user-id keyed sheet
  capability resolution used by the Yjs bridge and API-token routes. Its
  `applyContextSheetReadGrant` intentionally has simpler semantics than the
  route-specific `applySheetPermissionScope` extracted here; both are
  preserved without behavior change.
- `multitable/permission-derivation.ts` continues to provide the pure
  field / view / record permission derivation used by the response shapers.

## Behavior-preservation promise

- All extracted functions retain their original names, signatures, and bodies.
- SQL strings, error-swallowing clauses (`isUndefinedTableError`), and
  conditional composition order were copied verbatim.
- `univer-meta.ts` now imports every moved symbol and exposes identical
  response payloads at every route — no capability logic was inlined or
  simplified at call sites.

## Non-goals

- No route behavior change.
- No plugin API change.
- No consolidation with `sheet-capabilities.ts` (two distinct call contexts
  still need two distinct entry points).
- No extension of `access.ts`.

## Files

- `packages/core-backend/src/multitable/permission-service.ts` (new, 1142 LoC)
- `packages/core-backend/src/routes/univer-meta.ts` (edited; −1072 / +38)
- `packages/core-backend/tests/unit/multitable-permission-service.test.ts` (new)
- `docs/development/multitable-m4-permission-service-development-20260425.md` (this file)
- `docs/development/multitable-m4-permission-service-verification-20260425.md`
