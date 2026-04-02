# PLM Team Scene Recommendation Design

## Goal

Upgrade the workbench team scene catalog from a static owner-filtered list into a recommendation-aware directory.

This slice adds two product signals:

- `lastDefaultSetAt`: the most recent time a team scene was set as default
- `recommendationReason`: whether a scene is recommended because it is the current default, was recently set as default, or was recently updated

## Scope

Backend:

- enrich PLM workbench team view responses with `lastDefaultSetAt`
- reuse `operation_audit_logs` instead of changing the `plm_workbench_team_views` schema
- hydrate both list responses and default-action/save-default responses so frontend local state does not lose the signal after mutation

Frontend:

- extract scene catalog ranking into a dedicated helper
- sort workbench scene cards by:
  - current default first
  - most recent `set-default`
  - most recent `updatedAt/createdAt`
- show recommendation badges and the latest default-set timestamp on scene cards

## Files

Backend:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend/src/routes/plm-workbench.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend/src/plm/plmWorkbenchTeamViews.ts`

Frontend:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchSceneCatalog.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmProductPanel.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmPanelModels.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/services/plm/plmWorkbenchClient.ts`

## Backend Design

Team-view routes already emit `plm-team-view-default` audit logs for:

- `POST /api/plm-workbench/views/team/:id/default`
- `DELETE /api/plm-workbench/views/team/:id/default`
- `POST /api/plm-workbench/views/team` with `isDefault: true`

The new helper `attachPlmTeamViewDefaultSignals()` performs a best-effort aggregation:

- group `operation_audit_logs` by `resource_id`
- only consider `resource_type = 'plm-team-view-default'`
- only consider `action = 'set-default'`
- attach `last_default_set_at` back onto returned team-view rows

This keeps the implementation schema-free while remaining compatible with old callers. If the audit lookup fails, the team-view API still returns successfully without the signal.

## Frontend Design

The scene catalog now consumes a dedicated helper:

- `buildWorkbenchSceneCatalogOwnerOptions()`
- `buildRecommendedWorkbenchScenes()`

This prevents recommendation policy from remaining embedded in `PlmProductView.vue`.

Each recommended scene now exposes:

- `lastDefaultSetAt`
- `recommendationReason`

Card presentation rules:

- `默认` badge for the current default scene
- `近期默认` badge for non-default scenes with a recent default-set signal
- `近期更新` badge for the remaining recommended scenes
- preserve `更新于`
- add `最近设默认`

## Why This Is Better

- It productizes the scene catalog instead of only adding another filter.
- It improves recommendation quality without changing the team-view storage model.
- It keeps recommendation policy testable and decoupled from the page shell.
- It preserves mutation UX by hydrating default signals in mutation responses, not only in list responses.
