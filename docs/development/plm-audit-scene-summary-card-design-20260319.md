# PLM Audit Scene Summary Card Design

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`
Workspace: `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench`

## Goal

Link scene context directly into the audit summary area so the user can pivot context from the same place they read top-level audit metrics.

## Problem

The previous scene-context improvement added banner-level actions, but the summary cards still behaved as if the audit page had no scene-specific context. That created a split interaction model:

- context actions lived in the banner
- summary information lived below with no visible linkage

## Design

Add a fourth summary card when scene context exists.

### Card states

1. Owner shortcut state

- label: `Scene owner`
- value: `sceneOwnerUserId`
- description explains that the summary can pivot to owner-related activity
- action: `Filter by owner`

2. Owner active state

- label: `Owner context`
- value: `sceneOwnerUserId`
- description explains that the summary is currently aligned to owner-related activity
- action: `Restore scene query`

3. Scene-only fallback state

- label: `Scene query`
- value: `sceneName` or `sceneId`
- description explains that the audit summary is linked to the selected scene context
- no action

## Implementation

Pure helper:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSceneSummary.ts`

The helper keeps the summary card contract deterministic and testable. `PlmAuditView.vue` only renders the result and routes the action back to the already existing:

- `applyAuditSceneOwnerContext()`
- `restoreAuditSceneQuery()`

## Files

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSceneSummary.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditSceneSummary.spec.ts`
