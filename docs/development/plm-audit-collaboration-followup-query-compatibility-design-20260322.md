# PLM Audit Collaboration Followup Query Compatibility Design

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Stop `set-default` collaboration followups from surviving after the audit query no longer points at the team view whose default-change logs originally created the followup.

## Problem

The current followup cleanup already clears stale collaboration notices when:

- the selected `teamViewId` changes for share flows
- the route stops looking like a default-change audit log route

But one user-visible hole remained:

- after `Set as default`, the followup stays visible as long as `action === 'set-default'` and `resourceType === 'plm-team-view-default'`
- if the user then edits the audit query and applies a different `q`, the followup can still claim that the matching default-change logs are shown below even though the query has pivoted away from the original team view

This is a frontend-only state-contract bug. No backend or route-schema changes are required.

## Design

Tighten `shouldKeepPlmAuditTeamViewCollaborationFollowup()` in `apps/web/src/views/plmAuditTeamViewCollaboration.ts`.

For `share` followups, keep the existing rule:

- the same `teamViewId` must remain selected

For `set-default` followups, require all of the following:

- `action === 'set-default'`
- `resourceType === 'plm-team-view-default'`
- `q === followup.teamViewId`

This aligns the followup with the state produced by `buildPlmAuditTeamViewLogState()` in `apps/web/src/views/plmAuditTeamViewAudit.ts`, which anchors default-change logs by writing the target team-view id into `q`.

## Behavior

- default followups remain visible while the audit page is still anchored to the same team view's default-change log query
- default followups clear once the user changes the query to another team view or unrelated search term
- share followups keep their existing selection-based compatibility rule

## Scope

Frontend-only slice:

- no backend changes
- no new route keys
- no new persistence
- no OpenAPI changes
