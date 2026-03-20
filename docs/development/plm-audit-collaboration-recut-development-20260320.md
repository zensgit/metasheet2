# PLM Audit Collaboration Recut Development

Date: 2026-03-20
Base: `origin/main` at `73dbbe5d0acb771b9eaca36fb9dac333cac47bc5`
Branch: `recut/plm-audit-collab-main`

## Scope

Recut the first PLM audit collaboration slice from the legacy workbench branch onto current `main`.

Included:

- PLM audit scene context route/query state
- PLM audit saved-view context summaries
- PLM audit scene copy/token/banner/filter-highlight helpers
- PLM audit team-view context note rendering
- backend audit support for:
  - `plm-team-view-default`
  - `set-default`
  - `clear-default`
  - single-view default audit writes and list/export/summary handling
- focused frontend and backend unit tests

## Explicit exclusions

This slice does not include:

- recommended workbench scene cards
- product/workbench shell rewrites
- `lastDefaultSetAt` hydration
- backend default-signal attachment queries
- PLM product panel or scene catalog changes
- OpenAPI, workflow, attendance, docs, or deployment changes outside this recut

## Implementation notes

- Frontend audit files were recovered from legacy commit `bcb189a68` and then aligned to current `main`.
- `apps/web/src/services/plm/plmWorkbenchClient.ts` was updated only with the audit resource/action and metadata expansions required by the recut.
- `packages/core-backend/src/routes/plm-workbench.ts` keeps the default-scene audit events but intentionally drops the later `attachPlmTeamViewDefaultSignals()` path so this slice remains independent from `lastDefaultSetAt` follow-up work.
