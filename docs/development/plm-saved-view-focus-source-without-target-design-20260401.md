# PLM Saved-View Focus-Source Without Target Design

## Problem

`saved-view-promotion` collaboration follow-ups support `focus-source`, but
`resolvePlmAuditTeamViewCollaborationFollowupActionFeedback(...)` still required
the promoted audit team view target to exist.

That made the flow asymmetric:

1. User promotes a saved view into a team view.
2. User triggers a collaboration action such as `share`.
3. Follow-up offers `focus-source`.
4. If the promoted team view later disappears from the live list, `focus-source`
   is blocked even though the action only needs the saved-view provenance.

## Intended Contract

- `saved-view-promotion` + `focus-source` should remain actionable without a
  live team-view record.
- The action only depends on:
  - `sourceAnchorId`
  - `sourceSavedViewId`
- Existing stricter behavior remains for other sources where a live team-view
  target is still required.

## Change

- Special-case `focus-source` for `saved-view-promotion` inside
  `resolvePlmAuditTeamViewCollaborationFollowupActionFeedback(...)`.
- Return `null` feedback instead of a missing-target error so the existing
  focus-source execution path can restore the saved-view anchor/card.

## Scope

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

## Non-Goals

- No change to recommendation or scene-context focus-source validation.
- No change to follow-up notice rendering or collaboration runtime pruning.
