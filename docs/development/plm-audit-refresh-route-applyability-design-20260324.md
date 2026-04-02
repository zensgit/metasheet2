# PLM Audit Refresh Route Applyability Design

Date: 2026-03-24

## Problem

`refreshAuditTeamViews()` resolves canonical route ownership through `resolvePlmAuditRequestedTeamViewRouteState(...)`.

Before this round, that resolver only checked:

- requested/default team-view id existence
- `!isArchived`

It did not check `permissions.canApply`.

That left one route-level gap:

- a team view could survive refresh with the same id,
- lose apply permission,
- still get re-applied as the canonical route owner by the resolver.

This sat one layer earlier than the selector/actionability fix: even if local selector cleanup worked, refresh could still rehydrate the route from a non-applicable team view.

## Design

### 1. Reuse the existing `canApply` contract

`plmAuditTeamViewRouteState.ts` now imports and reuses `canApplyPlmAuditTeamView(...)` from [plmAuditTeamViewManagement.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewManagement.ts).

This aligns route resolution with the same applyability semantics already used by the UI.

### 2. Tighten both resolution branches

The resolver now applies `canApply` to:

- the explicit requested team-view branch
- the default team-view fallback branch

Result:

- explicit requested but non-applicable view => `clear-selection`
- default view exists but is non-applicable => `noop`

### 3. Preserve existing archival and scene-context rules

No new route semantics were added. This round only prevents refresh/default fallback from re-owning the canonical route with a view that the user can no longer apply.

## Files

- [plmAuditTeamViewRouteState.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewRouteState.ts)
- [plmAuditTeamViewManagement.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewManagement.ts)
- [plmAuditTeamViewRouteState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditTeamViewRouteState.spec.ts)

## Non-goals

- No changes to backend permissions.
- No broader rewrite of canonical ownership or selector cleanup.
- No change to archived-view behavior beyond existing `!isArchived` gate.
