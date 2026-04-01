# PLM Collaboration Saved-View Normalizer Unification

## Problem

`plmAuditTeamViewCollaboration.ts` already carries saved-view promotion
provenance through `sourceSavedViewId`.

But the two core builders still inlined the same normalization rule:

- `buildPlmAuditTeamViewCollaborationDraft(...)`
- `buildPlmAuditTeamViewCollaborationFollowup(...)`

That created another drift point: recommendation provenance had already been
centralized, while saved-view provenance still depended on duplicated builder
logic.

## Design

Introduce `resolvePlmAuditTeamViewCollaborationSourceSavedViewId(...)` and make
both builders consume it.

Canonical rule:

- `source === 'saved-view-promotion'` + explicit id => preserve that id
- `source === 'saved-view-promotion'` + missing id => normalize to `null`
- any non-promotion source => normalize to `null`

## Scope

Only the collaboration helper and its focused spec change.

No route, attention, shared-entry, or promotion behavior changes.

## Files

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`
