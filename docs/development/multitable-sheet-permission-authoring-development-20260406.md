# Multitable Sheet Permission Authoring Development

Date: 2026-04-06
Branch: `codex/multitable-sheet-permission-authoring-20260406`

## Scope
- Add sheet-level permission authoring APIs on the multitable runtime path.
- Add a minimal multitable access manager so sheet writers can grant `read`, `write`, and `write-own`.
- Keep existing scoped permission consumers aligned with the new authoring source.

## Backend
- Added multitable-prefixed authoring endpoints in [univer-meta.ts](/private/tmp/metasheet2-sheet-permission-authoring-20260406/packages/core-backend/src/routes/univer-meta.ts):
  - `GET /api/multitable/sheets/:sheetId/permissions`
  - `GET /api/multitable/sheets/:sheetId/permission-candidates`
  - `PUT /api/multitable/sheets/:sheetId/permissions/:userId`
- Normalized managed sheet permission codes to canonical access levels:
  - `read`
  - `write`
  - `write-own`
- Kept authoring gated by full sheet management capability; `write-own` users remain forbidden.
- Preserved runtime ACL behavior already sourced from `spreadsheet_permissions`.

## Frontend
- Added [MetaSheetPermissionManager.vue](/private/tmp/metasheet2-sheet-permission-authoring-20260406/apps/web/src/multitable/components/MetaSheetPermissionManager.vue) as the minimal authoring surface.
- Wired the manager into [MultitableWorkbench.vue](/private/tmp/metasheet2-sheet-permission-authoring-20260406/apps/web/src/multitable/views/MultitableWorkbench.vue) with a new `Access` manager button.
- Reused `workbench.client` so runtime and workbench tests share the same client surface.
- On successful updates, the workbench reloads sheet meta and the current grid page so scoped permissions refresh immediately.

## Contracts
- Added sheet permission authoring schemas to [base.yml](/private/tmp/metasheet2-sheet-permission-authoring-20260406/packages/openapi/src/base.yml).
- Added the three new multitable permission paths to [multitable.yml](/private/tmp/metasheet2-sheet-permission-authoring-20260406/packages/openapi/src/paths/multitable.yml).
- Regenerated `packages/openapi/dist/*`.

## Tests Added
- Backend integration coverage in [multitable-sheet-permissions.api.test.ts](/private/tmp/metasheet2-sheet-permission-authoring-20260406/packages/core-backend/tests/integration/multitable-sheet-permissions.api.test.ts) for:
  - listing entries and candidates
  - updating access levels
  - rejecting authoring from `write-own`
- Frontend component coverage in [multitable-sheet-permission-manager.spec.ts](/private/tmp/metasheet2-sheet-permission-authoring-20260406/apps/web/tests/multitable-sheet-permission-manager.spec.ts).
- Workbench wiring coverage in [multitable-workbench-view.spec.ts](/private/tmp/metasheet2-sheet-permission-authoring-20260406/apps/web/tests/multitable-workbench-view.spec.ts).

## Notes
- A Claude Code CLI sidecar was attempted only as a read-only review helper. Primary implementation and verification stayed in this worktree under direct control because the sidecar did not produce usable code changes.
- Local plugin `node_modules` link churn came from dependency installation in the temp worktree and is intentionally excluded from delivery scope.
