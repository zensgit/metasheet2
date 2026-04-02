# PLM Audit Scene Copy Contract Design

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Collapse scattered `scene/owner` copy rules into a single contract shared by:

- token
- input token
- summary card
- saved-view context badge
- team-view local-only note
- source labels

## Change

Added shared helper:

- `apps/web/src/views/plmAuditSceneCopy.ts`

This contract now owns:

- semantic resolution
- semantic label/description copy
- action labels
- action hints
- input-token descriptions
- source labels
- team-view local-only descriptions

The older `plmAuditSceneSourceCopy.ts` remains as a thin re-export to avoid widening churn.

## Expected Result

All audit scene-context surfaces now derive wording from one source instead of repeating strings across multiple helpers.

