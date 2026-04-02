# PLM Workbench Audit Scene Takeover Form Draft Design

## Background

`audit scene context takeover` already cleared transient source-owned UI state:

- saved-view attention
- shared-entry ownership
- collaboration draft/followup ownership

But it still left `audit team view` form drafts untouched. That meant a scene-driven route could keep showing rename or transfer-owner drafts that still belonged to the previously managed team view.

This was out of parity with other authoritative takeover paths, which already run team-view form drafts through takeover cleanup.

## Design

Align `scene context takeover` with the existing takeover draft contract:

1. Add `formDraft` to `buildPlmAuditSceneContextTakeoverState(...)`.
2. Run it through `resolvePlmAuditTakeoverTeamViewFormDraftState(...)`.
3. Apply the normalized form draft back into `PlmAuditView.vue`.

Behavior stays consistent with the existing helper:

- managed team-view drafts are cleared
- create-mode drafts without a bound owner stay intact

## Files

- `apps/web/src/views/plmAuditSceneContextTakeover.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditSceneContextTakeover.spec.ts`
