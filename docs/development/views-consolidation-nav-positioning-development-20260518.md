# Views Consolidation Navigation Positioning Development Notes

Date: 2026-05-18

Branch: `codex/views-consolidation-nav-positioning-20260518`

Base: `origin/main@cd3d6f6f9e97ccfc66756e7c35747758f121627f`

## Result

This PR implements the safe frontend-only part of the views consolidation plan:

- The platform shell now presents Multitable as the only top-level table/view product entry.
- Legacy top-level view links (`/kanban`, `/calendar`, `/gallery`, `/form`) are removed from the shell navigation.
- Existing deep links stay registered and authenticated.
- Legacy table/view routes are explicitly marked with route metadata `deprecated: true`.

No backend route, OpenAPI contract, database migration, plugin-integration-core file, K3 adapter file, or multitable runtime contract changed.

## Positioning Decision

The reviewed consolidation draft is directionally correct: the long-term architecture should be "two pillars plus an internal view plugin mechanism".

The product positioning should still be stricter than that architecture statement:

- Primary product: Multitable.
- Secondary capability: Spreadsheets, for free-cell / A1 formula scenarios.
- Non-product surface: Grid and legacy top-level view routes.

The reason is user-facing maturity. Multitable already owns the row-field-multiview product story. Spreadsheets has a real backend and A1 formula engine, but the frontend is not yet mature enough to deserve equal top-level marketing. Grid is an orphan layer between the two and should not be promoted as a product entry.

This PR therefore does not add or promote a Spreadsheets nav entry. It keeps the current shell focused on Multitable while preserving existing routes.

## Scope

In scope:

- Remove legacy top-level shell links for Kanban, Calendar, Gallery, and Form.
- Keep `/grid`, `/kanban`, `/calendar`, `/gallery`, and `/form` route records alive.
- Add `RouteMeta.deprecated` so future cleanup phases can reason about retained legacy deep links without guessing.
- Extend platform shell tests to assert the navigation and metadata contract.

Out of scope:

- Delete dead Grid or legacy view files.
- Redirect `/grid`.
- Change Spreadsheets UI or backend behavior.
- Change multitable APIs or view rendering.
- Change feature flags, home route resolution, or data migration behavior.

## Files Changed

| Path | Purpose |
| --- | --- |
| `apps/web/src/App.vue` | Removes legacy top-level nav links and unused labels. |
| `apps/web/src/router/appRoutes.ts` | Marks retained legacy table/view routes as deprecated. |
| `apps/web/src/router/types.ts` | Adds `RouteMeta.deprecated`; also normalizes unused route guard args to `_from` so targeted lint stays clean. |
| `apps/web/tests/platform-shell-nav.spec.ts` | Verifies legacy links are absent from shell nav and deep routes remain registered with deprecated metadata. |
| `docs/development/views-consolidation-nav-positioning-development-20260518.md` | This development record. |
| `docs/development/views-consolidation-nav-positioning-verification-20260518.md` | Verification record. |

## Behavioral Contract

The intended user-facing behavior after this PR:

- Main navigation shows Multitable, not separate Kanban / Calendar / Gallery / Form products.
- Users with saved or copied legacy links can still open those routes.
- `/grid` remains intentionally unlinked from the shell and now has deprecated metadata for future Phase C retirement.
- No data is deleted, migrated, or rewritten.

## Why Not Redirect Now

The reviewed plan notes that `/grid` historically writes to the Spreadsheets backend and may have user state tied to local storage or existing "Grid Workspace" spreadsheets.

Redirecting or deleting `/grid` in this PR would mix product positioning with data-preservation work. That belongs in a separate Phase C PR with explicit route-gate behavior and rollback notes.

## K3 / Stage-1 Lock Impact

This slice is frontend shell and router metadata only.

- `plugins/plugin-integration-core/**`: not touched.
- `lib/adapters/k3-wise-*`: not touched.
- `packages/core-backend/src/routes/integrations*.ts`: not touched.
- `/api/multitable/*` contract: unchanged.
- `/api/spreadsheets/*` contract: unchanged.

## Follow-Ups

Recommended next slices, in order:

1. Dead-code deletion for confirmed unreachable Grid / formula / plugin-view-grid assets.
2. `/grid` route-gate retirement with explicit preservation of existing Spreadsheet-backed user data.
3. Spreadsheets UI upgrade only if Phase D is funded; until then, keep it secondary.
