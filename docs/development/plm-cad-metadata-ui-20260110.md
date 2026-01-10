# PLM CAD Metadata UI Integration

Date: 2026-01-10

## Scope
Add CAD metadata federation operations (query + mutate) and surface them in the PLM UI.

## Summary
- Extended federation PLM query/mutate to support CAD metadata operations (properties, view state, review, history, diff, mesh stats).
- Added Yuantus CAD metadata methods and mock responses to `PLMAdapter`.
- Added CAD metadata panel to the PLM UI, plus document row actions to select primary/diff file IDs.
- Added deep-link support for CAD panel state (`cadFileId`, `cadOtherFileId`).

## Key Files
- `packages/core-backend/src/routes/federation.ts`
- `packages/core-backend/src/data-adapters/PLMAdapter.ts`
- `apps/web/src/views/PlmProductView.vue`
