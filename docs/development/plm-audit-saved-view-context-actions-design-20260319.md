# PLM Audit Saved View Context Actions Design

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`
Workspace: `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench`

## Goal

Upgrade saved-view context badges from passive labels to direct scene/owner pivot actions, so users can reopen a saved audit view in the most relevant context without manually editing filters after applying it.

## Problem

The previous slice made saved views show whether they contained:

- `owner context`
- `scene query`

But saved-view cards still required users to:

1. apply the saved view
2. then manually pivot the audit context again

That made the badge informative but not operational.

## Design

### 1. Extend saved-view context badge metadata

`/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSavedViewSummary.ts`

`buildPlmAuditSavedViewContextBadge(...)` now also derives:

- `quickAction.kind`
- `quickAction.label`

Rules:

- active owner context -> quick action is `Restore scene query`
- active scene query -> quick action is `Filter by owner`
- inactive owner shortcut -> quick action is `Filter by owner`
- scene-only shortcut -> no quick action

`clear` is intentionally not exposed on saved-view cards because this surface is meant to accelerate pivots, not strip preserved context.

### 2. Add card-level quick actions

`/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`

Saved-view cards now render a small inline action beside the context badge.
The action does not mutate the stored saved view. It derives a transient route state from `view.state` and applies:

- `withPlmAuditSceneOwnerContext(...)`
- `withPlmAuditSceneQueryContext(...)`

through the normal route sync path.

## Expected Outcome

- Saved views with owner context can quickly restore scene query.
- Saved views with scene query can quickly pivot to owner context.
- Saved-view cards become directly useful for scene-context exploration.

## Scope

Frontend only.

No changes to:

- saved-view persistence
- backend APIs
- route query schema
