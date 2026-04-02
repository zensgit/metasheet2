# PLM Audit Team-View Share-Entry Takeover Design

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Make shared-link entry notice takeover deterministic when `/plm/audit` is re-entered through a share link inside an already-mounted audit page.

## Problem

The earlier shared-link entry cleanup slice already clears entry notices when explicit filter navigation takes over.

One same-view takeover gap still remained:

1. the mounted audit page already held a collaboration draft or collaboration followup for team view `A`
2. the route then re-entered `/plm/audit` through a shared-link entry for the same team view `A`
3. the page raised the shared-link entry notice, but the older collaboration draft/followup for that same team view could still survive underneath it

That left the new entry notice competing with stale collaboration guidance for the same selected team view.

## Design

### 1. Treat shared-link entry as a same-view takeover

When `refreshAuditTeamViews()` resolves a requested shared-link entry for a concrete team view, that entry notice should become the only active transient team-view guidance for the same `teamViewId`.

### 2. Clear matching collaboration draft and followup before applying the entry notice

`apps/web/src/views/plmAuditTeamViewCollaboration.ts` should expose a small same-view followup cleanup helper alongside the existing draft cleanup helper.

`apps/web/src/views/PlmAuditView.vue` should then clear:

- the matching collaboration draft
- the matching collaboration followup

before setting `auditTeamViewShareEntry` for the resolved shared-link target.

### 3. Keep the cleanup scoped to same-view shared-entry takeover

This slice should not clear unrelated draft/followup state for other team views, and it should not move cleanup into the generic route watcher. The shared-link resolve path already knows when an explicit share-entry takeover is happening.

## Files

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

## Expected Outcome

- shared-link entry notice becomes the only transient team-view notice for the same selected team view
- same-view collaboration drafts no longer reappear after dismissing a new shared-link entry notice
- same-view collaboration followups no longer coexist with a new shared-link entry notice

## Non-Goals

- no backend or OpenAPI changes
- no route-key or storage-key changes
- no browser-level interaction harness changes
