# PLM Audit Saved View Context Locking Design

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`
Workspace: `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench`

## Goal

Prevent saved-view context quick actions from encouraging redundant pivots when the current audit page is already in the same `scene` or `owner` context.

## Problem

The previous slice added quick actions to saved-view context badges:

- `Restore scene query`
- `Filter by owner`

But those actions were always shown as available, even when the current audit route already matched the target context. That created avoidable duplicate clicks and weak feedback.

## Design

### 1. Extend saved-view quick actions with interlock state

`/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSavedViewSummary.ts`

Saved-view context badges now derive:

- `quickAction.disabled`
- `quickAction.hint`

The helper compares the current audit route context against the target context that would be produced by:

- `withPlmAuditSceneOwnerContext(savedView.state)`
- `withPlmAuditSceneQueryContext(savedView.state)`

Comparison intentionally focuses on:

- `q`
- `sceneId`
- `sceneName`
- `sceneOwnerUserId`

instead of full route equality, because page number and unrelated filters are not part of scene-context semantics.

### 2. Reflect interlock state in saved-view cards

`/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`

Saved-view quick-action buttons now:

- disable when the target context is already active
- show a muted hint explaining why the action is unnecessary
- no-op in the click handler when disabled

## Expected Outcome

- Users stop re-triggering the same `scene/owner` pivot accidentally.
- Saved-view cards explain when current audit context already matches the badge action.
- Quick actions remain useful, but only when they materially change the active audit context.

## Scope

Frontend only.

No changes to:

- saved-view persistence
- backend APIs
- route schema
