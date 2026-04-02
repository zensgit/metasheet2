# PLM Audit Collaboration Followup Log Context Design

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Keep `set-default` collaboration followups visible only while the audit page is still showing the exact default-change log context they introduced.

## Problem

The earlier 2026-03-22 followup compatibility slice already stopped `set-default` followups from surviving a complete query pivot by checking:

- `action === 'set-default'`
- `resourceType === 'plm-team-view-default'`
- `q === followup.teamViewId`

That still left a narrower residue.

If the user stayed on the same team-view id but then changed the log context, for example by:

- moving to page 2
- filtering by `actorId`
- adding a `from` / `to` range

the followup could still remain visible even though the page was no longer showing the same default-change log snapshot that the notice described.

## Design

### 1. Reuse the explicit log-state contract from the builder

`apps/web/src/views/plmAuditTeamViewAudit.ts` already defines the default-change log route shape:

- `page = 1`
- `q = view.id`
- `actorId = ''`
- `kind = 'audit'`
- `action = 'set-default'`
- `resourceType = 'plm-team-view-default'`
- `from = ''`
- `to = ''`

The collaboration followup compatibility helper should align with that same contract instead of only checking a subset of the fields.

### 2. Tighten default followup compatibility

`apps/web/src/views/plmAuditTeamViewCollaboration.ts`
`shouldKeepPlmAuditTeamViewCollaborationFollowup(...)`

now keeps `set-default` followups only when the route still matches the default-change log context:

- `page === 1`
- `q === followup.teamViewId`
- `actorId === ''`
- `kind === 'audit'`
- `action === 'set-default'`
- `resourceType === 'plm-team-view-default'`
- `from === ''`
- `to === ''`

Share followups keep their existing rule and continue to depend only on the selected `teamViewId`.

## Files

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

## Expected Outcome

The default-promotion followup becomes route-accurate again:

- it stays visible on the initial default-change log view
- it disappears as soon as the user turns that log view into a different filtered or paginated context
