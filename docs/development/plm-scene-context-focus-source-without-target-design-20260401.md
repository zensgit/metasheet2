# PLM Scene-Context Focus-Source Without Target Design

## Problem

`scene-context` collaboration follow-ups support `focus-source`, but
`resolvePlmAuditTeamViewCollaborationFollowupActionFeedback(...)` still treated
them as requiring a live team-view target.

That made the interaction inconsistent:

1. User saves a scene-context audit into team views.
2. User triggers a collaboration action such as `share`.
3. Follow-up offers `focus-source`.
4. If the promoted team view later disappears from the list, `focus-source`
   is blocked with a missing-target error.

For `scene-context`, `focus-source` only needs the source anchor
(`plm-audit-scene-context` or the controls fallback) and does not need the live
team-view record.

## Intended Contract

- `scene-context` + `focus-source` remains actionable without a live team-view
  record.
- Existing stricter missing-target behavior remains for actions that still
  depend on a live target.

## Change

- Special-case `focus-source` for `scene-context` inside
  `resolvePlmAuditTeamViewCollaborationFollowupActionFeedback(...)`.
- Return `null` feedback instead of a missing-target error.

## Scope

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

## Non-Goals

- No change to recommendation or saved-view provenance logic.
- No change to follow-up notice rendering or runtime pruning.
