# PLM Audit State Closure Design

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`
Workspace: `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench`

## Goal

Close the remaining frontend state gaps across the `PLM Audit` collaboration flow so these paths behave as one stable experience instead of a stack of partially independent slices:

- recommended scene -> audit
- audit scene context -> local saved view
- local saved view -> team view / default team view
- share / set-default follow-up -> logs / source focus
- return to original workbench scene

## Context

The 2026-03-19 and 2026-03-20 slices established the individual capabilities:

- scene-aware audit route state
- saved-view context and scene reapply
- shared-link local save and team promotion
- team-view collaboration drafts and follow-ups
- return-to-scene route wiring

After those slices were combined in one page, the remaining failures were no longer missing features. They were residual state problems:

- stale saved-view attention surviving apply/reset/context pivots
- stale collaboration follow-ups surviving route changes
- deleted saved-view provenance lingering inside promotion state
- recommended-card focus surviving filter changes after the card disappeared

This closure pass keeps the existing contracts and removes those residual states.

## Scope

- Frontend only.
- No backend route changes.
- No OpenAPI changes.
- No localStorage key changes.
- No new route query keys.

## Design

### 1. Keep route state as the only durable audit state

`PlmAuditRouteState` remains the only durable source of truth for audit state.

Durable state includes:

- explicit audit filters
- `teamViewId`
- scene recovery metadata
- `returnToPlmPath`

Transient UI attention does not belong in route state:

- saved-view follow-up highlighting
- saved-view source focus
- recommendation-card focus
- collaboration follow-up notices

Those transient states must now either:

- be derived from the current route, or
- be cleared when the route moves outside their valid context.

### 2. Saved views stay snapshot-based and local attention stays transient

Saved views already became local snapshots rather than live team-view links. This closure keeps that rule and adds a second rule:

- saved-view attention is transient, not persistent

`plmAuditSavedViewAttention.ts` now reduces saved-view attention state for these pivots:

- `apply`
- scene/owner context quick actions
- `reset-filters`
- delete saved view

This keeps `auditSavedViewShareFollowup` and `focusedSavedViewId` aligned with the current local saved-view action instead of letting old highlights leak into unrelated routes.

### 3. Collaboration follow-ups are only valid while the route still matches them

`plmAuditTeamViewCollaboration.ts` now defines route-compatibility rules for collaboration follow-ups:

- `share` follow-ups only survive while the same team view remains selected
- `set-default` follow-ups only survive while the route still points at default-change audit logs

`PlmAuditView.vue` uses that contract when the route changes. If the route has pivoted to a saved view, reset state, or some other audit context, the old collaboration follow-up is cleared instead of continuing to claim that the logs below still match it.

This fixes the main stale-notice problem that remained after `set-default` and post-promotion flows.

### 4. Deleted saved views must not keep promotion provenance alive

Saved-view promotion draft/follow-up state can carry `sourceSavedViewId` so `focus-source` can return to the originating saved-view card.

That provenance is only valid while the saved view still exists.

When a saved view is deleted:

- saved-view local attention is reduced
- collaboration draft provenance is pruned
- collaboration follow-up provenance is pruned

The flow still keeps its `saved-view-promotion` semantics, but it no longer points at a deleted card id.

### 5. Recommendation focus is advisory and must be consumed when the card disappears

Recommendation focus is useful when returning from a follow-up or jumping from one part of the audit page to another.

It is not durable state.

`plmAuditTeamViewCatalog.ts` now exposes `consumeStaleRecommendedAuditTeamViewFocusId(...)` so the page can drop recommendation focus when:

- the recommendation filter changes
- the visible recommendation set changes
- paging/apply/reset pivots move the user away from the previously focused card

This keeps recommendation highlighting aligned with what is actually visible.

## Updated Files

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditSavedViewAttention.ts`
- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/src/views/plmAuditTeamViewCatalog.ts`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`
- `apps/web/tests/plmAuditTeamViewCatalog.spec.ts`

## Resulting Invariants

- Scene recovery metadata remains durable route state until scene context is explicitly cleared.
- Local saved views remain local snapshots and never behave like live team-view links.
- Saved-view attention does not survive apply/reset/context pivots.
- Collaboration follow-ups do not survive route pivots that invalidate their meaning.
- Deleted saved views do not leave behind stale promotion provenance ids.
- Recommendation focus only survives while the focused card is still visible.

## Non-Goals

- No new backend persistence for scene context.
- No UI redesign of the audit page.
- No Playwright or browser-automation coverage in this slice.
- No PR recut; this document only records the current closure pass.
