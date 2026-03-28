# PLM Workbench Team-Scope List Web Runtime Design

Date: 2026-03-29
Commit: pending

## Context

The previous SDK repair aligned `@metasheet/sdk` with the real team-scope list contract:

- `listTeamViews()` may omit `kind`
- `listTeamFilterPresets()` may omit `kind`
- list metadata may legitimately return `kind: 'all'`

But the web runtime still kept an older, narrower contract in
`apps/web/src/services/plm/plmWorkbenchClient.ts`:

- `listPlmWorkbenchTeamViews(kind)` still required `kind`
- `listPlmTeamFilterPresets(kind)` still required `kind`
- `metadata.kind = 'all'` was filtered out
- no-kind team view lists could not safely map mixed runtime items

That left the runtime consumer layer behind the already-fixed SDK layer.

## Decision

Align the web client with the same team-scope list contract:

- make `listPlmTeamFilterPresets(...)` accept an omitted `kind`
- make `listPlmWorkbenchTeamViews(...)` accept an omitted `kind`
- preserve `metadata.kind = 'all'`
- map no-kind team view results by each item's own runtime `kind`

## Why This Fix

- It completes the same contract chain end-to-end: backend -> OpenAPI -> SDK -> web runtime.
- It removes the residual runtime narrowing introduced by the handwritten web client mapper.
- It keeps existing typed call sites stable by using overloads for the team-view helper.
- It enables mixed team-scope list consumption without mis-normalizing `audit`, `workbench`, or `documents` items.

## Scope

Included:

- `apps/web/src/services/plm/plmWorkbenchClient.ts`
- `apps/web/tests/plmWorkbenchClient.spec.ts`

Not included:

- no backend route change
- no OpenAPI source/dist change
- no SDK change beyond the already-landed previous commit
