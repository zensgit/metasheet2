# Release v2.1.1 (Draft)

Summary
- Kanban MVP end-to-end: backend viewId endpoints + frontend drag-drop persistence
- Data layer and migrations: Kysely + views/view_states (with numeric type fixes)
- CI hardening: strict lockfile, replay + E2E health/smoke, artifacts on failure
- Developer ergonomics: default views initializer; docs for Kysely types

Highlights
- Backend
  - GET `/api/kanban/:viewId` returns `{...config, state}` with ETag/304
  - POST `/api/kanban/:viewId/state` upserts `(view_id,user_id)` and broadcasts `kanban:stateUpdated`
  - Removed legacy spreadsheetId routes from Kanban plugin
- Frontend (Vue 3 + Vite)
  - `KanbanView.vue` fetches by route `:viewId` and persists to `/api/kanban/:viewId/state`
  - Uses `VITE_API_URL` (no hardcoded origins)
- Data layer
  - Kysely DB singleton + migrations: `views`, `view_states`
  - Gantt migration numeric types corrected (`decimal` → `numeric` via `sql`)
- CI
  - Workflows use `--frozen-lockfile` with refreshed `pnpm-lock.yaml`
  - Migration Replay: pg service + pgcrypto + replay + list
  - Observability E2E: health wait + smoke (`scripts/smoke-kanban.sh`)
- Docs & scripts
  - `docs/kysely-type-mapping.md` with migration/type guidance
  - `db:init:views` creates default `board1` Kanban view

Breaking Changes
- None.

Deprecations
- Legacy Kanban routes removed: `/api/kanban/:spreadsheetId`, etc. Use viewId endpoints.

Upgrade Notes
- Run DB migrations on deploy: `pnpm -F @metasheet/core-backend db:migrate`
- (Optional) Seed default view for demos/dev: `pnpm -F @metasheet/core-backend db:init:views`
- Frontend should set `VITE_API_URL` to backend origin.

Verification
- Smoke: `API=$ORIGIN bash scripts/smoke-kanban.sh`
- UI: start backend + frontend, navigate to route with `:viewId` (or default `board1`), drag→refresh→state persists

Rollback
- Revert the Kanban plugin route PR and UI persistence PR if needed; DB migrations are additive and idempotent.

Acknowledgements
- PRs: #94, #96, #98, #100, #101, #102

References
- CI lockfile report: CI_LOCKFILE_REPORT.md
- Kanban test report: KANBAN_TEST_REPORT.md
- Fix summary: FIX_REPORT.md
- Kysely type mapping: docs/kysely-type-mapping.md
- Smoke script usage:
  - API=$ORIGIN bash scripts/smoke-kanban.sh
