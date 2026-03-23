# PLM Audit Default Followup Selection Cleanup Design

## Background

`PLM Audit` uses `buildPlmAuditTeamViewCollaborationHandoff(...)` to bridge recommendation / scene / saved-view promotion flows into either:

- a collaboration draft
- or a `set-default` followup that sends the page to audit logs

The followup path no longer exposes direct team-view management controls. It is a log review state.

## Problem

The `set-default-followup` handoff still auto-filled:

- `selectedIds: [view.id]`

That means the page could show:

- `Selected 1 / ...`
- enabled batch lifecycle actions

even though the user was no longer in a management-selection flow, only in a default-change followup flow.

## Decision

Treat `set-default-followup` as a non-selection state.

- keep the focused team-view id for visual anchoring
- keep the followup metadata and log anchor
- do not carry batch selection into this state

## Implementation

Files:

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

Key change:

- `buildPlmAuditTeamViewCollaborationHandoff(...)` now returns `selectedIds: []` for `mode: 'set-default-followup'`

## Expected Behavior

- default-followup notices no longer leave a hidden batch selection behind
- the team-view card can still stay focused for context
- batch lifecycle actions do not light up just because a default-followup was created
