# PLM Audit Shared-Entry Source Action Takeover Design

## Context

`PLM Audit` already treats three flows as transient ownership handoffs:

- `shared-entry -> save local`
- `shared-entry -> recommendation management handoff`
- `shared-entry -> explicit dismiss`

One source-aware branch was still inconsistent: when the active canonical route was still the shared-entry team view, a user could trigger a source-aware collaboration action from the recommendation card on that same team view. The followup/draft would move into the recommendation flow, but the old shared-entry notice and `auditEntry=share` marker were left in place.

## Problem

Repro path:

1. Open `/plm/audit` from a shared team-view link so the canonical route carries `teamViewId=<id>&auditEntry=share`.
2. Keep that same team view selected.
3. Use the recommendation card for that same team view to trigger a source-aware collaboration action, especially `Copy share link`.

Observed behavior before this change:

- the new recommendation followup was created
- the old shared-entry banner still remained visible
- `auditEntry=share` stayed in the URL because the share action itself does not change the canonical route

That left two transient owners active at once for the same team view.

## Decision

Treat successful source-aware collaboration actions on the active shared-entry team view as a shared-entry takeover.

Rules:

- only source-aware actions qualify
- the takeover only applies when the target team view still matches the active shared-entry owner
- generic share/default actions keep their existing behavior

## Implementation

### Shared helper

Add `shouldTakeOverPlmAuditSharedEntryOnSourceAction(...)` in:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewShareEntry.ts`

It reuses the canonical ownership rule already used by local-save and management takeovers, and additionally requires the action to be source-aware.

### Share action

Update:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`

`shareAuditTeamViewEntry(...)` now:

- detects whether the action is a source-aware takeover on the active shared-entry team view
- clears local shared-entry notice ownership once the copy operation succeeds
- consumes `auditEntry=share` after installing the new recommendation/scoped followup

This keeps the share followup as the only remaining transient owner.

### Default action

Also update:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`

`setAuditTeamViewDefaultEntry(...)` now clears shared-entry ownership on the same successful source-aware takeover path. The route already pivots into the default-log state, but the local banner is no longer allowed to survive until watcher cleanup.

## Tests

Add takeover coverage in:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`

The new assertions lock three invariants:

- matching shared-entry + source-aware action => takeover
- mismatched team view => no takeover
- generic action without source provenance => no takeover

## Non-goals

- no new route keys
- no OpenAPI or backend changes
- no component-test harness expansion
