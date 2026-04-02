# PLM Audit Source Focus Handoff Design

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Keep `focus-source` in `/plm/audit` source-accurate so returning from a team-view collaboration followup replaces the previous source highlight instead of stacking a stale recommendation or saved-view focus on top of the new anchor.

## Problem

The earlier attention-cleanup slices already covered:

- stale saved-view followups
- stale recommendation focus
- stale management focus
- stale collaboration followups

One gap still remained inside the `focus-source` followup action in `PlmAuditView.vue`:

- it cleared `focusedAuditTeamViewId`
- it restored recommendation or saved-view focus only when the followup explicitly carried one
- it did not first replace the old `source focus` state

That meant a valid `scene-context` or anchor-only followup could still leave an unrelated recommendation card highlighted, and a pruned saved-view provenance could still inherit an older source focus that no longer matched the active handoff.

## Design

### 1. Model source handoff as a full transient-attention replacement

`apps/web/src/views/plmAuditSavedViewAttention.ts` now exposes a shared helper that takes the current transient-attention state plus the next `source focus` target and returns the canonical next state:

- clear management focus
- clear old recommendation focus
- clear old saved-view focus
- apply only the new recommendation/saved-view source focus

This keeps the reset semantics explicit and testable.

### 2. Let `focus-source` consume the shared helper

`PlmAuditView.vue` no longer manually clears only `focusedAuditTeamViewId` and then conditionally mutates the remaining focus refs.

Instead, the `focus-source` branch:

- builds the source intent from `plmAuditTeamViewCollaboration.ts`
- applies the shared attention helper
- restores the recommendation filter only when the source intent explicitly requires it
- scrolls to the source anchor

This preserves the existing recommendation-filter contract while preventing stale visual focus from leaking across provenance pivots.

### 3. Keep anchor-only scene-context intent explicit

`plmAuditTeamViewCollaboration.ts` continues to produce anchor-only source focus for `scene-context` followups:

- `anchorId` points back to scene context or fallback controls
- `focusedRecommendationTeamViewId` stays `null`
- `focusedSavedViewId` stays `null`

The new attention helper makes that anchor-only case safe by clearing stale source focus instead of inheriting the previous one.

## Files

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditSavedViewAttention.ts`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

## Scope

Frontend-only slice:

- no backend changes
- no OpenAPI changes
- no route key or storage key changes

## Expected Outcome

- `focus-source` now restores exactly one source of visual attention
- scene-context followups no longer leave stale recommendation highlights behind
- pruned saved-view provenance no longer inherits old source focus
- recommendation provenance still restores the intended recommendation filter and card focus
