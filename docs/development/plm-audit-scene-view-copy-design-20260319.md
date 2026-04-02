# PLM Audit Scene View Copy Design

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Push the shared audit scene copy contract into the remaining page-level surfaces:

- top scene-context banner
- active filter highlight

This removes the last inline description branches left in `PlmAuditView.vue`.

## Change

Extended `plmAuditSceneCopy.ts` with:

- `buildPlmAuditSceneContextBanner(...)`
- `buildPlmAuditSceneFilterHighlight(...)`

`PlmAuditView.vue` now consumes those helpers instead of constructing banner copy inline.

## Expected Result

- banner and filter highlight share the same source-label language
- view-level copy remains aligned with token/summary/saved-view/team-view semantics
- page code no longer owns its own scene-context prose logic

