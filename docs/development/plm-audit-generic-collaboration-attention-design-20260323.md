# PLM Audit Generic Collaboration Attention Design

Date: 2026-03-23

## Goal

Make generic team-view actions clear inherited source attention when they take over from a source-aware collaboration flow.

## Problem

Recent slices already taught source-aware outcomes how to clean up transient attention:

- source-aware `share` clears management/source/local attention before installing its followup
- source-aware `set-default` clears source/local attention while preserving the active management target

One symmetry gap still remained for generic actions with no provenance:

1. a source-aware flow left recommendation or saved-view attention active
2. the user then triggered a generic team-view action from lifecycle controls
3. the old followup disappeared, but the inherited source highlight could remain because the generic action path did not apply any attention cleanup at all

That left the page showing a generic outcome while still visually pointing at an unrelated source card.

## Design

### 1. Resolve attention mode from collaboration provenance plus action kind

`apps/web/src/views/plmAuditTeamViewCollaboration.ts` now exposes `resolvePlmAuditTeamViewCollaborationAttentionMode(...)`.

Its rule is:

- source-aware `share` => `source-share-followup`
- everything else => `managed-team-view`

This keeps the distinction explicit and testable instead of scattering it in page conditionals.

### 2. Apply management cleanup for generic actions

`apps/web/src/views/PlmAuditView.vue` now uses that helper before applying collaboration outcomes:

- `source-share-followup` continues using the stricter source-share cleanup
- generic `share`
- generic `set-default`
- source-aware `set-default`

all route through the managed-team-view cleanup that preserves management focus while clearing inherited source/local attention.

## Files

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`
- `docs/development/plm-audit-generic-collaboration-attention-design-20260323.md`
- `docs/development/plm-audit-generic-collaboration-attention-verification-20260323.md`

## Expected Outcome

- generic team-view actions no longer leave stale recommendation or saved-view attention behind
- source-aware `share` keeps its stricter cleanup path
- the page has one explicit, helper-driven rule for mapping collaboration outcomes to attention cleanup
