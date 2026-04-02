# PLM Audit Shared-Entry Owner Takeover Design

Date: 2026-03-23

## Goal

Make marker-only shared-entry takeovers replace any existing collaboration owner instead of only clearing same-view draft/followup state.

## Problem

`apps/web/src/views/PlmAuditView.vue` already supports marker-only transitions into `auditEntry=share` for the current team view.

Before this change, the shared-entry apply-view path only cleared collaboration draft/followup state when it matched the same `viewId`. That left a stale-owner gap:

- current canonical route stays on team view `A`
- another team view `B` owns an existing collaboration draft or followup
- browser/query transition adds `auditEntry=share` for `A` without changing `teamViewId`
- shared-entry notice for `A` appears, but collaboration owner `B` remains alive

Two owners could coexist because the route watcher never hit the `canonicalTeamViewChanged` cleanup path.

## Decision

Treat shared-entry takeover as a higher-priority owner that replaces any collaboration draft or followup.

Rules:

- if shared-entry takeover is installed, existing collaboration draft state is cleared
- if shared-entry takeover is installed, existing collaboration followup state is cleared
- this applies even when the previous collaboration owner belongs to another team view

## Implementation

Files:

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

Key changes:

- add `shouldReplacePlmAuditTeamViewCollaborationOwnershipWithSharedEntry(...)` as the pure takeover rule
- use that rule in `refreshAuditTeamViews()` when marker-only shared-entry takeover is applied
- extend the collaboration regression to cover draft-only, followup-only, and mixed ownership replacement

## Expected Outcome

- shared-entry notice no longer coexists with unrelated collaboration draft/followup state
- marker-only `auditEntry=share` transitions now have the same single-owner semantics as other takeover paths
