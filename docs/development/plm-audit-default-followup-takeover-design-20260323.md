# PLM Audit Default Followup Takeover Design

Date: 2026-03-23

## Goal

Make `set-default` followups replace older collaboration drafts just like `share` followups already do.

## Problem

`apps/web/src/views/PlmAuditView.vue` already clears an existing draft before installing a new `share` followup, but `setAuditTeamViewDefaultEntry(...)` still left older drafts intact.

That created one remaining stale-owner path:

- recommendation management draft on team view `A`
- recommendation `set-default` action on team view `B`
- new default-change followup for `B`
- old draft for `A` still visible because the page-level followup install never replaced it

This was the same ownership gap that previously existed for `share`, only on the default path.

## Decision

Treat every collaboration followup as a draft replacement event.

Rules:

- if `share` or `set-default` creates a followup, any existing collaboration draft is cleared first
- this applies whether the followup points at the same team view or a different team view
- route-driven cleanup stays unchanged; this only closes the page-local takeover gap

## Implementation

Files:

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

Key changes:

- reuse `shouldReplacePlmAuditTeamViewCollaborationDraftWithFollowup(...)` in `setAuditTeamViewDefaultEntry(...)`
- extend the pure collaboration regression to describe followup replacement generically instead of only `share`

## Expected Outcome

- recommendation draft `A` no longer coexists with default followup `B`
- same-view default followups no longer allow hidden drafts to reappear after dismissal
- collaboration owner takeover is now symmetric between `share` and `set-default`
