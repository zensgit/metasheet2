# PLM Team Scene Recommendation Filter Design

## Goal

Extend the workbench team scene catalog from a recommendation-sorted list into a recommendation-filterable directory.

This slice adds:

- a recommendation filter in the scene catalog toolbar
- a stable, testable recommendation filter contract in the scene catalog helper
- no backend contract change

## Scope

Frontend only:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchSceneCatalog.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmProductPanel.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmPanelModels.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmProductPanel.ts`

## Interaction Design

The scene catalog toolbar now supports two independent filters:

- owner
- recommendation reason

Recommendation options:

- `全部推荐`
- `当前默认`
- `近期默认`
- `近期更新`

The filter is applied after owner filtering and before final truncation to the top 6 cards.

## Recommendation Contract

The workbench scene catalog helper now accepts:

- `ownerUserId`
- `recommendationFilter`

Recommendation ranking remains:

1. current default
2. most recent `lastDefaultSetAt`
3. most recent `updatedAt/createdAt`
4. name asc as final tie-breaker

Filtering uses the already-derived `recommendationReason`, so the page does not need to duplicate business logic.

## Why This Is Better

- It makes the team scene catalog usable as a real browsing surface, not only a passive recommendation strip.
- It keeps recommendation policy centralized in one helper.
- It avoids widening backend risk for a purely UX/product slice.
