# PLM Audit External Route Provenance Cleanup Design

Date: 2026-03-24

## Problem

`PLM Audit` already cleans transient UI ownership when local actions take over the route, but two external/raw route paths still leaked state:

1. External `scene-context` re-entry only triggered takeover cleanup when `q`, `sceneId`, `sceneName`, or `sceneOwnerUserId` changed. If the same scene/query was reopened with different `sceneRecommendationReason`, `sceneRecommendationSourceLabel`, or `returnToPlmPath`, the page kept stale collaboration/share-entry/form-draft state.
2. Ownerless raw `set-default` log routes (`teamViewId=''`, `action='set-default'`, `resourceType='plm-team-view-default'`) were not treated as log-route form-draft takeovers, so stale management-owned name/owner drafts could survive browser back/deep-link pivots.

## Design

### 1. Treat scene recovery metadata as takeover-significant

`shouldTakeOverPlmAuditSceneContextOnRouteChange(...)` now compares the full scene recovery contract:

- `q`
- `sceneId`
- `sceneName`
- `sceneOwnerUserId`
- `sceneRecommendationReason`
- `sceneRecommendationSourceLabel`
- `returnToPlmPath`

If any of those fields change while the next route is still an active `scene-context`, the watcher treats it as a new scene takeover and runs the existing scene cleanup path.

### 2. Separate “ownerless log route” draft cleanup from lifecycle-only detection

`isPlmAuditOwnerlessTeamViewLifecycleLogRoute(...)` stays narrow and continues to describe lifecycle/clear-default routes only.

A new helper, `shouldClearPlmAuditTeamViewFormDraftsOnLogRoute(...)`, decides whether management-owned form drafts must be cleared based on:

- the next log-route shape, and
- whether any canonical management owner survives (`route teamViewId` or followup-backed owner).

This keeps source-driven `set-default` followups intact, while clearing stale form drafts for raw/generic ownerless `set-default` log routes.

## Files

- [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue)
- [plmAuditSceneContext.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSceneContext.ts)
- [plmAuditTeamViewAudit.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewAudit.ts)
- [plmAuditSceneContext.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditSceneContext.spec.ts)
- [plmAuditTeamViewAudit.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditTeamViewAudit.spec.ts)

## Non-goals

- No OpenAPI or backend changes.
- No expansion into selector/actionability trimming.
- No new persistent storage or route keys.
